import type { ProjectMedia } from './shared';

// Escolha da midia que o preview exibe. O criterio e o estado real do
// projeto: dentro de edit/ e edicao/ estao os renders, e entre eles vence o
// mais recente, porque cada passagem (correcao, Fase 2) substitui a anterior.
// Nome de arquivo so serve para separar rascunho de resultado.

// Pastas onde o agente grava o resultado da edicao. Fora delas esta o
// material de origem, que nunca deve virar preview automaticamente.
export const editDirectories = new Set(['edit', 'edicao', 'edição']);

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
    return /^(final|resultado|render)/u.test(base) ? 2 : 1;
  }
  return intermediatePattern.test(base) ? 2 : 3;
}

export function mediaKind(relativePath: string, tier: number): ProjectMedia['kind'] {
  const normalized = normalize(relativePath);
  const base = basenameOf(normalized);
  if (tier <= 1) return 'source';
  if (/^(final|resultado|render)/u.test(base) || /(^|\/)fase[_-]?2(\/|$)/u.test(normalized)) {
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
