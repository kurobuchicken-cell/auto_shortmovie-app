'use strict';

const path = require('path');
const { runPython } = require('./python-utils');
const { pad } = require('./clip');

const SCRIPT_PATH = path.join(__dirname, '..', 'python', 'transcribe.py');

async function transcribeClip(candidate, config, workDir, initialPrompt) {
  const nn = pad(candidate.index);
  const srtPath = path.join(workDir, `sub_${nn}.srt`);
  const timeoutMs = (config.whisperTimeoutSec || 60) * 1000;
  const args = [SCRIPT_PATH, candidate.vertPath, config.whisperModel, srtPath, 'segment'];
  if (initialPrompt) args.push('--initial-prompt', initialPrompt);
  const { stdout, stderr } = await runPython(args, timeoutMs, `candidate #${candidate.index}`);

  const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
  let result;
  try {
    result = JSON.parse(lastLine);
  } catch (e) {
    throw new Error(`文字起こし結果の解析に失敗しました (candidate #${candidate.index}):\n${stderr}\n${stdout}`);
  }
  if (!result.ok) {
    throw new Error(`文字起こしに失敗しました (candidate #${candidate.index}): ${result.error}`);
  }
  return { ...candidate, srtPath: result.srtPath, subtitleText: result.text };
}

module.exports = { transcribeClip };
