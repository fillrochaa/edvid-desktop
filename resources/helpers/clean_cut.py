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
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _transcript import read_segments, read_words  # noqa: E402

# Pausa mínima para virar corte. Abaixo disso é ritmo de fala, não pausa.
#
# Era 0,45s e deixava pausa demais. Medido no vídeo real do aluno (175s de
# fala de câmera): com 0,45 sobravam 111,0s, sendo que o arquivo tem 103,5s de
# fala de verdade; com 0,30 sobram 104,7s. Abaixo de 0,25 o corte começa a
# comer fala (102,3s < 103,5s) e a edição fica ofegante.
DEFAULT_MIN_PAUSE = 0.30
# Respiração preservada em cada borda do bloco.
#
# Este número é literalmente o silêncio que sobra no começo e no fim de CADA
# bloco — foi o que o aluno viu ("muitos frames em silêncio no fim e no
# começo"). Com 0,12 eram 4,47s de ar morto nas bordas de 19 blocos; com 0,04
# são 1,30s, e o pior bloco caiu de 0,80s para 0,30s. Zero corta o ataque da
# consoante, então não vai a zero.
DEFAULT_KEEP = 0.04
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


def words_in(words: list[dict], start: float, end: float) -> list[dict]:
    """As palavras cujo miolo cai dentro deste trecho."""
    return [
        word for word in words
        if start <= (word["start"] + word["end"]) / 2 <= end
    ]


def words_between(words: list[dict], start: float, end: float) -> int:
    """Quantas palavras têm o miolo dentro deste trecho."""
    return len(words_in(words, start, end))


# --- TAKES REFEITOS --------------------------------------------------------
# O aluno erra, para e recomeça a frase. O silêncio separa as duas tentativas
# em blocos vizinhos, e as DUAS sobreviviam ao corte limpo — o vídeo saía com
# a pessoa dizendo a mesma coisa duas vezes. Foi o que ele relatou vendo o
# resultado ("muitas repetições que deveriam ter ficado de fora").
#
# Medido no vídeo real dele, três casos em dezessete blocos:
#   "Por fim, uma das maiores novidades que a Apple vai lançar agora em..."
#   "Por fim, uma das maiores novidades que a Apple vai lançar agora no começo…"
#   "Mas me diz aí, você vai comprar um..."   /  "…um iPhone novo?"
#   "O design dos novos iPhones, o design dos iPhones 18, o design dos iPhones"
# As duas regras abaixo pegam os três e não disparam em nenhum dos catorze
# blocos legítimos.

# Prefixo comum mínimo para dois blocos serem a MESMA frase recomeçada.
RETAKE_MIN_PREFIX = 3
# Quanto do bloco anterior precisa ser esse prefixo. Alto de propósito: dois
# blocos que só começam igual ("E aí…") não são retake.
RETAKE_PREFIX_RATIO = 0.70


def normalized_words(text: str) -> list[str]:
    """Palavras em minúscula, sem acento e sem pontuação."""
    lowered = unicodedata.normalize("NFD", text.lower())
    stripped = "".join(c for c in lowered if unicodedata.category(c) != "Mn")
    return re.findall(r"[a-z0-9]+", stripped)


def common_prefix(first: list[str], second: list[str]) -> int:
    total = 0
    while total < len(first) and total < len(second) and first[total] == second[total]:
        total += 1
    return total


def is_retake(previous: list[str], following: list[str]) -> bool:
    """`previous` é uma tentativa abandonada de dizer o que vem em `following`?"""
    if not previous or not following:
        return False
    # 1. Tentativa interrompida: quase tudo o que ele disse é o começo da
    #    próxima frase ("…vai lançar agora em…" / "…vai lançar agora no começo").
    prefix = common_prefix(previous, following)
    if prefix >= RETAKE_MIN_PREFIX and prefix / len(previous) >= RETAKE_PREFIX_RATIO:
        return True
    # 2. Gaguejo: ele repete a própria abertura dentro do bloco E o bloco
    #    seguinte começa com ela ("o design dos… o design dos… o design dos").
    opening = previous[:RETAKE_MIN_PREFIX]
    if len(previous) >= RETAKE_MIN_PREFIX * 2 and following[:RETAKE_MIN_PREFIX] == opening:
        repeats = sum(
            1 for i in range(1, len(previous) - RETAKE_MIN_PREFIX + 1)
            if previous[i:i + RETAKE_MIN_PREFIX] == opening
        )
        if repeats >= 1:
            return True
    return False


def retake_ranges(segments: list[dict]) -> list[tuple[float, float]]:
    """Os trechos de tempo em que ele começou a frase e recomeçou.

    A comparação é entre FRASES, não entre blocos de silêncio: um take
    abandonado costuma virar três ou quatro blocos curtos ("o design dos
    iPhones 18," / "design dos iPhones"), e comparando bloco com bloco a
    tentativa passava pela metade — sobrava justamente o pedaço solto que o
    aluno vê no vídeo.
    """
    said = [normalized_words(segment["text"]) for segment in segments]
    ranges: list[tuple[float, float]] = []
    for index in range(len(segments) - 1):
        # Compara com a próxima frase que ainda não foi descartada: numa
        # sequência de três tentativas, todas menos a última saem.
        following = index + 1
        while following < len(segments) and (segments[following]["start"], segments[following]["end"]) in ranges:
            following += 1
        if following >= len(segments):
            continue
        if is_retake(said[index], said[following]):
            ranges.append((segments[index]["start"], segments[index]["end"]))
    return ranges


def inside_retake(start: float, end: float, ranges: list[tuple[float, float]]) -> bool:
    """O bloco caiu dentro de uma tentativa abandonada?"""
    middle = (start + end) / 2
    return any(a <= middle <= b for a, b in ranges)


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
        spoken = words_in(words, start, end)
        # Sem palavra nenhuma o bloco é ruído (batida, respiração solta).
        if words and not spoken:
            continue
        out.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "words": len(spoken),
            "said": normalized_words(" ".join(str(w.get("text", "")) for w in spoken)),
        })
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
            spoken = words_in(words, start, end)
            out.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "words": group["words"],
                "said": normalized_words(" ".join(str(w.get("text", "")) for w in spoken)),
            })
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
    parser.add_argument("--keep-retakes", action="store_true",
                        help="nao descarta as tentativas abandonadas de uma frase")
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
    retakes = 0
    retake_spans: list[dict] = []

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
        if not args.keep_retakes:
            discard = retake_ranges(read_segments(transcript_path))
            # Guardado no EDL: descartar fala e decisao editorial, e decisao
            # editorial tem de poder ser revista sem refazer a transcricao.
            retake_spans += [
                {"source": source_id, "start": round(a, 3), "end": round(b, 3)}
                for a, b in discard
            ]
            before = len(blocks)
            blocks = [b for b in blocks if not inside_retake(b["start"], b["end"], discard)]
            retakes += before - len(blocks)
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
        "retakes_removed": retakes,
        "retakes_ranges": retake_spans,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")

    removed = max(0.0, original_total - kept_total)
    percent = (removed / original_total * 100) if original_total else 0.0
    print(
        f"{len(ranges)} blocos mantidos | original {original_total:.2f}s "
        f"| final {kept_total:.2f}s | removido {removed:.2f}s ({percent:.0f}%)"
        + (f" | {retakes} repeticoes descartadas" if retakes else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
