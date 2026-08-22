// Teste dos dados da Fase 2 escritos pelo aplicativo.
//
// Três defeitos vistos no vídeo renderizado do aluno, todos nesta etapa:
//   1. A legenda saiu "muito pequena e muito embaixo". Causa: eu escrevia a
//      composição com o tamanho do ARQUIVO (o corte dele era 4K), e todos os
//      padrões do template são calibrados para 1080x1920 — no dobro da
//      resolução a fonte 61 vira 30 e a margem 420 vira metade.
//   2. A headline não apareceu: sem texto escrito eu desligava o gancho.
//   3. A trilha não foi gerada: numa edição limpa o agente nem é chamado, e
//      era ele quem pedia a música.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-phase2-'));

try {
  const source = readFileSync(path.join(projectRoot, 'src', 'main.ts'), 'utf8');

  // --- 1. A COMPOSIÇÃO É FIXA -----------------------------------------------
  // Guardado no código, porque é uma decisão que "parece errada": medir o
  // arquivo soa mais correto e é justamente o que quebrou a legenda.
  const build = source.slice(source.indexOf('async function buildPhase2'));
  const corpo = build.slice(0, build.indexOf('\nasync function ', 10));
  assert.ok(/const width = 1080;/u.test(corpo), 'a composição precisa ser 1080 de largura');
  assert.ok(/const height = 1920;/u.test(corpo), 'a composição precisa ser 1920 de altura');
  assert.ok(
    !/const width = \(rotated/u.test(corpo),
    'medir o tamanho do arquivo foi o defeito: a legenda saiu pela metade num corte 4K',
  );
  // E a trilha é pedida aqui, não pelo agente.
  assert.ok(/style\.elements\.musicAI/u.test(corpo), 'a trilha tem de ser pedida pelo próprio app');
  assert.ok(/pedidos\.json/u.test(corpo));

  // --- 2. A headline vem da fala de abertura --------------------------------
  const arquivo = path.join(outDir, 'opening.ts');
  const inicio = source.indexOf('export function openingLine');
  const fim = source.indexOf('\n// O edit-data.json', inicio);
  assert.ok(inicio > 0 && fim > inicio, 'openingLine precisa existir no main.ts');
  writeFileSync(arquivo, source.slice(inicio, fim));
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    arquivo, '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const { openingLine } = await import(pathToFileURL(path.join(outDir, 'opening.js')).href);

  // As palavras reais do vídeo do aluno, como saem do gerador de legendas.
  const fala = 'Falta menos de 20 dias para os lançamentos dos novos iPhones e eu vou te falar neste vídeo todas as novidades'
    .split(' ')
    .map((text, index) => ({ text, startMs: index * 200 }));
  const headline = openingLine(fala);
  assert.equal(headline.length, 2, 'a headline sai em duas linhas equilibradas');
  assert.ok(headline.join(' ').length <= 52, `headline longa demais: ${headline.join(' ')}`);
  assert.ok(headline[0].startsWith('Falta menos de'), `headline fora da fala: ${headline[0]}`);
  // Nunca o texto de exemplo do template, que já foi parar num vídeo real.
  assert.ok(!/HEADLINE LINHA/iu.test(headline.join(' ')));
  // Duas linhas de tamanho parecido: uma linha só estoura a largura segura.
  assert.ok(Math.abs(headline[0].length - headline[1].length) < 22, `linhas desequilibradas: ${JSON.stringify(headline)}`);
  // Pontuação não entra no meio da headline.
  assert.ok(!/[.,;:]$/u.test(headline[0]) && !/[.,;:]$/u.test(headline[1]));

  // Vídeo que começa com pouquíssima fala não ganha headline forçada.
  assert.deepEqual(openingLine([{ text: 'Oi', startMs: 0 }]), []);
  assert.deepEqual(openingLine([]), []);
  // Uma palavra gigante não estoura o limite.
  assert.deepEqual(openingLine([{ text: 'x'.repeat(80), startMs: 0 }]), []);

  console.log('test:phase2-data ok — composição fixa em 1080x1920, headline da própria fala e trilha pedida pelo app.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
