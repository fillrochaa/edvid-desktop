// Teste da TELA DIVIDIDA: onde fica a divisa, o que cada lado recebe e se o
// app pede a imagem no formato da faixa que ela vai ocupar.
//
// Defeito de origem: a divisa era height/2. No render real a arte comia metade
// do apresentador e o aluno marcou no proprio quadro onde ela devia estar — a
// marca caiu em 0,39 da altura. Como o app (que pede a imagem) e o template
// (que monta o quadro) sao projetos separados, a constante vive nos dois e
// este teste e o que impede que elas se separem.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-split-'));

try {
  // A geometria vive no Main.tsx do template (que importa Remotion e nao roda
  // aqui); compila-se uma copia isolada dela, corpo identico ao de producao.
  const mainSource = readFileSync(
    path.join(projectRoot, 'resources', 'remotion-template', 'src', 'Main.tsx'),
    'utf8',
  );
  const start = mainSource.indexOf('const clamp = (v: number');
  const end = mainSource.indexOf('// Volume unico do whoosh', start);
  assert.ok(start > 0 && end > start, 'o bloco da geometria precisa existir no Main.tsx');
  const arquivo = path.join(outDir, 'geom.ts');
  writeFileSync(arquivo, mainSource.slice(start, end));
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    arquivo, '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const { SPLIT_DIVIDER, splitGeometry } = await import(pathToFileURL(path.join(outDir, 'geom.js')).href);

  const H = 1920;

  // 1. A divisa NAO fica no meio — a regressao que o aluno viu no video.
  assert.notEqual(SPLIT_DIVIDER, 0.5, 'divisa no meio e o defeito, nao o padrao');
  assert.ok(Math.abs(SPLIT_DIVIDER - 0.39) < 1e-9, 'a marca do aluno caiu em 0,39 da altura');

  // 2. Arte em cima: faixa curta em cima, apresentador na longa embaixo.
  const topo = splitGeometry(H, 'top', undefined, undefined);
  assert.equal(topo.seam, 749);
  assert.equal(topo.mediaTop, 0);
  assert.equal(topo.mediaHeight, 749);
  assert.equal(topo.videoTop, 749);
  assert.equal(topo.videoHeight, H - 749);

  // 3. Invertida: O CORTE FICA NO MESMO LUGAR. So troca quem ocupa cada lado.
  const base = splitGeometry(H, 'bottom', undefined, undefined);
  assert.equal(base.seam, topo.seam, 'a divisa nao pode mudar de altura ao inverter');
  assert.equal(base.videoTop, 0, 'invertida: o apresentador vai para cima');
  assert.equal(base.videoHeight, 749, 'invertida: o apresentador fica na faixa curta');
  assert.equal(base.mediaTop, 749);
  assert.equal(base.mediaHeight, H - 749);

  // 4. As duas faixas somam o quadro inteiro, sem sobra nem buraco preto.
  for (const g of [topo, base]) {
    assert.equal(g.mediaHeight + g.videoHeight, H);
  }

  // 5. O recorte do video nunca passa do fim da fonte (barra preta no pe).
  for (const [g, nome] of [[topo, 'arte em cima'], [base, 'arte embaixo']]) {
    const visivelAte = -g.videoOffset + g.videoHeight;
    assert.ok(visivelAte <= H + 1, `${nome}: o recorte saiu da fonte (${visivelAte})`);
  }
  // O recorte comeca no MESMO ponto nas duas faixas: a cabeca fica no mesmo
  // lugar da fonte, entao o que precisa ser constante e a folga acima dela.
  assert.equal(topo.videoOffset, base.videoOffset, 'a folga acima da cabeca e a mesma nas duas montagens');

  // E a cabeca cabe inteira nas duas. Os limites saem de medir o cut.mp4 do
  // aluno: topo do cabelo em 0,23 da altura e queixo em 0,53. Centrar cada
  // faixa no proprio meio passava neste ponto e mesmo assim cortava a testa —
  // por isso a medida esta aqui, e nao a regra que a produziu.
  const CABECA = { topo: 0.23, queixo: 0.53 };
  for (const [g, nome] of [[topo, 'arte em cima'], [base, 'arte embaixo']]) {
    const inicio = -g.videoOffset / H;
    const fim = inicio + g.videoHeight / H;
    assert.ok(inicio <= CABECA.topo, `${nome}: o recorte corta a testa (comeca em ${inicio})`);
    assert.ok(fim >= CABECA.queixo, `${nome}: o recorte corta o queixo (termina em ${fim})`);
  }

  // 6. Um divider explicito do aluno vale, mas dentro de limites sadios.
  assert.equal(splitGeometry(H, 'top', undefined, 0.5).seam, 960);
  assert.equal(splitGeometry(H, 'top', undefined, 0.01).seam, Math.round(H * 0.15));
  assert.equal(splitGeometry(H, 'top', undefined, 9).seam, Math.round(H * 0.85));

  // 7. App e template falam da MESMA divisa.
  const appModule = path.join(outDir, 'image-format.ts');
  writeFileSync(appModule, readFileSync(path.join(projectRoot, 'src', 'image-format.ts'), 'utf8'));
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    appModule, '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const fmt = await import(pathToFileURL(path.join(outDir, 'image-format.js')).href);
  assert.equal(
    fmt.SPLIT_DIVIDER,
    SPLIT_DIVIDER,
    'a divisa do app saiu da divisa do template: a imagem seria pedida no formato errado',
  );

  // 8. Cada faixa pede a imagem NA PROPORCAO DELA — o pedido do aluno.
  const aspectoTopo = 1080 / topo.mediaHeight;
  const aspectoBase = 1080 / base.mediaHeight;
  assert.ok(Math.abs(fmt.bandAspect('tela-dividida') - aspectoTopo) < 0.01, 'faixa de cima');
  assert.ok(Math.abs(fmt.bandAspect('tela-dividida-base') - aspectoBase) < 0.01, 'faixa de baixo');
  // As duas faixas NAO tem o mesmo formato: pedir igual foi o defeito.
  assert.ok(fmt.bandAspect('tela-dividida') > 1 && fmt.bandAspect('tela-dividida-base') < 1);
  assert.equal(fmt.openAiSize(fmt.imageUse('tela-dividida')), '1536x1024');
  assert.equal(fmt.openAiSize(fmt.imageUse('tela-dividida-base')), '1024x1024');
  assert.equal(fmt.geminiAspect(fmt.imageUse('tela-dividida')), '3:2');
  assert.equal(fmt.openAiSize(fmt.imageUse('9:16')), '1024x1536');
  // Vocabulario antigo continua valendo: pedidos.json de projetos anteriores.
  assert.equal(fmt.imageUse('4:3'), 'tela-dividida');
  assert.equal(fmt.imageUse('inventado'), null);

  // 9. O tamanho livre (Cloudflare) sai em multiplo de 8 e no formato da faixa.
  for (const uso of ['tela-dividida', 'tela-dividida-base', 'tela-cheia', 'paisagem', 'quadrada']) {
    const { width, height } = fmt.pixelSize(uso);
    assert.equal(width % 8, 0, `${uso}: largura precisa ser multiplo de 8`);
    assert.equal(height % 8, 0, `${uso}: altura precisa ser multiplo de 8`);
    assert.ok(Math.max(width, height) <= 1536 && Math.min(width, height) >= 256, `${uso}: fora dos limites`);
    assert.ok(Math.abs(width / height - fmt.bandAspect(uso)) < 0.02, `${uso}: formato errado`);
  }

  // 10. O enquadramento vai escrito no prompt: e o que o modelo obedece.
  assert.ok(fmt.promptWithFraming('a cat', 'tela-dividida').includes('Wide horizontal'));
  assert.equal(fmt.promptWithFraming('a cat', null), 'a cat');

  console.log('test:split-layout ok — divisa em 0,39, igual nas duas montagens, e imagem no formato da faixa.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
