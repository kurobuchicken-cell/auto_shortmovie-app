"""faster-whisper helper: transcribe a media file to .srt and report the
flattened text as a single line of JSON on stdout.

argv: <mediaPath> <modelSize> <outSrtPath> [granularity] [range ...] [--initial-prompt TEXT]

--initial-prompt TEXT: optional, can appear anywhere in argv. Primes
  faster-whisper's decoder with real preceding dialogue (e.g. the last bit of
  the full-video transcript right before this clip's start time), which
  reduces hallucination when re-transcribing a short clip that otherwise has
  no context to anchor it.

granularity:
  "segment" (default) - one SRT entry per whisper segment (sentence/phrase).
    Standard, easy-to-read display: the whole sentence appears at once.
  "char" - splits every segment into a sequence of growing-text entries
    timed per character ("karaoke" style), so repeated/rapid speech (e.g.
    "ちょちょちょちょ") appears progressively instead of all at once. Uses
    word-level timestamps as anchors and evenly subdivides each word's time
    slot across its characters, since faster-whisper has no finer-grained
    alignment. Applied to the whole clip - can look busy for normal speech,
    so prefer "mixed" for selective use.
  "mixed" - like "segment" by default, but any segment whose time range
    overlaps one of the given <range> args (format "start-end" in seconds,
    clip-local) is rendered with the "char" (karaoke) treatment instead.
    Lets a human pick specific moments worth the karaoke effect while
    everything else stays as plain one-sentence-at-a-time subtitles.

All diagnostic output goes to stderr so stdout stays parseable JSON.
On success: {"ok": true, "srtPath": "...", "text": "...", "segments": [{"start": 0.0, "end": 3.2, "text": "..."}, ...]}
On failure: {"ok": false, "error": "..."}  (and non-zero exit code)
"""

import glob
import json
import os
import sys


def add_nvidia_dll_directories():
    """pip-installed nvidia-cublas-cu12 / nvidia-cudnn-cu12 ship their DLLs
    under site-packages/nvidia/*/bin, which Windows does not search by
    default. ctranslate2 (faster-whisper's backend) needs them on the DLL
    search path to use the GPU."""
    if os.name != "nt":
        return
    for site_packages in sys.path:
        for bin_dir in glob.glob(os.path.join(site_packages, "nvidia", "*", "bin")):
            os.add_dll_directory(bin_dir)
            # ctranslate2's native extension loads CUDA DLLs via plain
            # LoadLibrary (no search-path flags), which only honors PATH,
            # not os.add_dll_directory. Prepend to PATH too so it's found.
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def format_timestamp(seconds):
    if seconds < 0:
        seconds = 0
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_srt(entries, out_path):
    """entries: list of (start_sec, end_sec, text)."""
    lines = []
    for i, (start, end, text) in enumerate(entries, start=1):
        lines.append(str(i))
        lines.append(f"{format_timestamp(start)} --> {format_timestamp(end)}")
        lines.append(text)
        lines.append("")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def char_level_entries(seg):
    """Builds growing-text entries for one segment, timed per character.

    Word *end* timestamps from faster-whisper's alignment are unreliable for
    rapid/repeated speech (often zero-length or oddly long), so only word
    *start* times are trusted. Each word's display slot runs until the next
    word starts (or the segment end, for the last word), and is then split
    evenly across that word's characters - the best available approximation
    given faster-whisper has no finer-grained alignment than the word level.
    """
    words = seg.words or []
    if not words:
        return [(seg.start, seg.end, seg.text.strip())]

    # (appear_time, char) pairs in chronological order across the whole segment.
    chars = []
    for i, w in enumerate(words):
        slot_start = w.start
        slot_end = words[i + 1].start if i + 1 < len(words) else seg.end
        if slot_end < slot_start:
            slot_end = slot_start
        letters = list(w.word.strip())
        n = len(letters)
        if n == 0:
            continue
        for j, ch in enumerate(letters):
            chars.append((slot_start + (slot_end - slot_start) * j / n, ch))

    if not chars:
        return [(seg.start, seg.end, seg.text.strip())]

    # Cumulative (growing) text at each character's appear time.
    points = []
    cumulative = ""
    for t, ch in chars:
        cumulative += ch
        points.append((t, cumulative))

    # Collapse zero-duration steps (rapid speech the aligner couldn't space
    # out) by only emitting an entry when it would actually have visible
    # duration; the skipped characters' text is still carried by cumulative.
    entries = []
    for k in range(len(points)):
        start = points[k][0]
        end = points[k + 1][0] if k + 1 < len(points) else seg.end
        if end <= start:
            continue
        entries.append((start, end, points[k][1]))
    return entries


