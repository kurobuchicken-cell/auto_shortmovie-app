'use strict';

const path = require('path');
const { runFfmpeg } = require('./ffmpeg-utils');

async function extractAudio(inputPath, workDir) {
  const outPath = path.join(workDir, 'audio.wav');
  await runFfmpeg(['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-vn', outPath]);
  return outPath;
}

module.exports = { extractAudio };
