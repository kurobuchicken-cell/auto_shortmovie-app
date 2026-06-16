'use strict';

const path = require('path');
const { runFfmpeg } = require('./ffmpeg-utils');
const { pad } = require('./clip');

async function toVertical(candidate, config, workDir) {
  const { outputWidth: w, outputHeight: h } = config;
  const nn = pad(candidate.index);
  const vertPath = path.join(workDir, `vert_${nn}.mp4`);
  const filter =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=20:5[bg]; ` +
    `[0:v]scale=${w}:-1[fg]; ` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  await runFfmpeg([
    '-y',
    '-i', candidate.cutPath,
    '-filter_complex', filter,
    '-c:a', 'copy',
    vertPath,
  ]);
  return { ...candidate, vertPath };
}

module.exports = { toVertical };
