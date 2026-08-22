// Teste do pedido de trilha derivado da transcrição.
//
// O primeiro pedido era uma frase fixa — "instrumental leve e moderno, sem
// vocal" — que serve para qualquer vídeo e por isso não serve para nenhum.
// Aqui o clima sai do que o vídeo diz.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-music-'));

try {
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(projectRoot, 'src', 'music-brief.ts'),
    '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const { SOUNDTRACK_VOLUME, detectTheme, energyFor, musicBrief, normalize } = await import(
    pathToFileURL(path.join(outDir, 'music-brief.js')).href
  );

  // --- 1. Volume ------------------------------------------------------------
  // Era 0,0445 (-27 dB) e o pedido foi subir 5 dB. -10 dB absoluto seria 0,316,
  // sete vezes mais alto que antes, disputando com a voz.
  const dB = (v) => 20 * Math.log10(v);
  assert.ok(Math.abs(dB(SOUNDTRACK_VOLUME) - dB(0.0445) - 5) < 0.1, 'a trilha tem de subir exatamente 5 dB');
  assert.ok(SOUNDTRACK_VOLUME < 0.15, 'acima disso a música briga com a fala');

  // --- 2. Assunto vindo da fala --------------------------------------------
  // Texto real do vídeo do aluno.
  const iphone = 'Falta menos de 20 dias para os lançamentos dos novos iPhones e eu vou te falar todas as novidades. O design dos iPhones 18 Pro vem com cores novas e o processador A20 Pro tem mais desempenho na câmera.';
  assert.equal(detectTheme(normalize(iphone)), 'tecnologia');
  const dinheiro = 'O preço subiu por causa do dólar e dos impostos. O aumento no custo chega ao cliente e o mercado sente. Cada empresa repassa esse aumento.';
  assert.equal(detectTheme(normalize(dinheiro)), 'negocios');
  const aula = 'Vou te ensinar o passo a passo. Primeira dica: entenda o método antes. Nesta aula você vai aprender com um exemplo.';
  assert.equal(detectTheme(normalize(aula)), 'ensino');
  // Sem assunto reconhecido não inventa tema: um "eu" solto não faz drama.
  assert.equal(detectTheme(normalize('Bom dia, tudo certo por aqui, eu acho.')), '');

  // Acento e maiúscula não podem atrapalhar o reconhecimento.
  assert.deepEqual(normalize('Câmera ÓTIMA!'), ['camera', 'otima']);

  // --- 3. Energia medida no ritmo da fala ----------------------------------
  assert.ok(/120 BPM/u.test(energyFor(300, 100)), 'fala rápida pede batida mais viva');
  assert.ok(/85 BPM/u.test(energyFor(150, 100)), 'fala pausada pede espaço');
  assert.ok(/100 BPM/u.test(energyFor(230, 100)));
  // Vídeo sem fala não divide por zero.
  assert.ok(energyFor(0, 0).length > 0);

  // --- 4. O pedido inteiro --------------------------------------------------
  const brief = musicBrief(iphone, 91);
  assert.ok(brief.includes('91 second'), `duração no pedido: ${brief}`);
  assert.ok(/synth|electronic/iu.test(brief), `tema não chegou ao pedido: ${brief}`);
  // A regra que impede o modelo de entregar música de primeiro plano.
  assert.ok(/no vocals/iu.test(brief) && /under a speaking voice/iu.test(brief));
  assert.ok(/no sudden drops/iu.test(brief), 'drop no meio da fala arruína o vídeo');
  // Dois vídeos de assuntos diferentes NÃO podem receber o mesmo pedido —
  // era exatamente o defeito do texto fixo.
  assert.notEqual(musicBrief(iphone, 91), musicBrief(dinheiro, 91));
  // E o mesmo vídeo sempre gera o mesmo pedido.
  assert.equal(musicBrief(iphone, 91), musicBrief(iphone, 91));
  // Sem transcrição ainda sai um pedido utilizável.
  assert.ok(musicBrief('', 30).length > 60);

  console.log('test:music-brief ok — clima vem da fala, energia do ritmo e a trilha sobe 5 dB.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
