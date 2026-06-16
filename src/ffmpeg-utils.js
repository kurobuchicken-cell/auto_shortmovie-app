'use strict';

const { execFile } = require('child_process');

const TAIL_CHARS = 2000;

function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 64, ...opts }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          const e = new Error(
            'ffmpeg が見つかりません。"npm run setup" を実行してインストールしてください。\n' +
            '(ffmpeg not found on PATH. Run "npm run setup" to install it.)'
          );
          e.cause = err;
          return reject(e);
        }
        const tail = (stderr || '').slice(-TAIL_CHARS);
        const e = new Error(
          `ffmpeg がエラーで終了しました (exit ${err.code}).\n--- stderr (tail) ---\n${tail}`
        );
        e.cause = err;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Normalizes a Windows path for safe use inside ffmpeg -vf/-filter_complex
// strings, where backslashes and the drive-letter colon are special chars
// to libass/ffmpeg's mini expression parser.
function escapeForFilter(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

module.exports = { runFfmpeg, escapeForFilter };
