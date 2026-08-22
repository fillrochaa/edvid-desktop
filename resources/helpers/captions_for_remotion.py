"""Emit a @remotion/captions Caption[] JSON for the Remotion (Phase 2) project.

Two modes:
  --transcript <cut.json>   PREFERRED. Transcribe the FINAL cut.mp4 first
      (`transcribe.py cut.mp4`), then feed that transcript here. Its word times
      are already on the output timeline and free of the source's stretch/dead
      -air artifacts, so the first word of every segment (e.g. the hook) is
      captioned with correct timing. This is the robust default.
  <edl.json>                Fallback: map per-source word times through the EDL
      offsets. Subject to Whisper stretch at segment edges.

Each spoken word becomes one Caption (word-level) so the word-highlight /
karaoke component can drive per-word timing.

Caption shape (from @remotion/captions): { text, startMs, endMs, timestampMs, confidence }

Usage:
    python helpers/captions_for_remotion.py --transcript <edit>/transcripts/cut.json -o captions.json
    python helpers/captions_for_remotion.py <edl.json> -o captions.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _transcript import read_words


def captions_from_transcript(transcript_path: Path) -> list[dict]:
    """Words already on the output timeline (transcript of the final cut)."""
    words = read_words(transcript_path)
    caps: list[dict] = []
    for w in words:
        t = w["start"]
        e = w["end"]
        text = w["text"]
        caps.append({
            "text": text,
            "startMs": round(t * 1000),
            "endMs": round(e * 1000),
            "timestampMs": round((t + e) / 2 * 1000),
            "confidence": None,
        })
    caps.sort(key=lambda c: c["startMs"])
    return caps


def find_transcript(edit_dir: Path, source: str) -> Path | None:
    """A transcricao daquela fonte, onde quer que ela esteja.

    O Edvid Desktop grava em edit/transcricao_raw/<nome sem extensao>.json; a
    skill gravava em edit/transcripts/<nome com extensao>.json. Sem procurar
    nos dois lugares, este modo devolvia captions.json VAZIO sem erro nenhum —
    o video saia sem legenda e ninguem sabia por que.
    """
    stem = Path(source).stem
    for folder in ("transcricao_raw", "transcripts", "transcricao_corte_raw"):
        for name in (f"{source}.json", f"{stem}.json"):
            candidate = edit_dir / folder / name
            if candidate.exists():
                return candidate
    return None


def build_captions(edl: dict, edit_dir: Path) -> list[dict]:
    caps: list[dict] = []
    off = 0.0  # output-timeline offset (seconds)

    for r in edl["ranges"]:
        src = r["source"]
        a, b = float(r["start"]), float(r["end"])
        dur = b - a
        tr_path = find_transcript(edit_dir, src)
        if tr_path is None:
            off += dur
            continue
        # read_words normaliza WhisperX e o formato da skill: sem isso o
        # parsing na mao devolvia zero palavras no arquivo do Desktop.
        words = read_words(tr_path)
        seg = [w for w in words if (a - 0.08) <= w["start"] < b]
        seg.sort(key=lambda w: w["start"])
        for w in seg:
            t = max(0.0, w["start"] - a) + off
            e = min(dur, max(0.0, w["end"] - a)) + off
            if e <= t:
                e = t + 0.12
            text = (w["text"] or "").strip()
            if not text:
                continue
            caps.append({
                "text": text,
                "startMs": round(t * 1000),
                "endMs": round(e * 1000),
                "timestampMs": round((t + e) / 2 * 1000),
                "confidence": None,
            })
        off += dur

    caps.sort(key=lambda c: c["startMs"])
    return caps


def main() -> None:
    ap = argparse.ArgumentParser(description="→ @remotion/captions Caption[] JSON")
    ap.add_argument("edl", type=Path, nargs="?", help="edl.json (fallback mode)")
    ap.add_argument("--transcript", type=Path, default=None,
                    help="Transcript of the final cut.mp4 (preferred mode)")
    ap.add_argument("-o", "--output", type=Path, required=True, help="Output captions.json path")
    args = ap.parse_args()

    if args.transcript:
        caps = captions_from_transcript(args.transcript.resolve())
    elif args.edl:
        edl_path = args.edl.resolve()
        caps = build_captions(json.loads(edl_path.read_text()), edl_path.parent)
    else:
        ap.error("provide --transcript <cut.json> or an edl.json")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(caps, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{args.output} — {len(caps)} word captions")


if __name__ == "__main__":
    main()
