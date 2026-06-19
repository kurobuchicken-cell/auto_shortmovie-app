'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../src/config');
const { pad } = require('../src/clip');
const { burnSubtitles } = require('../src/burn');
const { runPython } = require('../src/python-utils');
const { parseSrtEntries, secToSrtTime } = require('../src/manual-clip');
const { parseTimingFile } = require('../src/karaoke-timing');

const ROOT = path.join(__dirname, '..');
const WORK_DIR = path.join(ROOT, 'work');
const CANDIDATES_DIR = path.join(ROOT, 'candidates');
const TRANSCRIBE_SCRIPT = path.join(ROOT, 'python', 'transcribe.py');

const RANGE_RE = /^\d+(\.\d+)?-\d+(\.\d+)?$/;

const USAGE =
  '使い方:\n' +
  '  範囲指定（自動で文字数に応じて均等割り）:\n' +
  '    node scripts/karaoke-mark.js <candidate番号> <開始秒-終了秒> [<開始秒-終了秒> ...]\n' +
  '    例: node scripts/karaoke-mark.js 3 12.5-14.0 20.0-21.2\n' +
  '  タイミングファイル指定（文字ごとに出現時刻を厳密指定、0.1秒単位推奨）:\n' +
  '    node scripts/karaoke-mark.js <candidate番号> <タイミングファイルパス>\n' +
  '    ファイル例:\n' +
  '      12.3 あ\n      12.5 い\n      12.8 う\n      13.0 え\n      13.4 お\n      13.8\n' +
  '    （最後の行は時刻のみ＝表示終了タイミング。複数区間は === で区切る）\n' +
  '  秒は対象クリップ内のローカル時間（sub_NN.srt / clip_NN.mp4の表示時刻）。';

// Replaces whatever existing subtitle entries fall inside [startSec, endSec)
// with the given replacement entries, leaving everything outside untouched.
function spliceEntries(existingEntries, startSec, endSec, replacementEntries) {
  const kept = existingEntries.filter((e) => !(e.startSec < endSec && startSec < e.endSec));
  return [...kept, ...replacementEntries].sort((a, b) => a.startSec - b.startSec);
}

function writeSrt(entries, srtPath) {
  const content = entries
    .map((e, i) => `${i + 1}\n${secToSrtTime(e.startSec)} --> ${secToSrtTime(e.endSec)}\n${e.text}\n`)
    .join('\n');
  fs.writeFileSync(srtPath, content);
}

async function runTimingFileMode(index, timingFilePath, srtPath, vertPath, config) {
  if (!fs.existsSync(timingFilePath)) {
    throw new Error(`タイミングファイルが見つかりません: ${timingFilePath}`);
  }
  const existingSrt = fs.existsSync(srtPath) ? fs.readFileSync(srtPath, 'utf8') : '';
  const existingEntries = existingSrt.trim() ? parseSrtEntries(existingSrt) : [];

  const blocks = parseTimingFile(fs.readFileSync(timingFilePath, 'utf8'));
  if (blocks.length === 0) {
    throw new Error('タイミングファイルからブロックを読み取れませんでした。');
  }

  let entries = existingEntries;
  for (const block of blocks) {
    entries = spliceEntries(entries, block.startSec, block.endSec, block.entries);
  }

  writeSrt(entries, srtPath);
  console.log(`candidate #${index}: タイミングファイル指定で ${blocks.length} 区間をカラオケ表示に置き換えました。`);
}

async function runRangeMode(index, rangeArgs, srtPath, vertPath, config) {
  console.log(`candidate #${index} のうち ${rangeArgs.join(', ')} をカラオケ表示にして再生成します...`);

  const timeoutMs = (config.whisperTimeoutSec || 60) * 1000;
  const { stdout, stderr } = await runPython(
    [TRANSCRIBE_SCRIPT, vertPath, config.whisperModel, srtPath, 'mixed', ...rangeArgs],
    timeoutMs,
    `candidate #${index}`
  );

  const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
  let result;
  try {
    result = JSON.parse(lastLine);
  } catch (e) {
    throw new Error(`文字起こし結果の解析に失敗しました (candidate #${index}):\n${stderr}\n${stdout}`);
  }
  if (!result.ok) {
    throw new Error(`文字起こしに失敗しました (candidate #${index}): ${result.error}`);
  }
}

async function main() {
  const [indexArg, ...rest] = process.argv.slice(2);
  const index = Number(indexArg);
  if (!index || rest.length === 0) {
    throw new Error(USAGE);
  }

  const config = loadConfig();
  const nn = pad(index);
  const vertPath = path.join(WORK_DIR, `vert_${nn}.mp4`);
  const srtPath = path.join(WORK_DIR, `sub_${nn}.srt`);

  if (!fs.existsSync(vertPath)) {
    throw new Error(`${vertPath} が見つかりません。先に npm run clips（または manual-clip）で候補 #${index} を生成してください。`);
  }

  const isRangeMode = rest.every((r) => RANGE_RE.test(r));
  if (isRangeMode) {
    await runRangeMode(index, rest, srtPath, vertPath, config);
  } else if (rest.length === 1) {
    await runTimingFileMode(index, rest[0], srtPath, vertPath, config);
  } else {
    throw new Error(USAGE);
  }

  const candidate = await burnSubtitles({ index, vertPath, srtPath }, config, CANDIDATES_DIR);
  console.log(`完了: ${candidate.clipPath} を更新しました。`);
}

main().catch((err) => {
  console.error('\nエラーが発生しました:');
  console.error(err.message);
  process.exitCode = 1;
});