def parse_ranges(args):
    ranges = []
    for arg in args:
        try:
            start_str, end_str = arg.split("-", 1)
            ranges.append((float(start_str), float(end_str)))
        except ValueError:
            raise ValueError(f'不正な range 指定です: "{arg}" (例: "12.5-14.0")')
    return ranges


def overlaps(seg, ranges):
    return any(seg.start < r_end and r_start < seg.end for r_start, r_end in ranges)


def build_entries(segments, granularity, ranges=None):
    if granularity == "char":
        entries = []
        for seg in segments:
            entries.extend(char_level_entries(seg))
        return entries
    if granularity == "mixed":
        entries = []
        for seg in segments:
            if overlaps(seg, ranges or []):
                entries.extend(char_level_entries(seg))
            else:
                entries.append((seg.start, seg.end, seg.text.strip()))
        return entries
    return [(seg.start, seg.end, seg.text.strip()) for seg in segments]


def extract_initial_prompt(argv):
    """Pulls "--initial-prompt TEXT" out of argv (if present), wherever it
    appears, returning (remaining_argv, prompt_or_None)."""
    if "--initial-prompt" not in argv:
        return argv, None
    i = argv.index("--initial-prompt")
    if i + 1 >= len(argv):
        raise ValueError("--initial-prompt にはテキストを指定してください。")
    prompt = argv[i + 1]
    remaining = argv[:i] + argv[i + 2:]
    return remaining, prompt


def main():
    argv, initial_prompt = extract_initial_prompt(sys.argv[1:])

    if len(argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: transcribe.py <media> <model> <outSrt> [granularity] [range ...] [--initial-prompt TEXT]"}))
        sys.exit(1)

    media_path, model_size, out_srt_path = argv[0], argv[1], argv[2]
    granularity = argv[3] if len(argv) >= 4 else "segment"
    ranges = parse_ranges(argv[4:]) if len(argv) > 4 else []

    try:
        add_nvidia_dll_directories()
        from faster_whisper import WhisperModel

        print(f"[transcribe] loading model={model_size}", file=sys.stderr)
        model = WhisperModel(model_size, device="auto", compute_type="auto")

        print(f"[transcribe] transcribing {media_path}", file=sys.stderr)
        # vad_filter skips silence/non-speech stretches before decoding.
        # Without it, faster-whisper tends to hallucinate fluent-sounding
        # (sometimes even wrong-language) text to "fill in" silent gaps,
        # especially in short out-of-context clips that lack the surrounding
        # dialogue to anchor the decoder.
        segments_gen, _info = model.transcribe(
            media_path,
            language="ja",
            word_timestamps=True,
            vad_filter=True,
            initial_prompt=initial_prompt,
        )

        segments = []
        for seg in segments_gen:
            segments.append(seg)
            # Long (full-video) transcriptions can take a while; report
            # progress per segment so the terminal doesn't look stalled.
            print(f"[transcribe] {format_timestamp(seg.start)} {seg.text.strip()[:60]}", file=sys.stderr)

        write_srt(build_entries(segments, granularity, ranges), out_srt_path)

        flat_text = " ".join(seg.text.strip() for seg in segments).strip()
        segment_list = [{"start": seg.start, "end": seg.end, "text": seg.text.strip()} for seg in segments]
        print(json.dumps({"ok": True, "srtPath": out_srt_path, "text": flat_text, "segments": segment_list}))
    except Exception as exc:  # noqa: BLE001 - surface any failure to the caller
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
