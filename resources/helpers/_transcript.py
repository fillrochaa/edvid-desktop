"""Leitura de transcricao tolerante ao formato, para os helpers da Fase 2.

A skill Edvid transcreve com helpers/transcribe.py, que emite uma lista `words`
no topo do arquivo, cada palavra com `type`, `text`, `start` e `end`. O Edvid
Desktop transcreve com o WhisperX empacotado (`python3 -m whisperx
--output_format json`), que emite `segments[].words[]` com a chave `word` e sem
`type`. Os dois descrevem a mesma coisa; sem esta normalizacao os geradores de
legenda liam zero palavras e o agente acabava inventando o JSON na mao.
"""
from __future__ import annotations

import json
from pathlib import Path


def read_words(transcript_path: Path) -> list[dict]:
    """Devolve [{text, start, end}] em segundos, seja qual for o formato."""
    data = json.loads(Path(transcript_path).read_text())

    raw: list[dict] = []
    if isinstance(data.get("words"), list):
        # Formato da skill (transcribe.py).
        raw = [w for w in data["words"] if w.get("type", "word") == "word"]
    elif isinstance(data.get("word_segments"), list):
        # WhisperX: lista plana ja alinhada.
        raw = list(data["word_segments"])
    elif isinstance(data.get("segments"), list):
        # WhisperX sem alinhamento de palavras: desce nos segmentos.
        for segment in data["segments"]:
            words = segment.get("words")
            if isinstance(words, list) and words:
                raw.extend(words)
            elif segment.get("start") is not None:
                raw.append(segment)

    out: list[dict] = []
    for item in raw:
        start = item.get("start")
        if start is None:
            continue
        text = (item.get("text") or item.get("word") or "").strip()
        if not text:
            continue
        start = float(start)
        end = float(item.get("end") or start)
        if end <= start:
            end = start + 0.12
        out.append({"text": text, "start": start, "end": end})
    out.sort(key=lambda w: w["start"])
    return out
