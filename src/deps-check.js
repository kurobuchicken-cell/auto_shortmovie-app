'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

function checkFfmpeg() {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-version'], (err) => {
      if (err) {
        return reject(new Error(
          'ffmpeg が見つかりません。"npm run setup" を実行してください。\n' +
          '(ffmpeg not found. Run "npm run setup" first.)'
        ));
      }
      resolve();
    });
  });
}

function checkPythonAndFasterWhisper() {
  return new Promise((resolve, reject) => {
    execFile('python', ['-c', 'import faster_whisper'], (err) => {
      if (err) {
        return reject(new Error(
          'Python の faster-whisper が見つかりません。"npm run setup" を実行してください。\n' +
          '(faster-whisper not importable from Python. Run "npm run setup" first.)'
        ));
      }
      resolve();
    });
  });
}

function checkInputFile(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `入力ファイルが見つかりません: ${inputPath}\n` +
      `(Input file not found: ${inputPath}. Place your video there or pass --input <path>.)`
    );
  }
}

function checkClaudeApiKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY が環境変数に設定されていません（--mode claude を使うには必要です）。\n' +
      '"--mode loudness" にすればAPIキー無しでも動作します。\n' +
      '(ANTHROPIC_API_KEY env var is not set, required for --mode claude. Use --mode loudness to run without it.)'
    );
  }
}

async function runAllChecks(config) {
  checkInputFile(config.inputPath);
  await checkFfmpeg();
  await checkPythonAndFasterWhisper();
  if (config.detectionMode === 'claude') {
    checkClaudeApiKey();
  }
}

module.exports = {
  checkFfmpeg,
  checkPythonAndFasterWhisper,
  checkInputFile,
  checkClaudeApiKey,
  runAllChecks,
};
