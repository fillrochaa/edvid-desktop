// Teste da organização da pasta do projeto.
//
// Três defeitos de origem, todos vistos em máquina real:
//   1. Abrir um projeto em disco externo morria com "moov atom not found" em
//      "._IMG_6342.MOV" — o arquivo-par que o macOS grava em volume exFAT.
//      A mesma pasta no disco interno abria, porque lá esses arquivos nem
//      existem.
//   2. O projeto espalhava três pastas na raiz (edit, edicao, transcricao_raw).
//   3. edicao/fase_2 tinha 26 renders e 543 MB, porque nada era apagado.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-layout-'));

// Compila a PARTIR do src, para o teste medir o código que roda de verdade
// (media-selection importa ./shared, que só existe lá).
async function compile(file) {
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(projectRoot, 'src', file),
    '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  return import(pathToFileURL(path.join(outDir, file.replace(/\.ts$/u, '.js'))).href);
}

try {
  const layout = await compile('project-layout.ts');
  const selection = await compile('media-selection.ts');

  // --- 1. O arquivo que derrubava o projeto em disco externo ---------------
  assert.equal(
    selection.isMediaFileName('._IMG_6342.MOV'),
    false,
    'o par AppleDouble do macOS NUNCA pode entrar como vídeo',
  );
  assert.equal(selection.isMediaFileName('.DS_Store'), false);
  assert.equal(selection.isMediaFileName('.hidden.mp4'), false);
  // E o arquivo de verdade continua entrando — inclusive o que tem ponto no
  // meio do nome, que é comum em export de câmera.
  assert.equal(selection.isMediaFileName('IMG_6342.MOV'), true);
  assert.equal(selection.isMediaFileName('corte.v2.final.mp4'), true);

  // --- 2. O vídeo final mora na raiz e é reconhecido como resultado --------
  assert.equal(layout.finalVideoName('teste11'), 'teste11_final.mp4');
  assert.equal(layout.finalVideoName('Palestra Edição'), 'Palestra Edição_final.mp4');
  // Nome que o Windows recusaria não pode virar arquivo.
  assert.equal(layout.finalVideoName('a/b:c*d'), 'abcd_final.mp4');
  assert.equal(layout.finalVideoName('  espaço no fim  '), 'espaço no fim_final.mp4');
  assert.equal(layout.finalVideoName(''), 'projeto_final.mp4');

  // Na raiz, o final vence o material de origem — senão o preview abriria o
  // vídeo bruto do aluno em vez do resultado.
  const tierFinal = selection.mediaTier('teste11_final.mp4');
  const tierFonte = selection.mediaTier('teste11.MOV');
  assert.ok(tierFinal > tierFonte, 'o final da raiz precisa ganhar da fonte');
  assert.equal(selection.mediaKind('teste11_final.mp4', tierFinal), 'final');
  // Mas o render versionado dentro de edit/ ainda é a referência mais fresca.
  assert.ok(
    selection.mediaTier(path.join('edit', 'fase_2', 'fase_2_v9.mp4')) >= tierFinal,
    'o render em edit/ não pode perder para a cópia da raiz',
  );

  // --- 3. Poda: fica o atual e três anteriores -----------------------------
  const vinteSeis = Array.from({ length: 26 }, (_, i) => `fase_2_v${i + 1}.mp4`);
  const apagar = layout.rendersToDelete(vinteSeis);
  assert.equal(apagar.length, 22, 'de 26 versões, sobram 4');
  const sobra = vinteSeis.filter((name) => !apagar.includes(name));
  assert.deepEqual(sobra, ['fase_2_v23.mp4', 'fase_2_v24.mp4', 'fase_2_v25.mp4', 'fase_2_v26.mp4']);

  // Ordena por NÚMERO, não por texto: v9 é mais nova que v10 em ordem
  // alfabética, e apagar a errada perderia justamente o render atual.
  const foraDeOrdem = ['fase_2_v9.mp4', 'fase_2_v10.mp4', 'fase_2_v11.mp4', 'fase_2_v2.mp4', 'fase_2_v12.mp4'];
  assert.deepEqual(layout.rendersToDelete(foraDeOrdem), ['fase_2_v2.mp4']);

  // Nada que não seja render é tocado.
  const misturado = ['fase_2_v1.mp4', 'fase_2_v2.mp4', 'fase_2_v3.mp4', 'fase_2_v4.mp4', 'fase_2_v5.mp4', 'briefing.json', 'anotacao.txt', 'meu_video.mp4'];
  assert.deepEqual(layout.rendersToDelete(misturado), ['fase_2_v1.mp4']);

  // O arquivo protegido (o que o carimbo aponta) nunca sai, mesmo velho.
  assert.deepEqual(layout.rendersToDelete(vinteSeis, 4, 'fase_2_v1.mp4').includes('fase_2_v1.mp4'), false);
  // Poucos arquivos: não apaga nada.
  assert.deepEqual(layout.rendersToDelete(['fase_2_v1.mp4', 'fase_2_v2.mp4']), []);
  assert.deepEqual(layout.rendersToDelete([]), []);

  // --- 4. A numeração não pode reaproveitar versão já usada ----------------
  // Contar arquivos era o jeito antigo. Com os velhos apagados, contar daria
  // 5 de novo e o render sobrescreveria uma versão que o carimbo aponta.
  assert.equal(layout.nextRenderVersion(sobra), 27);
  assert.equal(layout.nextRenderVersion([]), 1);
  assert.equal(layout.nextRenderVersion(['briefing.json']), 1);

  // --- 5. As pastas antigas têm destino dentro de edit/ --------------------
  const destinos = layout.LEGACY_MOVES.map((move) => move.to.join('/'));
  assert.ok(destinos.every((to) => to.startsWith(`${layout.EDIT_DIR}/`)), 'tudo vai para dentro de edit/');
  const origens = layout.LEGACY_MOVES.map((move) => move.from.join('/'));
  assert.ok(origens.includes('edicao/fase_2'));
  assert.ok(origens.includes('transcricao_raw'));

  console.log('test:project-layout ok — arquivo-par do macOS fora, final na raiz e só 4 renders guardados.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
