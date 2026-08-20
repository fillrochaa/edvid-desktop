"""Decide os cortes do CORTE LIMPO — pausas de verdade, não achismo do agente.

O agente escolhia os trechos "no olho" a partir do texto e o resultado ficava
grosseiro: pausas curtas viravam corte, respirações naturais sumiam e o começo
da fala era decepado. Este helper faz a decisão de forma determinística e a
mesma coisa em qualquer máquina.

Quem manda é o ÁUDIO, não a transcrição. Medido numa fala real com pausas de
duração conhecida: o alinhador do WhisperX ESTICA a última palavra da frase
por cima do silêncio ("longa." marcada de 8,37s a 10,81s quando a voz parou em
8,75s). Quem procura pausa no intervalo entre palavras não enxerga silêncio
nenhum ali — foi assim que uma pausa de 2 segundos passou batido e o corte
saiu grosseiro.

Então:

1. O SILÊNCIO REAL (silencedetect do FFmpeg) define onde cortar. É medida
   objetiva do sinal, imune ao alinhamento.
2. A TRANSCRIÇÃO diz onde há fala, e serve para descartar blocos que ficaram
   sem palavra nenhuma (ruído, batida de mesa, respiração isolada).

Cada bloco mantido conserva uma respiração nas bordas (--keep), e o resultado
sai no formato do edit/edl.json que a timeline do Edvid entende.

Uso:

  clean_cut.py --transcript transcricao.json --audio entrada.MOV \\
      --source IMG_0001.MOV -o edit/edl.json

Vários arquivos (a pasta inteira do aluno), na ordem em que serão concatenados:

  clean_cut.py --transcript a.json --audio A.MOV --source A.MOV \\
               --transcript b.json --audio B.MOV --source B.MOV -o edit/edl.json

Saída: edl.json com um range por bloco mantido + um resumo no stdout para o
agente relatar ao aluno (quantos cortes, quanto foi removido).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _transcript import read_words  # noqa: E402

# Pausa mínima para virar corte. Abaixo disso é ritmo de fala, não pausa.
DEFAULT_MIN_PAUSE = 0.45
# Respiração preservada em cada borda do bloco: cortar rente à palavra deixa a
# fala ofegante e come consoantes finais.
DEFAULT_KEEP = 0.12
# Limiar de silêncio do silencedetect. -32 dB tolera ar-condicionado e ruído de
# sala sem considerar fala baixa como silêncio.
DEFAULT_NOISE_DB = -32.0
# Bloco menor que isso não sobrevive sozinho: vira ruído de edição.
MIN_BLOCK = 0.30


def ffmpeg_binary() -> str:
    """O FFmpeg do Edvid, por caminho absoluto quando disponível."""
    return os.environ.get("EDVID_FFMPEG") or "ffmpeg"


def detect_silences(media: Path, noise_db: float, min_pause: float) -> list[tuple[float, float]]:
    """Silêncios reais do áudio: [(início, fim)] em segundos."""
    command = [
        ffmpeg_binary(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(media),
        "-map",
        "0:a:0",
        "-af",
        f"silencedetect=noise={noise_db}dB:d={max(0.10, min_pause / 2):.3f}",
        "-f",
        "null",
        "-",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return []
    silences: list[tuple[float, float]] = []
    start: float | None = None
    for match in re.finditer(
        r"silence_(start|end):\s*(-?\d+(?:\.\d+)?)", result.stderr or ""
    ):
        kind, value = match.group(1), float(match.group(2))
        if kind == "start":
            start = value
        elif start is not None:
            silences.append((start, value))
            start = None
    return silences


def words_between(words: list[dict], start: float, end: float) -> int:
    """Quantas palavras têm o miolo dentro deste trecho."""
    total = 0
    for word in words:
        middle = (word["start"] + word["end"]) / 2
        if start <= middle <= end:
            total += 1
    return total


def blocks_from_silences(
    words: list[dict],
    silences: list[tuple[float, float]],
    duration: float,
    min_pause: float,
    keep: float,
) -> list[dict]:
    """Blocos de fala = o que sobra depois de remover os silêncios longos."""
    cuts = [(start, end) for start, end in silences if end - start >= min_pause]
    spans: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in cuts:
        # A respiração cabe DENTRO do silêncio: o bloco termina um pouco depois
        # da última sílaba e o próximo começa um pouco antes da próxima.
        block_end = min(start + keep, end)
        if block_end - cursor >= MIN_BLOCK:
            spans.append((cursor, block_end))
        cursor = max(end - keep, block_end)
    tail_end = duration or (words[-1]["end"] + keep if words else cursor)
    if tail_end - cursor >= MIN_BLOCK:
        spans.append((cursor, tail_end))

    out: list[dict] = []
    for start, end in spans:
        spoken = words_between(words, start, end)
        # Sem palavra nenhuma o bloco é ruído (batida, respiração solta).
        if words and spoken == 0:
            continue
        out.append({"start": round(start, 3), "end": round(end, 3), "words": spoken})
    return out


def blocks_from_words(
    words: list[dict],
    duration: float,
    min_pause: float,
    keep: float,
) -> list[dict]:
    """Plano B, sem análise de áudio: agrupa pelos intervalos da transcrição.

    Menos confiável (o alinhador estica palavras sobre o silêncio), usado só
    quando o arquivo não tem trilha analisável ou o FFmpeg não respondeu.
    """
    if not words:
        return []
    groups: list[dict] = []
    current = {"start": words[0]["start"], "end": words[0]["end"], "words": 1}
    for previous, word in zip(words, words[1:]):
        if word["start"] - previous["end"] >= min_pause:
            groups.append(current)
            current = {"start": word["start"], "end": word["end"], "words": 1}
        else:
            current["end"] = word["end"]
            current["words"] += 1
    groups.append(current)

    out: list[dict] = []
    for index, group in enumerate(groups):
        previous_end = out[-1]["end"] if out else 0.0
        next_start = groups[index + 1]["start"] if index + 1 < len(groups) else (duration or group["end"] + keep)
        start = max(previous_end, group["start"] - keep)
        end = min(group["end"] + keep, next_start - keep / 2 if index + 1 < len(groups) else (duration or group["end"] + keep))
        if end - start >= MIN_BLOCK:
            out.append({"start": round(start, 3), "end": round(end, 3), "words": group["words"]})
    return out


def media_duration(media: Path) -> float:
    probe = os.environ.get("EDVID_FFPROBE") or "ffprobe"
    try:
        result = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(media)],
            capture_output=True,
            text=True,
            check=False,
        )
        return float((result.stdout or "0").strip() or 0)
    except (FileNotFoundError, ValueError):
        return 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--transcript", action="append", required=True, type=Path,
                        help="JSON do WhisperX (repita junto com --audio/--source por arquivo)")
    parser.add_argument("--audio", action="append", required=True, type=Path,
                        help="arquivo de mídia correspondente à transcrição")
    parser.add_argument("--source", action="append", default=None,
                        help="nome da fonte no EDL (padrão: nome do arquivo de mídia)")
    parser.add_argument("-o", "--output", type=Path, required=True, help="caminho do edl.json")
    parser.add_argument("--min-pause", type=float, default=DEFAULT_MIN_PAUSE)
    parser.add_argument("--keep", type=float, default=DEFAULT_KEEP)
    parser.add_argument("--noise-db", type=float, default=DEFAULT_NOISE_DB)
    args = parser.parse_args()

    if len(args.transcript) != len(args.audio):
        parser.error("informe um --audio para cada --transcript, na mesma ordem")
    sources = args.source or [media.name for media in args.audio]
    if len(sources) != len(args.audio):
        parser.error("informe um --source para cada --audio, na mesma ordem")

    ranges: list[dict] = []
    source_map: dict[str, str] = {}
    original_total = 0.0
    kept_total = 0.0
    beat = 0

    for transcript_path, media_path, source_id in zip(args.transcript, args.audio, sources):
        words = read_words(transcript_path)
        duration = media_duration(media_path)
        original_total += duration
        if not words:
            print(f"AVISO: {transcript_path.name} não tem palavras alinhadas; arquivo ignorado.", file=sys.stderr)
            continue
        silences = detect_silences(media_path, args.noise_db, args.min_pause)
        blocks = (
            blocks_from_silences(words, silences, duration, args.min_pause, args.keep)
            if silences
            else blocks_from_words(words, duration, args.min_pause, args.keep)
        )
        if not silences:
            print(f"AVISO: sem análise de áudio em {media_path.name}; cortes derivados só da transcrição.", file=sys.stderr)
        source_map[source_id] = str(media_path.name if media_path.parent == Path(".") else media_path)
        for block in blocks:
            beat += 1
            kept_total += block["end"] - block["start"]
            ranges.append({
                "source": source_id,
                "beat": f"Bloco {beat:02d}",
                "start": block["start"],
                "end": block["end"],
            })

    if not ranges:
        print("ERRO: nenhuma fala encontrada; não há corte limpo a fazer.", file=sys.stderr)
        return 1

    document = {
        "version": 1,
        "sources": source_map,
        "ranges": ranges,
        "total_duration_s": round(kept_total, 3),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")

    removed = max(0.0, original_total - kept_total)
    percent = (removed / original_total * 100) if original_total else 0.0
    print(
        f"{len(ranges)} blocos mantidos | original {original_total:.2f}s "
        f"| final {kept_total:.2f}s | removido {removed:.2f}s ({percent:.0f}%)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
