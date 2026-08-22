// Como a pasta do projeto e organizada. Modulo puro: so decide nomes e o que
// sobra, sem tocar em disco.
//
// Antes o projeto espalhava tres pastas na raiz — "edit", "edicao" e
// "transcricao_raw" — e o aluno tinha de saber qual era qual para achar o
// video. Agora tudo o que e trabalho fica em UMA pasta, "edit", e o unico
// arquivo que o aluno precisa ver na raiz e o resultado.

export const EDIT_DIR = 'edit';
export const RENDER_DIR = 'fase_2';

// Quantos renders ficam guardados, contando o atual. O de agora mais tres
// anteriores: o suficiente para voltar atras, e nao os 26 arquivos (543 MB)
// que um projeto real acumulou por nunca apagar nada.
export const KEEP_RENDERS = 4;

const RENDER_FILE = /^fase_2_v(\d+)\.mp4$/u;

export function renderVersion(fileName: string): number | null {
  const match = RENDER_FILE.exec(fileName);
  return match ? Number(match[1]) : null;
}

// Proximo numero de versao: um a mais que o maior que existe. Nao e a
// contagem de arquivos — com os antigos apagados, contar reescreveria uma
// versao ja usada e o preview mostraria o video errado.
export function nextRenderVersion(fileNames: readonly string[]): number {
  let highest = 0;
  for (const name of fileNames) {
    const version = renderVersion(name);
    if (version !== null && version > highest) highest = version;
  }
  return highest + 1;
}

// Quais renders podem sair. Guarda os mais novos por NUMERO de versao (data de
// arquivo muda ao copiar a pasta) e nunca mexe no que nao for render.
export function rendersToDelete(
  fileNames: readonly string[],
  keep = KEEP_RENDERS,
  protectedName?: string,
): string[] {
  const versions = fileNames
    .map((name) => ({ name, version: renderVersion(name) }))
    .filter((item): item is { name: string; version: number } => item.version !== null)
    .sort((a, b) => b.version - a.version);
  return versions
    .slice(Math.max(0, keep))
    .map((item) => item.name)
    .filter((name) => name !== protectedName);
}

// Nome do video final, na raiz do projeto. Leva o nome do projeto para o aluno
// reconhecer o arquivo fora do Edvid — no Finder, no Explorer, no upload.
export function finalVideoName(projectName: string): string {
  const clean = projectName
    // So o que o Windows proibe de verdade. Acento, espaco e hifen ficam:
    // o nome tem de ser reconhecivel no Finder e no Explorer.
    .replace(/[<>:"\/\\|?*\u0000-\u001f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    // Windows recusa nome terminado em ponto ou espaco.
    .replace(/[.\s]+$/u, '');
  return `${clean || 'projeto'}_final.mp4`;
}

// Pastas antigas na raiz e para onde vao dentro de edit/. "edicao/fase_2"
// entra como "edit/fase_2" porque e a mesma coisa com outro nome.
export const LEGACY_MOVES: ReadonlyArray<{ from: readonly string[]; to: readonly string[] }> = [
  { from: ['edicao', 'fase_2'], to: [EDIT_DIR, RENDER_DIR] },
  { from: ['transcricao_raw'], to: [EDIT_DIR, 'transcricao_raw'] },
  { from: ['transcrição_raw'], to: [EDIT_DIR, 'transcricao_raw'] },
];
