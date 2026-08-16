// Smoke test da escolha da midia do preview. O caso principal e o do projeto
// real "teste edvid desktop", onde a Fase 2 ficava invisivel porque o corte
// limpo vencia por nome.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-media-test-'));

try {
  execFileSync(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(projectRoot, 'src', 'media-selection.ts'),
      '--target', 'es2022',
      '--module', 'es2022',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
      '--outDir', outDir,
    ],
    { stdio: 'inherit' },
  );

  const { mediaKind, mediaMimeType, mediaTier, pickPreviewMedia, resolveByteRange } = await import(
    pathToFileURL(path.join(outDir, 'media-selection.js')).href
  );

  const kindOf = (relativePath) => mediaKind(relativePath, mediaTier(relativePath));

  // --- Caso real: projeto "teste edvid desktop" apos aplicar a Fase 2 -------
  // Antes da correcao o preview travava em corte_limpo_v2.mp4.
  const projetoReal = [
    { relativePath: 'Vídeo exemplo.mp4', modifiedAt: Date.parse('2025-07-19T10:55:00Z') },
    { relativePath: 'edicao/corte_limpo/corte_limpo_v1.mp4', modifiedAt: Date.parse('2026-08-15T18:42:00Z') },
    { relativePath: 'edicao/corte_limpo/corte_limpo_v2.mp4', modifiedAt: Date.parse('2026-08-15T21:19:00Z') },
    { relativePath: 'edicao/fase_2/corte_aprovado_sem_estilo.mp4', modifiedAt: Date.parse('2026-08-16T11:56:00Z') },
    { relativePath: 'edicao/fase_2/preview_fase2.mp4', modifiedAt: Date.parse('2026-08-16T11:57:00Z') },
    { relativePath: 'edit/preview.mp4', modifiedAt: Date.parse('2026-08-16T11:57:00Z') },
  ];
  const escolhido = pickPreviewMedia(projetoReal);
  assert.equal(escolhido.relativePath, 'edicao/fase_2/preview_fase2.mp4');
  assert.equal(kindOf(escolhido.relativePath), 'final');

  // O corte sem estilo e um intermediario, mesmo sendo quase tao recente.
  assert.equal(mediaTier('edicao/fase_2/corte_aprovado_sem_estilo.mp4'), 2);
  assert.ok(
    mediaTier('edicao/fase_2/preview_fase2.mp4') > mediaTier('edicao/fase_2/corte_aprovado_sem_estilo.mp4'),
  );

  // --- Pastas de edicao no topo do projeto contam (o bug do /edicao/) ------
  assert.equal(mediaTier('edicao/corte_limpo/corte_limpo_v2.mp4'), 3);
  assert.equal(mediaTier('edit/preview.mp4'), 3);
  assert.equal(mediaTier('projeto/edicao/render.mp4'), 3);

  // --- Fonte nunca sequestra o preview, nem sendo a mais recente ------------
  const fonteRecente = pickPreviewMedia([
    { relativePath: 'edicao/corte_limpo/corte_limpo_v1.mp4', modifiedAt: 1000 },
    { relativePath: 'Vídeo novo.mov', modifiedAt: 9_999_999 },
  ]);
  assert.equal(fonteRecente.relativePath, 'edicao/corte_limpo/corte_limpo_v1.mp4');
  assert.equal(kindOf('Vídeo novo.mov'), 'source');
  assert.equal(mediaTier('assets/b-roll.mp4'), 0);

  // --- Fase 1: correcao mais nova substitui o corte anterior ---------------
  const aposCorrecao = pickPreviewMedia([
    { relativePath: 'edicao/corte_limpo/corte_limpo_v1.mp4', modifiedAt: 1000 },
    { relativePath: 'edicao/corte_limpo/corte_limpo_v2.mp4', modifiedAt: 2000 },
  ]);
  assert.equal(aposCorrecao.relativePath, 'edicao/corte_limpo/corte_limpo_v2.mp4');
  assert.equal(kindOf('edicao/corte_limpo/corte_limpo_v2.mp4'), 'clean-cut');

  // --- Nome explicito de saida vale mesmo fora da pasta de edicao ----------
  assert.equal(mediaTier('final.mp4'), 2);
  assert.equal(kindOf('final.mp4'), 'final');
  assert.equal(mediaTier('gravacao.mp4'), 1);

  // --- Empate de horario prefere o caminho da fase mais avancada -----------
  const empate = pickPreviewMedia([
    { relativePath: 'edit/preview.mp4', modifiedAt: 5000 },
    { relativePath: 'edicao/fase_2/preview_fase2.mp4', modifiedAt: 5000 },
  ]);
  assert.equal(empate.relativePath, 'edicao/fase_2/preview_fase2.mp4');

  // --- Ranges do servidor de mídia: sem eles a agulha não busca -------------
  // O <video> pede "bytes=X-" para posicionar num arquivo grande; responder o
  // arquivo inteiro com 200 fazia o clique na timeline ser ignorado ou
  // reiniciar o vídeo do zero.
  const SIZE = 1000;
  assert.deepEqual(resolveByteRange(null, SIZE), { kind: 'full' });
  assert.deepEqual(resolveByteRange('bytes=0-', SIZE), { kind: 'partial', start: 0, end: 999 });
  assert.deepEqual(resolveByteRange('bytes=500-', SIZE), { kind: 'partial', start: 500, end: 999 });
  assert.deepEqual(resolveByteRange('bytes=10-19', SIZE), { kind: 'partial', start: 10, end: 19 });
  // Fim além do arquivo é aparado, como manda o RFC 9110.
  assert.deepEqual(resolveByteRange('bytes=900-5000', SIZE), { kind: 'partial', start: 900, end: 999 });
  // Sufixo: os últimos N bytes (o Chromium usa para achar o moov de mp4).
  assert.deepEqual(resolveByteRange('bytes=-100', SIZE), { kind: 'partial', start: 900, end: 999 });
  assert.deepEqual(resolveByteRange('bytes=-5000', SIZE), { kind: 'partial', start: 0, end: 999 });
  // Insatisfazíveis: início após o fim do arquivo, invertido ou malformado.
  for (const header of ['bytes=1000-', 'bytes=50-10', 'bytes=-', 'bytes=abc-', 'itens=0-1', 'bytes=-0']) {
    assert.deepEqual(resolveByteRange(header, SIZE), { kind: 'unsatisfiable' }, header);
  }

  assert.equal(mediaMimeType('.mp4'), 'video/mp4');
  assert.equal(mediaMimeType('.MOV'), 'video/quicktime');
  assert.equal(mediaMimeType('.webm'), 'video/webm');

  console.log('test:media-selection ok — Fase 2 vence o corte limpo, fontes e rascunhos ficam fora; ranges de mídia resolvidos por byte.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
