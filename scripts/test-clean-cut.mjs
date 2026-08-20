// Teste do cortador determinístico (helpers/clean_cut.py).
//
// O defeito que originou este teste, medido em fala real: o alinhador do
// WhisperX ESTICA a última palavra da frase por cima do silêncio, então quem
// procura pausa no intervalo entre palavras não vê pausa nenhuma. Uma pausa de
// 2 segundos passou batido e o corte saiu grosseiro ("muito burro", no relato
// do teste no Windows). Os casos abaixo travam a regra nova: quem manda é o
// silêncio do áudio.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helpers = path.join(projectRoot, 'resources', 'helpers');
const work = mkdtempSync(path.join(tmpdir(), 'edvid-clean-cut-'));

const packPython = path.join(
  projectRoot, 'resources', 'runtimes', `${process.platform}-${process.arch}`,
  'python-whisperx', 'python', process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'),
);
const python = process.env.EDVID_TEST_PYTHON ?? (existsSync(packPython) ? packPython : 'python3');

// Roda as funções puras do helper com silêncios e palavras fabricados: sem
// FFmpeg, sem modelo, em milissegundos.
function blocos({ words, silences, duration, minPause = 0.45, keep = 0.12, viaWords = false }) {
  const script = path.join(work, 'caso.py');
  writeFileSync(script, [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(helpers)})`,
    'from clean_cut import blocks_from_silences, blocks_from_words',
    `words = json.loads(${JSON.stringify(JSON.stringify(words))})`,
    `silences = [tuple(s) for s in json.loads(${JSON.stringify(JSON.stringify(silences))})]`,
    viaWords
      ? `out = blocks_from_words(words, ${duration}, ${minPause}, ${keep})`
      : `out = blocks_from_silences(words, silences, ${duration}, ${minPause}, ${keep})`,
    'print(json.dumps(out))',
  ].join('\n'));
  return JSON.parse(execFileSync(python, ['-B', script], { encoding: 'utf8' }));
}

const palavra = (text, start, end) => ({ text, start, end });

try {
  // --- Caso real medido: "longa." alinhada até 10.81 sobre um silêncio que
  // começa em 8.75. A pausa de 2s TEM de virar corte mesmo assim. ---
  const words = [
    palavra('Primeira', 0.03, 0.45), palavra('corte.', 1.75, 2.26),
    palavra('Segunda', 3.94, 4.34), palavra('seguida.', 5.40, 5.90),
    palavra('Terceira', 6.22, 6.76), palavra('longa.', 8.37, 10.81),
    palavra('Quarta', 10.83, 11.19), palavra('teste.', 12.46, 13.06),
  ];
  const silences = [[2.26, 3.93], [5.91, 6.23], [8.75, 10.78]];
  const resultado = blocos({ words, silences, duration: 13.04 });
  assert.equal(resultado.length, 3, 'as duas pausas longas viram corte, a curta não');
  const buracos = resultado.slice(1).map((bloco, index) => Number((bloco.start - resultado[index].end).toFixed(2)));
  assert.ok(buracos[0] > 1.2 && buracos[0] < 1.6, `pausa de 1,5s mal removida: ${buracos[0]}`);
  assert.ok(buracos[1] > 1.6 && buracos[1] < 2.1, `pausa de 2,0s mal removida: ${buracos[1]}`);
  // A respiração fica dentro do silêncio: nunca corta rente à sílaba.
  assert.ok(resultado[0].end > 2.26, 'faltou respiração no fim do bloco');
  assert.ok(resultado[1].start < 3.93, 'faltou respiração no início do bloco');
  // Nenhum bloco invade o silêncio inteiro nem sai do arquivo.
  assert.ok(resultado.at(-1).end <= 13.04, 'bloco passou do fim do arquivo');

  // --- Silêncio sem palavra nenhuma (batida de mesa, respiração solta) não
  // vira bloco. ---
  const soRuido = blocos({
    words: [palavra('oi', 5.0, 5.4)],
    silences: [[0.0, 4.5], [5.6, 9.0]],
    duration: 9.0,
  });
  assert.equal(soRuido.length, 1, 'só o trecho com fala sobrevive');
  assert.ok(soRuido[0].start > 4.0 && soRuido[0].end < 6.2, `bloco fora do lugar: ${JSON.stringify(soRuido[0])}`);

  // --- Sem silêncio nenhum: um bloco só, o arquivo inteiro. ---
  const semPausa = blocos({
    words: [palavra('fala', 0.2, 3.0)],
    silences: [],
    duration: 3.2,
  });
  assert.equal(semPausa.length, 1);
  assert.equal(semPausa[0].start, 0);

  // --- Pausas curtas nunca cortam, mesmo em série. ---
  const curtas = blocos({
    words: [palavra('a', 0.1, 0.5), palavra('b', 1.0, 1.4), palavra('c', 1.9, 2.3)],
    silences: [[0.5, 0.99], [1.4, 1.89]],
    duration: 2.5,
    minPause: 0.6,
  });
  assert.equal(curtas.length, 1, 'pausas abaixo do limiar não cortam');

  // --- Plano B (sem análise de áudio): ainda separa pelos intervalos. ---
  const fallback = blocos({
    words: [palavra('a', 0.1, 0.5), palavra('b', 2.0, 2.4)],
    silences: [],
    duration: 2.6,
    viaWords: true,
  });
  assert.equal(fallback.length, 2, 'plano B separa pelo intervalo entre palavras');

  console.log('test:clean-cut ok — silêncio manda sobre o alinhamento, respiração preservada, ruído sem fala descartado.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
