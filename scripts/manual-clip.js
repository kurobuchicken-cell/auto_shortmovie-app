'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../src/config');
const { cutClip, pad } = require('../src/clip');
const { toVertical } = require('../src/vertical');
const { burnSubtitles } = require('../src/burn');
const { summarizeClipReason } = require('../src/claude-detect');
const { writeManifest } = require('../src/manifest');
const { parseManualBlocks } = require('../src/manual-clip');

const ROOT = path.join(__dirname, '..');
const WORK_DIR = path.join(ROOT, 'work');
const CANDIDATES_DIR = path.join(ROOT, 'candidates');
const MANIFEST_PATH = path.join(CANDIDATES_DIR, 'manifest.json');

function loadExistingManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function processManualClip(block, index, config) {
  let c = { index, startSec: block.startSec, endSec: block.endSec, durationSec: block.durationSec };
  c = await cutClip(config.inputPath, c, WORK_DIR);
  c = await toVertical(c, config, WORK_DIR);

  const srtPath = path.join(WORK_DIR, `sub_${pad(index)}.srt`);
  fs.writeFileSync(srtPath, block.srtContent);
  c = { ...c, srtPath, subtitleText: block.subtitleText };

  const reason = await summarizeClipReason(c.subtitleText, config);
  if (reason) c = { ...c, reason };

  c = await burnSubtitles(c, config, CANDIDATES_DIR);
  return c;
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    throw new Error('使い方: node scripts/manual-clip.js <貼り付けたSRTテキストのファイルパス>');
  }

  const config = loadConfig();
  const rawText = fs.readFileSync(inputFile, 'utf8');
  const blocks = parseManualBlocks(rawText);
  if (blocks.length === 0) {
    throw new Error('クリップとして解釈できるブロックが見つかりませんでした。');
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  const existing = loadExistingManifest();
  const existingCandidates = existing?.candidates || [];
  const nextIndex = existingCandidates.reduce((max, c) => Math.max(max, c.index), 0) + 1;

  console.log(`手動指定クリップ ${blocks.length} 件を処理します（index ${nextIndex} から）...`);

  const newCandidates = [];
  for (let i = 0; i < blocks.length; i++) {
    const index = nextIndex + i;
    const b = blocks[i];
    console.log(`  [${i + 1}/${blocks.length}] index ${index}: ${b.startSec.toFixed(1)}s - ${b.endSec.toFixed(1)}s`);
    const c = await processManualClip(b, index, config);
    newCandidates.push(c);
  }

  const merged = [...existingCandidates, ...newCandidates];
  writeManifest(merged, config, MANIFEST_PATH);

  console.log(`完了: ${newCandidates.length} 件を追加しました（candidates 合計 ${merged.length} 件）。`);
}

main().catch((err) => {
  console.error('\nエラーが発生しました:');
  console.error(err.message);
  process.exitCode = 1;
});
