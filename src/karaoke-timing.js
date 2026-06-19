'use strict';

const BLOCK_SEPARATOR_RE = /^={3,}$/;
const LINE_RE = /^(\d+(?:\.\d+)?)\s*(.*)$/;

// Splits a timing file into "===" separated blocks, each a list of raw lines.
function splitIntoLineBlocks(rawText) {
  const lines = rawText.split(/\r?\n/);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (BLOCK_SEPARATOR_RE.test(line.trim())) {
      blocks.push(current);
      current = [];
    } else if (line.trim().length > 0) {
      current.push(line.trim());
    }
  }
  blocks.push(current);
  return blocks.filter((b) => b.length > 0);
}

// Parses one block of "<time> <text>" lines into {time, text} points. The
// last line carries only a time (no text) - it marks when the last bit of
// text should stop being displayed, not a new character to show.
function parseTimingBlock(lines) {
  const points = lines.map((line) => {
    const m = LINE_RE.exec(line);
    if (!m) {
      throw new Error(`タイミング指定の形式が不正です: "${line}"（例: "12.5 い"）`);
    }
    return { time: Number(m[1]), text: m[2] };
  });
  if (points.length < 2) {
    throw new Error('タイミングブロックには、文字の行と最後の終了時刻の行を合わせて最低2行必要です。');
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i].time <= points[i - 1].time) {
      throw new Error(`タイミングは時刻順に並べてください（"${lines[i - 1]}" の後に "${lines[i]}"）。`);
    }
  }
  return points;
}

// Builds growing-text (startSec, endSec, text) entries from a parsed block:
// each line's text is appended to a running cumulative string, displayed
// from its own time until the next line's time. The block's overall
// [startSec, endSec) span is also returned so the caller can splice these
// entries into an existing SRT in place of whatever was there before.
function buildKaraokeEntries(points) {
  let cumulative = '';
  const entries = [];
  for (let i = 0; i < points.length - 1; i++) {
    cumulative += points[i].text;
    entries.push({ startSec: points[i].time, endSec: points[i + 1].time, text: cumulative });
  }
  return {
    startSec: points[0].time,
    endSec: points[points.length - 1].time,
    entries,
  };
}

// Parses a full timing file (optionally multiple "===" separated blocks)
// into a list of { startSec, endSec, entries } karaoke blocks.
function parseTimingFile(rawText) {
  return splitIntoLineBlocks(rawText).map((lines) => buildKaraokeEntries(parseTimingBlock(lines)));
}

module.exports = { parseTimingFile, parseTimingBlock, buildKaraokeEntries };
