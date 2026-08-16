// Smoke test dos helpers da Fase 2. O defeito que originou este teste: os
// helpers vieram da skill esperando a transcricao do transcribe.py, enquanto o
// Desktop transcreve com o WhisperX empacotado, que usa outro schema. O
// resultado eram zero palavras, em silencio, e o agente inventava o JSON.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helpers = path.join(projectRoot, 'resources', 'helpers');
const work = mkdtempSync(path.join(tmpdir(), 'edvid-helpers-'));
const python = process.env.EDVID_TEST_PYTHON ?? 'python3';

const palavras = [
  ['Esse', 0.473, 0.594], ['aqui', 0.634, 0.855], ['é', 0.996, 1.036],
  ['o', 1.056, 1.096], ['resultado', 1.116, 1.658], ['de', 1.698, 1.779],
  ['um', 1.799, 1.879], ['kit', 1.919, 2.121], ['básico', 2.161, 2.583],
  ['de', 2.623, 2.704], ['iluminação', 2.744, 3.246],
];

// Os dois formatos que os helpers precisam aceitar.
const formatos = {
  // WhisperX empacotado: segments[].words[] com a chave "word".
  whisperx: {
    segments: [
      {
        start: palavras[0][1],
        end: palavras.at(-1)[2],
        text: palavras.map(([t]) => t).join(' '),
        words: palavras.map(([word, start, end]) => ({ word, start, end, score: 0.9 })),
      },
    ],
    language: 'pt',
  },
  // Skill (transcribe.py): lista plana no topo, com "type" e "text".
  skill: {
    words: palavras.map(([text, start, end]) => ({ type: 'word', text, start, end })),
  },
};

function run(script, args) {
  return execFileSync(python, [path.join(helpers, script), ...args], { encoding: 'utf8' });
}

try {
  const resultados = {};
  for (const [nome, transcricao] of Object.entries(formatos)) {
    const entrada = path.join(work, `${nome}.json`);
    writeFileSync(entrada, JSON.stringify(transcricao));

    const captions = path.join(work, `${nome}-captions.json`);
    run('captions_for_remotion.py', ['--transcript', entrada, '-o', captions]);
    const caps = JSON.parse(readFileSync(captions, 'utf8'));
    assert.equal(caps.length, palavras.length, `${nome}: contagem de palavras`);
    assert.equal(caps[0].text, 'Esse');
    assert.equal(caps[0].startMs, 473);
    assert.equal(caps[0].endMs, 594);
    // A forma exigida pelo @remotion/captions.
    for (const key of ['text', 'startMs', 'endMs', 'timestampMs', 'confidence']) {
      assert.ok(key in caps[0], `${nome}: falta ${key}`);
    }
    assert.ok(caps.every((c, i) => i === 0 || c.startMs >= caps[i - 1].startMs), 'ordenado');

    const cues = path.join(work, `${nome}-cues.json`);
    run('caption_style.py', ['--transcript', entrada, '-o', cues, '--lang', 'pt']);
    const parsed = JSON.parse(readFileSync(cues, 'utf8'));
    assert.ok(parsed.length > 0, `${nome}: nenhuma cue gerada`);
    for (const cue of parsed) {
      assert.ok(['STACK_MIXED', 'SOLO_BIG', 'SOLO_OUTLINE'].includes(cue.preset));
      assert.ok(['blur_up', 'abrupt'].includes(cue.exit));
      assert.ok(Array.isArray(cue.lines) && cue.lines.length > 0);
    }
    resultados[nome] = { caps: caps.length, cues: parsed.length };
  }

  // O ponto central: os dois formatos descrevem a mesma fala, entao precisam
  // produzir exatamente o mesmo resultado.
  assert.deepEqual(
    resultados.whisperx,
    resultados.skill,
    'WhisperX e skill deveriam gerar o mesmo numero de legendas e cues',
  );

  // Transcricao vazia nao pode explodir: o template ja traz um captions.json
  // vazio e o render precisa seguir.
  const vazio = path.join(work, 'vazio.json');
  writeFileSync(vazio, JSON.stringify({ segments: [] }));
  run('captions_for_remotion.py', ['--transcript', vazio, '-o', path.join(work, 'v.json')]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(work, 'v.json'), 'utf8')), []);

  // --- segments.json: o zoom por corte depende de precisão de frame ---------
  // Somar os segundos do EDL acumula erro porque o ffmpeg arredonda cada
  // segmento para frame inteiro. O helper acumula em frames.
  const fps = 30;
  const duracoes = [1.017, 2.049, 0.733, 3.011, 0.517];
  const edl = {
    ranges: duracoes.map((d, i) => ({ start: i * 10, end: i * 10 + d })),
  };
  const edlPath = path.join(work, 'edl.json');
  writeFileSync(edlPath, JSON.stringify(edl));
  const segPath = path.join(work, 'segments.json');
  run('segments_for_remotion.py', ['--edl', edlPath, '--fps', String(fps), '-o', segPath]);
  const { segments } = JSON.parse(readFileSync(segPath, 'utf8'));

  assert.equal(segments.length, duracoes.length);
  assert.equal(segments[0].start, 0);
  // Cada limite cai exatamente sobre um frame.
  for (const segment of segments) {
    for (const value of [segment.start, segment.dur]) {
      const frames = value * fps;
      assert.ok(Math.abs(frames - Math.round(frames)) < 1e-6, `${value}s não é múltiplo de frame`);
    }
  }
  // Contíguos: o início de um corte é o fim do anterior.
  for (let i = 1; i < segments.length; i += 1) {
    const fim = segments[i - 1].start + segments[i - 1].dur;
    assert.ok(Math.abs(segments[i].start - fim) < 1e-6, 'há buraco entre os cortes');
  }
  // O ponto do teste: o resultado difere da soma ingênua, e para mais.
  const somaIngenua = duracoes.slice(0, -1).reduce((a, b) => a + b, 0);
  const desvio = segments.at(-1).start - somaIngenua;
  assert.ok(desvio > 0.02, `esperava desvio da soma ingênua, obtive ${desvio}s`);

  // Sem --fps o modo EDL precisa falhar, em vez de inventar um valor.
  assert.throws(
    () => run('segments_for_remotion.py', ['--edl', edlPath, '-o', path.join(work, 'x.json')]),
    'deveria exigir --fps',
  );

  console.log(
    `test:helpers ok — ${resultados.whisperx.caps} legendas e ${resultados.whisperx.cues} cues iguais nos dois formatos; ` +
      `segments.json alinhado a frame (${Math.round(desvio * 1000)} ms à frente da soma ingênua em ${duracoes.length} cortes).`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
