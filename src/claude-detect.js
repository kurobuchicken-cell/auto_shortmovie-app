'use strict';

const path = require('path');
const { runPython } = require('./python-utils');

const TRANSCRIBE_SCRIPT = path.join(__dirname, '..', 'python', 'transcribe.py');
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function formatMmSs(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function transcribeFullAudio(audioWavPath, workDir, config) {
  const srtPath = path.join(workDir, 'full_transcript.srt');
  const timeoutMs = (config.fullTranscribeTimeoutSec || 1800) * 1000;
  const { stdout, stderr } = await runPython(
    [TRANSCRIBE_SCRIPT, audioWavPath, config.whisperModel, srtPath],
    timeoutMs,
    '全体文字起こし (full transcript)'
  );

  const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
  let result;
  try {
    result = JSON.parse(lastLine);
  } catch (e) {
    throw new Error(`全体文字起こしの結果解析に失敗しました:\n${stderr}\n${stdout}`);
  }
  if (!result.ok) {
    throw new Error(`全体文字起こしに失敗しました: ${result.error}`);
  }
  return result.segments || [];
}

function buildTranscriptText(segments) {
  return segments
    .map((seg) => `[${formatMmSs(seg.start)}-${formatMmSs(seg.end)}] ${seg.text}`)
    .join('\n');
}

function buildPrompt(transcriptText, config) {
  return (
    `以下はゲーム実況の文字起こしです（タイムスタンプ付き、形式: [開始-終了] テキスト）。\n` +
    `2人の掛け合い・笑い・驚き・盛り上がりが伝わる区間を${config.candidateCount}箇所選び、` +
    `各区間の開始秒・終了秒・選んだ理由を JSON で返してください。\n\n` +
    `条件:\n` +
    `- 各区間の長さは${config.clipMinSec}〜${config.clipMaxSec}秒程度にしてください\n` +
    `- 区間は重複しないようにしてください\n` +
    `- 開始秒・終了秒は文字起こしの先頭(0秒)からの経過秒数で、数値（小数可）にしてください\n` +
    `- 出力はJSON以外の文字を含めないでください。前置きや説明文も不要です\n\n` +
    `出力フォーマット（このJSON配列のみを返す):\n` +
    `[{"startSec": 123.0, "endSec": 145.0, "reason": "選んだ理由"}, ...]\n\n` +
    `--- 文字起こし ---\n${transcriptText}\n--- 文字起こしここまで ---`
  );
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

async function callClaude(transcriptText, config) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY が環境変数に設定されていません。\n' +
      '(ANTHROPIC_API_KEY environment variable is not set.)'
    );
  }

  const prompt = buildPrompt(transcriptText, config);
  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`Claude APIの呼び出しに失敗しました (status ${res.status}):\n${bodyText.slice(0, 1000)}`);
  }

  const data = await res.json();
  const text = (data.content || []).map((block) => block.text || '').join('');

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (e) {
    throw new Error(`Claude APIの応答をJSONとして解析できませんでした:\n${text.slice(0, 1000)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Claude APIの応答が配列ではありません:\n${text.slice(0, 1000)}`);
  }
  return parsed;
}

function clampAndValidate(rawCandidates, audioDurationSec, config) {
  const { clipMinSec, clipMaxSec } = config;
  const valid = rawCandidates.filter(
    (c) =>
      typeof c.startSec === 'number' &&
      typeof c.endSec === 'number' &&
      c.endSec > c.startSec &&
      c.startSec < audioDurationSec
  );

  const windows = valid
    .map((c) => {
      let start = Math.max(0, c.startSec);
      let end = Math.min(audioDurationSec, c.endSec);
      if (end - start < clipMinSec) end = Math.min(audioDurationSec, start + clipMinSec);
      if (end - start > clipMaxSec) end = start + clipMaxSec;
      return { startSec: start, endSec: end, reason: c.reason || '' };
    })
    // Clamping endSec to audioDurationSec can leave a sliver (or zero-length)
    // window when startSec was already very close to the end of the audio.
    .filter((w) => w.endSec - w.startSec >= 1);

  windows.sort((a, b) => a.startSec - b.startSec);
  return windows.slice(0, config.candidateCount).map((w, i) => ({
    index: i + 1,
    startSec: w.startSec,
    endSec: w.endSec,
    durationSec: w.endSec - w.startSec,
    reason: w.reason,
  }));
}

async function detectCandidatesViaClaude(audioWavPath, workDir, config) {
  const segments = await transcribeFullAudio(audioWavPath, workDir, config);
  if (segments.length === 0) {
    throw new Error('全体文字起こしの結果が空でした。音声に発話が検出できませんでした。\n(Full transcript came back empty - no speech detected.)');
  }
  const audioDurationSec = Math.max(...segments.map((s) => s.end));
  const transcriptText = buildTranscriptText(segments);
  const rawCandidates = await callClaude(transcriptText, config);
  return clampAndValidate(rawCandidates, audioDurationSec, config);
}

module.exports = { detectCandidatesViaClaude, buildTranscriptText, buildPrompt, clampAndValidate };
