'use strict';

const fs = require('fs');
const path = require('path');
const { runFfmpeg, escapeForFilter } = require('./ffmpeg-utils');
const { pad } = require('./clip');

function toRelative(p) {
  return path.relative(process.cwd(), p).split(path.sep).join('/');
}

function hasSubtitleContent(srtPath) {
  try {
    return fs.statSync(srtPath).size > 0;
  } catch {
    return false;
  }
}

async function burnSubtitles(candidate, config, candidatesDir) {
  const nn = pad(candidate.index);
  const filename = `clip_${nn}.mp4`;
  const clipPath = path.join(candidatesDir, filename);

  if (!hasSubtitleContent(candidate.srtPath)) {
    // No speech detected in this clip (e.g. SFX-only audio) - faster-whisper
    // can legitimately return zero segments. Burning an empty .srt makes
    // libass fail to even open the file, so fall back to a plain copy
    // instead of crashing this candidate.
    fs.copyFileSync(candidate.vertPath, clipPath);
    return { ...candidate, clipPath, filename };
  }

  // Use paths relative to cwd to dodge the Windows drive-letter-colon
  // escaping pitfall inside the subtitles= filter argument.
  const srtRel = escapeForFilter(toRelative(candidate.srtPath));
  const style = `FontName=${config.fontName},Fontsize=${config.fontSize},Outline=2,Alignment=2`;

  await runFfmpeg([
    '-y',
    '-i', candidate.vertPath,
    '-vf', `subtitles=${srtRel}:force_style='${style}'`,
    clipPath,
  ]);

  return { ...candidate, clipPath, filename };
}

module.exports = { burnSubtitles };
