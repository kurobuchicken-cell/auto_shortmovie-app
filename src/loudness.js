'use strict';

const fs = require('fs');
const path = require('path');
const { runFfmpeg } = require('./ffmpeg-utils');

const LINE_RE = /t:\s*(-?[\d.]+).*?M:\s*(-?[\d.]+|-inf)/g;

async function measureLoudness(audioWavPath, workDir) {
  const logPath = path.join(workDir, 'loudness.log');
  // framelog defaults to "verbose" when there is no video output, which is
  // below ffmpeg's default "info" loglevel and prints no per-second lines.
  // Force it to "info" so the t:/M: lines we parse below actually appear.
  const { stderr } = await runFfmpeg(['-i', audioWavPath, '-af', 'ebur128=metadata=1:framelog=info', '-f', 'null', '-']);
  fs.writeFileSync(logPath, stderr || '');
  return logPath;
}

function parseLoudnessLog(logPath) {
  const content = fs.readFileSync(logPath, 'utf8');
  const bySecond = new Map(); // integer second -> last M value seen that second
  let match;
  while ((match = LINE_RE.exec(content)) !== null) {
    const t = parseFloat(match[1]);
    const mRaw = match[2];
    if (mRaw === '-inf') continue;
    const m = parseFloat(mRaw);
    if (Number.isNaN(t) || Number.isNaN(m)) continue;
    bySecond.set(Math.floor(t), m);
  }
  const maxT = bySecond.size ? Math.max(...bySecond.keys()) : 0;
  const series = [];
  for (let t = 0; t <= maxT; t++) {
    series.push({ t, m: bySecond.has(t) ? bySecond.get(t) : null });
  }
  // Fill gaps (seconds with no metadata) by carrying the previous value forward.
  let last = -70;
  for (const point of series) {
    if (point.m === null) point.m = last;
    else last = point.m;
  }
  return series;
}

function smooth(series, windowSize = 3) {
  const half = Math.floor(windowSize / 2);
  return series.map((point, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(series.length - 1, i + half);
    let sum = 0;
    let count = 0;
    for (let j = start; j <= end; j++) {
      sum += series[j].m;
      count++;
    }
    return { t: point.t, m: sum / count };
  });
}

function findPeaks(smoothed) {
  const values = smoothed.map((p) => p.m);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  const threshold = mean + stddev;

  const peaks = [];
  for (let i = 1; i < smoothed.length - 1; i++) {
    const cur = smoothed[i];
    if (cur.m < threshold) continue;
    if (cur.m >= smoothed[i - 1].m && cur.m >= smoothed[i + 1].m) {
      peaks.push({ t: cur.t, score: cur.m });
    }
  }
  return peaks;
}

function mergeNearbyPeaks(peaks, mergeGapSec = 5) {
  if (peaks.length === 0) return [];
  const sorted = [...peaks].sort((a, b) => a.t - b.t);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.t - last.t <= mergeGapSec) {
      if (cur.score > last.score) merged[merged.length - 1] = cur;
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function expandToWindows(peaks, config, audioDurationSec) {
  const { leadInSec, clipMinSec, clipMaxSec } = config;
  return peaks.map((peak) => {
    let start = peak.t - leadInSec;
    let end = peak.t + (clipMaxSec - leadInSec);
    start = Math.max(0, start);
    end = Math.min(audioDurationSec, end);
    if (end - start < clipMinSec) {
      end = Math.min(audioDurationSec, start + clipMinSec);
    }
    return { startSec: start, endSec: end, loudnessScore: peak.score };
  });
}

function mergeOverlappingWindows(windows) {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.startSec - b.startSec);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, cur.endSec);
      last.loudnessScore = Math.max(last.loudnessScore, cur.loudnessScore);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

// Merging overlapping windows (per spec) can produce a window longer than
// clipMaxSec when peaks are close together (e.g. sustained loud talking).
// Clamp back down so every final candidate still respects the configured
// short-form length bounds.
function clampWindowLength(windows, clipMaxSec) {
  return windows.map((w) => {
    if (w.endSec - w.startSec <= clipMaxSec) return w;
    return { ...w, endSec: w.startSec + clipMaxSec };
  });
}

function selectTopN(windows, n) {
  const top = [...windows].sort((a, b) => b.loudnessScore - a.loudnessScore).slice(0, n);
  top.sort((a, b) => a.startSec - b.startSec);
  return top.map((w, i) => ({
    index: i + 1,
    startSec: w.startSec,
    endSec: w.endSec,
    durationSec: w.endSec - w.startSec,
    loudnessScore: w.loudnessScore,
  }));
}

async function detectCandidates(audioWavPath, workDir, config) {
  const logPath = await measureLoudness(audioWavPath, workDir);
  const series = parseLoudnessLog(logPath);
  if (series.length === 0) {
    throw new Error('音声ピーク検出に失敗しました: ラウドネスデータが取得できませんでした。\n(No loudness data parsed from ffmpeg ebur128 output.)');
  }
  const audioDurationSec = series[series.length - 1].t;
  const smoothed = smooth(series, 3);
  const peaks = findPeaks(smoothed);
  const mergedPeaks = mergeNearbyPeaks(peaks, 5);
  const windows = expandToWindows(mergedPeaks, config, audioDurationSec);
  const mergedWindows = clampWindowLength(mergeOverlappingWindows(windows), config.clipMaxSec);
  return selectTopN(mergedWindows, config.candidateCount);
}

module.exports = {
  measureLoudness,
  parseLoudnessLog,
  smooth,
  findPeaks,
  mergeNearbyPeaks,
  expandToWindows,
  mergeOverlappingWindows,
  clampWindowLength,
  selectTopN,
  detectCandidates,
};
