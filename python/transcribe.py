"""faster-whisper helper: transcribe a media file to .srt and report the
flattened text as a single line of JSON on stdout.

argv: <mediaPath> <modelSize> <outSrtPath>

All diagnostic output goes to stderr so stdout stays parseable JSON.
On success: {"ok": true, "srtPath": "...", "text": "...", "segments": [{"start": 0.0, "end": 3.2, "text": "..."}, ...]}
On failure: {"ok": false, "error": "..."}  (and non-zero exit code)
"""

import json
import sys


def format_timestamp(seconds):
    if seconds < 0:
        seconds = 0
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_srt(segments, out_path):
    lines = []
    for i, seg in enumerate(segments, start=1):
        text = seg.text.strip()
        lines.append(str(i))
        lines.append(f"{format_timestamp(seg.start)} --> {format_timestamp(seg.end)}")
        lines.append(text)
        lines.append("")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main():
    if len(sys.argv) != 4:
        print(json.dumps({"ok": False, "error": "usage: transcribe.py <media> <model> <outSrt>"}))
        sys.exit(1)

    media_path, model_size, out_srt_path = sys.argv[1], sys.argv[2], sys.argv[3]

    try:
        from faster_whisper import WhisperModel

        print(f"[transcribe] loading model={model_size}", file=sys.stderr)
        model = WhisperModel(model_size, device="auto", compute_type="auto")

        print(f"[transcribe] transcribing {media_path}", file=sys.stderr)
        segments_gen, _info = model.transcribe(media_path, language="ja")

        segments = []
        for seg in segments_gen:
            segments.append(seg)
            # Long (full-video) transcriptions can take a while; report
            # progress per segment so the terminal doesn't look stalled.
            print(f"[transcribe] {format_timestamp(seg.start)} {seg.text.strip()[:60]}", file=sys.stderr)

        write_srt(segments, out_srt_path)

        flat_text = " ".join(seg.text.strip() for seg in segments).strip()
        segment_list = [{"start": seg.start, "end": seg.end, "text": seg.text.strip()} for seg in segments]
        print(json.dumps({"ok": True, "srtPath": out_srt_path, "text": flat_text, "segments": segment_list}))
    except Exception as exc:  # noqa: BLE001 - surface any failure to the caller
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
