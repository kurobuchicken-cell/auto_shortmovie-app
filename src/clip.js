'use strict';

const path = require('path');
const { runFfmpeg } = require('./ffmpeg-utils');

function pad(n) {
  return String(n).padStart(2, '0');
}

async function cutClip(inputPath, candidate, workDir) {
  const nn = pad(candidate.index);
  const cutPath = path.join(workDir, `cut_${nn}.mp4`);
  await runFfmpeg([
    '-y',
    '-ss', String(candidate.startSec),
    '-i', inputPath,
    '-t', String(candidate.durationSec),
    '-c:v', 'libx264',
    '-c:a', 'aac',
    cutPath,
  ]);
  return { ...candidate, cutPath };
}

module.exports = { cutClip, pad };
