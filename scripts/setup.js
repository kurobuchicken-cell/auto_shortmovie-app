'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      resolve({ ok: !err, err, stdout, stderr });
    });
  });
}

function ensureDirs() {
  for (const dir of ['input', 'work', 'candidates']) {
    const full = path.join(ROOT, dir);
    fs.mkdirSync(full, { recursive: true });
    const keep = path.join(full, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }
  console.log('[setup] ディレクトリ確認OK (input/work/candidates)');
}

async function ensureFfmpeg() {
  let res = await run('ffmpeg', ['-version']);
  if (res.ok) {
    console.log('[setup] ffmpeg OK (既にインストール済み)');
    return true;
  }
  console.log('[setup] ffmpeg が見つかりません。winget でインストールを試みます...');
  res = await run('winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements']);
  if (!res.ok) {
    console.error('[setup] winget でのインストールに失敗しました。手動でインストールしてください:');
    console.error('        https://www.gyan.dev/ffmpeg/builds/ (もしくは winget install ffmpeg)');
    return false;
  }
  res = await run('ffmpeg', ['-version']);
  if (!res.ok) {
    console.warn('[setup] ffmpeg をインストールしましたが、現在のシェルではまだ認識されません。');
    console.warn('        新しいターミナルを開いて再度 "npm run setup" を実行してください。');
    return false;
  }
  console.log('[setup] ffmpeg インストールOK');
  return true;
}

async function ensurePython() {
  const res = await run('python', ['--version']);
  if (!res.ok) {
    console.error('[setup] python が見つかりません。Python をインストールしてPATHに追加してください。');
    return false;
  }
  console.log(`[setup] python OK (${(res.stdout || res.stderr).trim()})`);
  return true;
}

async function ensureFasterWhisper() {
  const reqPath = path.join(ROOT, 'python', 'requirements.txt');
  console.log('[setup] pip install -r python/requirements.txt を実行します...');
  const res = await run('pip', ['install', '-r', reqPath]);
  if (!res.ok) {
    console.error('[setup] faster-whisper のインストールに失敗しました。');
    console.error(res.stderr || res.err.message);
    return false;
  }
  console.log('[setup] faster-whisper インストールOK');
  return true;
}

function checkFont() {
  const fontsDir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const candidates = ['YuGothR.ttc', 'YuGothM.ttc', 'meiryo.ttc', 'msgothic.ttc', 'NotoSansJP-VF.ttf'];
  const found = candidates.find((f) => fs.existsSync(path.join(fontsDir, f)));
  if (found) {
    console.log(`[setup] 日本語フォント OK (${found})`);
    return true;
  }
  console.warn('[setup] 日本語フォントが見つかりませんでした。Noto Sans JP のインストールを推奨します。');
  console.warn('        config.json の fontName を、お使いの環境にあるフォント名に変更してください。');
  return false;
}

async function main() {
  console.log('=== auto_shortmovie-app セットアップ ===');
  ensureDirs();
  const results = {
    ffmpeg: await ensureFfmpeg(),
    python: await ensurePython(),
  };
  results.fasterWhisper = results.python ? await ensureFasterWhisper() : false;
  results.font = checkFont();

  console.log('\n=== セットアップ結果 ===');
  for (const [name, ok] of Object.entries(results)) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}`);
  }

  const allOk = Object.values(results).every(Boolean);
  if (allOk) {
    console.log('\n準備完了です。input/input.mp4 を置いて "npm run clips" を実行してください。');
  } else {
    console.log('\n一部のチェックに失敗しました。上記のメッセージを確認し、解決後に再度 "npm run setup" を実行してください。');
    process.exitCode = 1;
  }
}

main();
