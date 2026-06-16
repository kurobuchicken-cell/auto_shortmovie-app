'use strict';

const { spawn } = require('child_process');

// Runs a python script via spawn (not execFile) so stderr can be streamed to
// the terminal in real time - model-download progress (huggingface_hub's
// tqdm bar) and our own [transcribe] logs would otherwise only appear after
// the whole process exits, making it look hung.
function runPython(args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(d);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Pythonの起動に失敗しました (${label}):\n${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(
          `処理がタイムアウトしました (${label}, ${timeoutMs / 1000}秒超過)。\n` +
          `(Timed out after ${timeoutMs / 1000}s: ${label}.)`
        ));
      }
      resolve({ stdout, stderr, code });
    });
  });
}

module.exports = { runPython };
