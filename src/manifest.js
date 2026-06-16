'use strict';

const fs = require('fs');

function writeManifest(candidates, config, manifestPath) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceFile: config.inputPath,
    config: {
      detectionMode: config.detectionMode,
      candidateCount: config.candidateCount,
      clipMinSec: config.clipMinSec,
      clipMaxSec: config.clipMaxSec,
      whisperModel: config.whisperModel,
      outputWidth: config.outputWidth,
      outputHeight: config.outputHeight,
    },
    candidates: candidates.map((c) => ({
      filename: c.filename,
      index: c.index,
      startSec: c.startSec,
      endSec: c.endSec,
      durationSec: c.durationSec,
      // loudnessScore is set in --mode loudness; reason is set in --mode claude.
      loudnessScore: c.loudnessScore ?? null,
      reason: c.reason ?? null,
      subtitleText: c.subtitleText || '',
    })),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = { writeManifest };
