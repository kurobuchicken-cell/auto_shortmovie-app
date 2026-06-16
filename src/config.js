'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const FLAG_MAP = {
  '--input': 'inputPath',
  '--n': 'candidateCount',
  '--min': 'clipMinSec',
  '--max': 'clipMaxSec',
  '--model': 'whisperModel',
  '--width': 'outputWidth',
  '--height': 'outputHeight',
  '--timeout': 'whisperTimeoutSec',
  '--mode': 'detectionMode',
};

const VALID_MODES = new Set(['loudness', 'claude']);

const NUMERIC_KEYS = new Set(['candidateCount', 'clipMinSec', 'clipMaxSec', 'leadInSec', 'outputWidth', 'outputHeight', 'fontSize', 'whisperTimeoutSec']);

function parseArgvOverrides(argv) {
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAG_MAP[argv[i]];
    if (!key) continue;
    const value = argv[i + 1];
    overrides[key] = NUMERIC_KEYS.has(key) ? Number(value) : value;
    i++;
  }
  return overrides;
}

function loadConfig(argv = []) {
  const defaults = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const overrides = parseArgvOverrides(argv);
  const config = { ...defaults, ...overrides };
  if (!VALID_MODES.has(config.detectionMode)) {
    throw new Error(
      `不明な --mode です: "${config.detectionMode}" (loudness または claude を指定してください)\n` +
      `(Unknown --mode: "${config.detectionMode}". Use "loudness" or "claude".)`
    );
  }
  return config;
}

module.exports = { loadConfig, parseArgvOverrides };
