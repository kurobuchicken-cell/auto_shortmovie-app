'use strict';

const TIME_RE = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/g;
const BLOCK_SEPARATOR_RE = /^={3,}$/;

function timeToSec(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function secToSrtTime(totalSec) {
  const clamped = Math.max(0, totalSec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

// Parses one pasted/corrected SRT-style chunk (index lines + timestamp lines
// are kept as anchors; only the text in between is taken from the user's
// edit, since that's the only part they're expected to correct).
function parseSrtEntries(blockText) {
  const matches = [...blockText.matchAll(TIME_RE)];
  if (matches.length === 0) {
    throw new Error('SRT形式のタイムスタンプ（HH:MM:SS,mmm --> HH:MM:SS,mmm）が見つかりませんでした。');
  }

  const entries = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const startSec = timeToSec(m[1], m[2], m[3], m[4]);
    const endSec = timeToSec(m[5], m[6], m[7], m[8]);
    const textStart = m.index + m[0].length;
    const textEnd = i + 1 < matches.length ? matches[i + 1].index : blockText.length;
    let textSegment = blockText.slice(textStart, textEnd);

    // Drop the next entry's leading index-number line, if present.
    const lines = textSegment
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0 && /^\d+$/.test(lines[lines.length - 1])) {
      lines.pop();
    }

    entries.push({ startSec, endSec, text: lines.join(' ') });
  }

  entries.sort((a, b) => a.startSec - b.startSec);
  return entries;
}

// Splits pasted text into multiple clip blocks on a line of "===" (or more),
// so several corrected regions can be submitted in one go.
function splitIntoBlocks(rawText) {
  const lines = rawText.split(/\r?\n/);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (BLOCK_SEPARATOR_RE.test(line.trim())) {
      blocks.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  blocks.push(current.join('\n'));
  return blocks.map((b) => b.trim()).filter((b) => b.length > 0);
}

// Builds a clip-relative SRT (renumbered, timestamps shifted so the clip's
// first entry starts at 0) plus the plain concatenated subtitle text, from
// entries whose timestamps are absolute (i.e. relative to the full source
// video, as in work/full_transcript.srt).
function buildManualClip(entries) {
  const startSec = entries[0].startSec;
  const endSec = entries[entries.length - 1].endSec;
  const srtContent = entries
    .map((e, i) => {
      const relStart = secToSrtTime(e.startSec - startSec);
      const relEnd = secToSrtTime(e.endSec - startSec);
      return `${i + 1}\n${relStart} --> ${relEnd}\n${e.text}\n`;
    })
    .join('\n');
  const subtitleText = entries.map((e) => e.text).join(' ');
  return {
    startSec,
    endSec,
    durationSec: endSec - startSec,
    srtContent,
    subtitleText,
  };
}

// Parses pasted text (optionally containing multiple "===" separated
// blocks) into manual clip definitions, each with absolute startSec/endSec
// (for cutting from the source video) and a ready-to-burn relative SRT.
function parseManualBlocks(rawText) {
  return splitIntoBlocks(rawText).map((block) => buildManualClip(parseSrtEntries(block)));
}

module.exports = { parseManualBlocks, parseSrtEntries, buildManualClip, secToSrtTime, timeToSec };
