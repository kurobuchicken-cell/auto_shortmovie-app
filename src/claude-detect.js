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

// Builds a short chunk of real, already-recognized dialogue immediately
// preceding a clip's start time, to feed faster-whisper as an initial_prompt
// when re-transcribing that clip in isolation. Whisper hallucinates more
// readily when it has no prior context to anchor the decoder (see
// summarizeClipReason's note on this); priming it with genuine nearby
// dialogue substantially reduces that. Kept short, since Whisper's
// initial_prompt is only meant to bias style/vocabulary, not supply a script.
function buildInitialPromptText(segments, beforeSec, maxChars = 120) {
  const prior = segments.filter((s) => s.end <= beforeSec).sort((a, b) => a.start - b.start);
  let text = '';
  for (let i = prior.length - 1; i >= 0; i--) {
    const candidateText = prior[i].text.trim() + (text ? ' ' + text : '');
    if (candidateText.length > maxChars) break;
    text = candidateText;
  }
  return text || null;
}

function buildTranscriptText(segments) {
  return segments
    .map((seg) => `[${formatMmSs(seg.start)}-${formatMmSs(seg.end)}] ${seg.text}`)
    .join('\n');
}

function buildPrompt(transcriptText, config, requestCount) {
  return (
    `以下はゲーム実況の文字起こしです（タイムスタンプ付き、形式: [開始-終了] テキスト）。\n` +
    `2人の掛け合い・笑い・驚き・盛り上がりが伝わる区間を${requestCount}箇所選び、` +
    `各区間の開始秒・終了秒・選んだ理由を JSON で返してください。\n\n` +
    `条件:\n` +
    `- 各区間の長さは${config.clipMinSec}〜${config.clipMaxSec}秒程度にしてください\n` +
    `- 区間は重複しないようにしてください\n` +
    `- 開始秒・終了秒は文字起こしの先頭(0秒)からの経過秒数で、数値（小数可）にしてください\n` +
    `- reason（選んだ理由）には、必ずその開始秒〜終了秒の範囲内に実際に登場する発言を` +
    `一部そのまま引用してください。範囲外の発言や、別のタイミングの出来事を理由に含めないでください\n` +
    `- 出力はJSON以外の文字を含めないでください。前置きや説明文も不要です\n\n` +
    `出力フォーマット（このJSON配列のみを返す):\n` +
    `[{"startSec": 123.0, "endSec": 145.0, "reason": "選んだ理由（範囲内の発言を引用）"}, ...]\n\n` +
    `--- 文字起こし ---\n${transcriptText}\n--- 文字起こしここまで ---`
  );
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

async function sendMessage(prompt, config, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY が環境変数に設定されていません。\n' +
      '(ANTHROPIC_API_KEY environment variable is not set.)'
    );
  }

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.claudeModel,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`Claude APIの呼び出しに失敗しました (status ${res.status}):\n${bodyText.slice(0, 1000)}`);
  }

  const data = await res.json();
  return (data.content || []).map((block) => block.text || '').join('');
}

async function callClaude(transcriptText, config, requestCount) {
  const prompt = buildPrompt(transcriptText, config, requestCount);
  const text = await sendMessage(prompt, config, 2048);

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

// Claude's window-selection pass sometimes writes a "reason" describing
// dialogue that's actually just outside the chosen startSec/endSec (it
// conflates nearby exciting moments). Once the clip is cut and re-transcribed
// we have the *real* text for that exact clip, so regenerate the reason from
// that ground truth instead of trusting the upfront guess.
async function summarizeClipReason(subtitleText, config) {
  if (!subtitleText || !subtitleText.trim()) return null;
  const prompt =
    `以下はショート動画クリップの実際の字幕（文字起こし）です。\n` +
    `この内容だけを根拠に、「何が起きていて、なぜ面白い/盛り上がるのか」を1文（40字程度）で日本語で説明してください。\n` +
    `字幕に書かれていないことは推測で補わないでください。説明文以外（前置き・JSON等）は出力しないでください。\n\n` +
    `--- 字幕 ---\n${subtitleText}\n--- 字幕ここまで ---`;
  const text = await sendMessage(prompt, config, 256);
  return text.trim();
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

  // Claude is asked not to return overlapping windows, but doesn't always
  // comply. Overlapping windows produce candidates whose burned-in subtitle
  // (taken from the actual clip audio) doesn't match the "reason" Claude
  // gave (which was written about a nearby but different window), making
  // the output confusing. Greedily drop any window that overlaps the
  // previously accepted one.
  const nonOverlapping = [];
  for (const w of windows) {
    const prev = nonOverlapping[nonOverlapping.length - 1];
    if (prev && w.startSec < prev.endSec) continue;
    nonOverlapping.push(w);
  }

  return nonOverlapping.slice(0, config.candidateCount).map((w, i) => ({
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
  // Ask for more than needed: overlap dedup in clampAndValidate() can drop
  // some of Claude's picks, so requesting extra keeps the final count closer
  // to config.candidateCount.
  const requestCount = config.candidateCount + 4;
  const rawCandidates = await callClaude(transcriptText, config, requestCount);
  const candidates = clampAndValidate(rawCandidates, audioDurationSec, config);
  return { candidates, segments };
}

module.exports = {
  detectCandidatesViaClaude,
  buildTranscriptText,
  buildPrompt,
  buildInitialPromptText,
  clampAndValidate,
  summarizeClipReason,
};
