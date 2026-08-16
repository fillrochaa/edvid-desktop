"""Emite o public/segments.json da Fase 2 — os limites reais dos cortes.

O template usa esses limites para trocar o zoom a cada corte (DynamicVideo em
src/Main.tsx). Eles precisam bater com o vídeo COM PRECISÃO DE FRAME: o ffmpeg
arredonda cada segmento para um frame inteiro, então somar os segundos do EDL
acumula erro e o zoom passa a disparar antes ou depois do corte.

Dois modos, do mais exato para o aproximado:

  # PREFERIDO — mede os clipes já codificados, um por corte
  segments_for_remotion.py clips_graded/seg_*.mp4 -o public/segments.json

  # FALLBACK — sem clipes por corte, deriva do EDL em frames inteiros
  segments_for_remotion.py --edl edit/edl.json --fps 30 -o public/segments.json

O fallback ainda é melhor que somar segundos: ele converte cada trecho para
frames antes de acumular, então o erro não se propaga de um corte ao seguinte.
Quando existirem os clipes, use o primeiro modo.

Saída: {"segments": [{"start": <s>, "dur": <s>}, ...]}
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
from pathlib import Path


def ffprobe_binary() -> str:
    """O Edvid Desktop aponta EDVID_FFPROBE para o binário empacotado."""
    return os.environ.get("EDVID_FFPROBE") or "ffprobe"


def parse_rate(value: str | None) -> float | None:
    if not value or value in {"0/0", "N/A"}:
        return None
    if "/" in value:
        num, _, den = value.partition("/")
        try:
            rate = float(num) / float(den)
        except (ValueError, ZeroDivisionError):
            return None
    else:
        try:
            rate = float(value)
        except ValueError:
            return None
    return rate if rate > 0 else None


def probe_clip(path: Path) -> tuple[int, float | None]:
    """Conta os frames REAIS do arquivo, sem confiar em metadados de duração."""
    out = subprocess.run(
        [
            ffprobe_binary(), "-v", "error",
            "-select_streams", "v:0",
            "-count_frames",
            "-show_entries", "stream=nb_read_frames,avg_frame_rate,r_frame_rate",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True, text=True,
    ).stdout
    stream = (json.loads(out).get("streams") or [{}])[0]
    frames = stream.get("nb_read_frames")
    if frames in (None, "N/A"):
        raise SystemExit(f"ffprobe nao contou frames em {path}")
    fps = parse_rate(stream.get("avg_frame_rate")) or parse_rate(stream.get("r_frame_rate"))
    return int(frames), fps


def from_clips(clips: list[Path], forced_fps: float | None) -> list[dict]:
    segments: list[dict] = []
    start_frames = 0
    fps = forced_fps
    for clip in clips:
        frames, clip_fps = probe_clip(clip)
        if fps is None:
            fps = clip_fps
        if fps is None:
            raise SystemExit(f"nao foi possivel determinar o fps de {clip}; use --fps")
        segments.append({
            # 9 casas: com 6 o limite deixa de cair exatamente sobre o frame
            # (31/30 vira 1.033333, que multiplicado por 30 nao volta a 31).
            "start": round(start_frames / fps, 9),
            "dur": round(frames / fps, 9),
        })
        start_frames += frames
    return segments


def from_edl(edl_path: Path, fps: float | None) -> list[dict]:
    edl = json.loads(edl_path.read_text())
    ranges = edl.get("ranges") or []
    if not ranges:
        raise SystemExit(f"{edl_path} nao tem ranges")
    if fps is None:
        raise SystemExit("o modo --edl exige --fps (o mesmo fps do cut.mp4)")
    segments: list[dict] = []
    start_frames = 0
    for item in ranges:
        try:
            duration = float(item["end"]) - float(item["start"])
        except (KeyError, TypeError, ValueError):
            continue
        if duration <= 0:
            continue
        # Mesmo arredondamento do ffmpeg: o segmento ocupa frames inteiros.
        frames = max(1, math.ceil(duration * fps - 1e-6))
        segments.append({
            # 9 casas: com 6 o limite deixa de cair exatamente sobre o frame
            # (31/30 vira 1.033333, que multiplicado por 30 nao volta a 31).
            "start": round(start_frames / fps, 9),
            "dur": round(frames / fps, 9),
        })
        start_frames += frames
    if not segments:
        raise SystemExit(f"{edl_path} nao produziu nenhum segmento valido")
    return segments


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", type=Path, nargs="*", help="Clipes por corte, na ordem da timeline")
    ap.add_argument("--edl", type=Path, default=None, help="edl.json (fallback, exige --fps)")
    ap.add_argument("--fps", type=float, default=None, help="fps do cut.mp4")
    ap.add_argument("-o", "--output", type=Path, required=True, help="Caminho do segments.json")
    args = ap.parse_args()

    if args.clips:
        segments = from_clips(args.clips, args.fps)
        origem = f"{len(args.clips)} clipes medidos"
    elif args.edl:
        segments = from_edl(args.edl, args.fps)
        origem = f"EDL em {args.fps:g} fps (aproximado)"
    else:
        ap.error("informe os clipes por corte ou --edl")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"segments": segments}, indent=2) + "\n")
    total = segments[-1]["start"] + segments[-1]["dur"]
    print(f"{args.output} — {len(segments)} cortes, {total:.3f}s ({origem})")


if __name__ == "__main__":
    main()
