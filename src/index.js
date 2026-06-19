'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./config');
const { runAllChecks } = require('./deps-check');
const { extractAudio } = require('./audio');
const { detectCandidates } = require('./loudness');
const { detectCandidatesViaClaude, summarizeClipReason, buildInitialPromptText } = require('./claude-detect');
const { cutClip } = require('./clip');
const { toVertical } = require('./vertical');
const { transcribeClip } = require('./subtitles');
const { burnSubtitles } = require('./burn');
const { writeManifest } = require('./manifest');

const ROOT = path.join(__dirname, '..');
const WORK_DIR = path.join(ROOT, 'work');
const CANDIDATES_DIR = path.join(ROOT, 'candidates');
const CONCURRENCY = 2;

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    try {
      results[i] = { ok: true, value: await worker(items[i], i) };
    } catch (err) {
      results[i] = { ok: false, error: err, item: items[i] };
    }
    return runNext();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(runners);
  return results;
}

async function processCandidate(candidate, config, fullSegments) {
  let c = candidate;
  c = await cutClip(config.inputPath, c, WORK_DIR);
  c = await toVertical(c, config, WORK_DIR);
  // Priming faster-whisper with the real dialogue immediately preceding this
  // clip cuts down on hallucination - re-transcribing a clip in isolation
  // (no prior context) makes it more prone to inventing fluent-sounding text
  // to fill silent/ambiguous stretches.
  const initialPrompt = fullSegments ? buildInitialPromptText(fullSegments, c.startSec) : null;
  c = await transcribeClip(c, config, WORK_DIR, initialPrompt);
  if (config.detectionMode === 'claude') {
    // The upfront window-selection reason can describe dialogue just outside
    // the chosen start/end (Claude conflates nearby moments). Regenerate it
    // from the clip's actual transcribed text now that we have it.
    const reason = await summarizeClipReason(c.subtitleText, config);
    if (reason) c = { ...c, reason };
  }
  c = await burnSubtitles(c, config, CANDIDATES_DIR);
  return c;
}

async function main() {
  const argv = process.argv.slice(2);
  const config = loadConfig(argv);

  console.log('=== auto_shortmovie-app: clips ===');
  console.log(`入力: ${config.inputPath}`);
  console.log(`検出モード: ${config.detectionMode}`);

  await runAllChecks(config);

  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  console.log('[1/4] 音声抽出中... (extracting audio)');
  const audioWavPath = await extractAudio(config.inputPath, WORK_DIR);

  let rawCandidates;
  let fullSegments = null;
  if (config.detectionMode === 'claude') {
    console.log('[2/4] 全体文字起こし＋Claude APIでハイライト検出中... (full transcript + Claude API highlight detection)');
    const detected = await detectCandidatesViaClaude(audioWavPath, WORK_DIR, config);
    rawCandidates = detected.candidates;
    fullSegments = detected.segments;
  } else {
    console.log('[2/4] 音声ピーク検出中... (detecting loudness peaks)');
    rawCandidates = await detectCandidates(audioWavPath, WORK_DIR, config);
  }
  console.log(`  候補 ${rawCandidates.length} 件を検出しました。`);

  console.log('[3/4] クリップ生成中 (切り出し・縦化・字幕)... (cutting, verticalizing, transcribing, burning)');
  const results = await runPool(rawCandidates, CONCURRENCY, (c) => processCandidate(c, config, fullSegments));

  const succeeded = results.filter((r) => r.ok).map((r) => r.value);
  const failed = results.filter((r) => !r.ok);

  for (const f of failed) {
    console.error(`  [失敗] candidate #${f.item.index}: ${f.error.message}`);
  }

  if (succeeded.length === 0) {
    throw new Error('すべての候補の処理に失敗しました。上記のエラーを確認してください。');
  }

  console.log('[4/4] manifest.json を書き出し中...');
  const manifestPath = path.join(CANDIDATES_DIR, 'manifest.json');
  writeManifest(succeeded, config, manifestPath);

  console.log(`\n完了: ${succeeded.length}/${rawCandidates.length} 件の候補を /candidates に出力しました。`);
  console.log('manifest.json を確認し、投稿する1本を選んでください。');
  console.log(`(Done: ${succeeded.length}/${rawCandidates.length} candidates written to /candidates. Review manifest.json and pick one.)`);
}

main().catch((err) => {
  console.error('\nエラーが発生しました (a fatal error occurred):');
  console.error(err.message);
  process.exitCode = 1;
});
