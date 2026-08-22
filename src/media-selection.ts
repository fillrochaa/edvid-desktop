import type { ProjectMedia } from './shared';

// Escolha da midia que o preview exibe. O criterio e o estado real do
// projeto: dentro de edit/ e edicao/ estao os renders, e entre eles vence o
// mais recente, porque cada passagem (correcao, Fase 2) substitui a anterior.
// Nome de arquivo so serve para separar rascunho de resultado.

// Pasta onde a edicao inteira mora. "edicao" continua na lista porque
// projetos criados antes da unificacao tem os renders la.
export const editDirectories = new Set(['edit', 'edicao', 'edição']);

// Arquivo que pode ser midia do projeto.
//
// O macOS grava um par "._nome" para cada arquivo em volume que nao seja APFS
// ou HFS+ (pendrive, HD externo em exFAT, rede). Esse par tem a extensao do
// original e ZERO video dentro: o ffprobe abre e responde "moov atom not
// found", e era isso que derrubava a abertura de projeto em disco externo —
// a mesma pasta copiada para o disco interno abria sem reclamar, porque la
// esses arquivos nao existem. Vale para .DS_Store e qualquer oculto.
export function isMediaFileName(name: string): boolean {
  return !name.startsWith('.');
}

// Nome de resultado: "final_x", "render 2" ou o video final do projeto, que
// leva o nome dele e termina em _final.
const finalName = /^(final|resultado|render)|[_-]final$/u;

export const intermediatePattern =
  /(^|[_-])(tmp|temp|proxy|sample|raw|bruto|parte|part|chunk|segmento|teste)([_-]|$)|sem[_-]?estilo/u;

export type MediaRanking = {
  relativePath: string;
  modifiedAt: number;
};

function normalize(relativePath: string): string {
  return relativePath.toLocaleLowerCase('pt-BR').replaceAll('\\', '/');
}

function basenameOf(normalized: string): string {
  const last = normalized.split('/').at(-1) ?? normalized;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

export function mediaTier(relativePath: string): number {
  const normalized = normalize(relativePath);
  const directories = normalized.split('/').slice(0, -1);
  const base = basenameOf(normalized);
  if (directories.includes('assets')) return 0;
  if (!directories.some((directory) => editDirectories.has(directory))) {
    // Fora da pasta de edicao so um nome explicito de saida conta como render.
    // O video final do projeto vive na raiz como "<projeto>_final.mp4", entao
    // o sufixo conta tanto quanto o prefixo.
    return finalName.test(base) ? 2 : 1;
  }
  return intermediatePattern.test(base) ? 2 : 3;
}

export function mediaKind(relativePath: string, tier: number): ProjectMedia['kind'] {
  const normalized = normalize(relativePath);
  const base = basenameOf(normalized);
  if (tier <= 1) return 'source';
  if (finalName.test(base) || /(^|\/)fase[_-]?2(\/|$)/u.test(normalized)) {
    return 'final';
  }
  return 'clean-cut';
}

// Empate de tier resolve pelo mais recente; empate de horario (uma copia feita
// no mesmo segundo) prefere o caminho que declara a fase mais avancada.
export function comparePreviewCandidates(a: MediaRanking, b: MediaRanking): number {
  const tierA = mediaTier(a.relativePath);
  const tierB = mediaTier(b.relativePath);
  if (tierA !== tierB) return tierB - tierA;
  if (a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt;
  const rank = (item: MediaRanking) => (mediaKind(item.relativePath, mediaTier(item.relativePath)) === 'final' ? 1 : 0);
  return rank(b) - rank(a);
}

export function pickPreviewMedia<T extends MediaRanking>(candidates: T[]): T | null {
  return [...candidates].sort(comparePreviewCandidates)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Serviço de mídia edvid-media://. O <video> só consegue posicionar a agulha
// num arquivo grande pedindo bytes do meio (Range). O net.fetch(file://) do
// Electron ignora o cabeçalho e devolve o arquivo inteiro com 200: em arquivos
// pequenos o Chromium bufferiza tudo e o seek "funciona"; num render de
// centenas de MB o clique na timeline era ignorado ou reiniciava do zero.
// ---------------------------------------------------------------------------

export type ByteRangeResolution =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

export function resolveByteRange(
  rangeHeader: string | null,
  size: number,
): ByteRangeResolution {
  if (!rangeHeader || size <= 0) return rangeHeader ? { kind: 'unsatisfiable' } : { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'unsatisfiable' };
  let start: number;
  let end: number;
  if (match[1] === '') {
    // Sufixo: os últimos N bytes.
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'partial', start, end };
}

export function mediaMimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    default:
      return 'application/octet-stream';
  }
}
