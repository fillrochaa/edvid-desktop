// Teste do plano do CORTE LIMPO feito pelo aplicativo.
//
// Defeito de origem: o corte era pedido ao agente. Medido no provedor gratuito
// do aluno, replicando o pedido real, o modelo NÃO agia em 13 de 20 tentativas
// — devolvia um tutorial de como editar vídeo na mão. Nada ali é criativo, é
// sempre a mesma sequência de comandos; então virou código.
//
// Este teste mede o plano (ordem, comandos, resumo). O caminho em disco é
// medido de verdade em test-clean-cut-live.mjs, que roda FFmpeg e WhisperX.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-cut-'));

try {
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(projectRoot, 'src', 'clean-cut.ts'),
    '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const {
    cleanCutArgs, cleanCutSummary, ffmpegCutArgs, orderSources, parseEdl, whisperxArgs,
  } = await import(pathToFileURL(path.join(outDir, 'clean-cut.js')).href);

  // --- 1. Ordem das fontes: a mesma da timeline ---------------------------
  // Ordem de texto puro colocaria cena10 antes de cena2 e o vídeo sairia
  // montado fora de ordem — sem erro nenhum, só errado.
  assert.deepEqual(
    orderSources(['cena10.mov', 'cena2.mov', 'cena1.mov']),
    ['cena1.mov', 'cena2.mov', 'cena10.mov'],
  );
  assert.deepEqual(orderSources(['B.MOV', 'a.mov']), ['a.mov', 'B.MOV']);

  // --- 2. Leitura do EDL --------------------------------------------------
  const edl = parseEdl({
    version: 1,
    sources: { 'a.mov': 'a.mov' },
    ranges: [
      { source: 'a.mov', beat: 'Bloco 01', start: 0, end: 4.5 },
      { source: 'a.mov', beat: 'Bloco 02', start: 7.7, end: 14.3 },
      { source: 'a.mov', beat: 'lixo', start: 5, end: 5 },
      { source: '', beat: 'sem fonte', start: 1, end: 2 },
    ],
    total_duration_s: 11.1,
  });
  assert.equal(edl.ranges.length, 2, 'bloco de duração zero e bloco sem fonte são descartados');
  assert.equal(parseEdl({ ranges: [] }), null, 'EDL sem bloco nenhum não é corte');
  assert.equal(parseEdl(null), null);
  // Sem total declarado, soma os blocos: o resumo depende disso.
  assert.ok(Math.abs(parseEdl({ ranges: [{ source: 'a', start: 0, end: 3 }] }).total_duration_s - 3) < 1e-9);

  // --- 3. O comando de corte ----------------------------------------------
  const args = ffmpegCutArgs({
    inputs: ['/p/a.mov'],
    ranges: edl.ranges,
    sourceIndex: { 'a.mov': 0 },
    output: '/p/edit/corte_limpo.mp4',
  });
  const filtro = args[args.indexOf('-filter_complex') + 1];
  // Um trim de vídeo E um de áudio por bloco, senão a fala dessincroniza.
  assert.equal((filtro.match(/\[0:v\]trim=/gu) ?? []).length, 2);
  assert.equal((filtro.match(/\[0:a\]atrim=/gu) ?? []).length, 2);
  assert.ok(filtro.includes('concat=n=2:v=1:a=1'));
  // setpts/asetpts em TODO bloco: sem isso o segundo bloco entra com o
  // carimbo de tempo do original e o vídeo congela na emenda.
  assert.equal((filtro.match(/setpts=PTS-STARTPTS/gu) ?? []).length, 4);
  // Reencoda: cópia de stream cortaria no keyframe, no meio da palavra.
  assert.ok(args.includes('libx264') && args.includes('-crf'));
  assert.ok(!args.includes('copy'), 'cópia de stream perderia a precisão do corte');
  assert.equal(args.at(-1), '/p/edit/corte_limpo.mp4');

  // Várias fontes: cada bloco puxa do input certo.
  const multi = ffmpegCutArgs({
    inputs: ['/p/a.mov', '/p/b.mov'],
    ranges: [
      { source: 'a.mov', beat: '1', start: 0, end: 2 },
      { source: 'b.mov', beat: '2', start: 1, end: 3 },
    ],
    sourceIndex: { 'a.mov': 0, 'b.mov': 1 },
    output: '/p/out.mp4',
  });
  const filtroMulti = multi[multi.indexOf('-filter_complex') + 1];
  assert.ok(filtroMulti.includes('[0:v]trim=start=0.000:end=2.000'));
  assert.ok(filtroMulti.includes('[1:v]trim=start=1.000:end=3.000'));

  // Erro claro em vez de comando quebrado.
  assert.throws(() => ffmpegCutArgs({ inputs: [], ranges: edl.ranges, sourceIndex: {}, output: 'o.mp4' }), /origem|cortar/iu);
  assert.throws(() => ffmpegCutArgs({ inputs: ['a'], ranges: [], sourceIndex: {}, output: 'o.mp4' }), /manter/iu);
  assert.throws(
    () => ffmpegCutArgs({ inputs: ['a'], ranges: [{ source: 'x.mov', beat: '1', start: 0, end: 1 }], sourceIndex: {}, output: 'o.mp4' }),
    /desconhecida/iu,
  );

  // --- 4. Transcrição: offline, em português, com alinhamento -------------
  const wx = whisperxArgs({ media: '/p/a.mov', model: 'small', outputDirectory: '/p/edit/transcricao_raw' });
  assert.ok(wx.includes('whisperx') && wx.includes('--language') && wx[wx.indexOf('--language') + 1] === 'pt');
  assert.equal(wx[wx.indexOf('--output_format') + 1], 'json');
  // --no_align mataria o corte: sem tempo por palavra o helper não decide nada.
  assert.ok(!wx.includes('--no_align'), 'o corte depende do alinhamento por palavra');

  // --- 5. Helper de corte: um trio por arquivo, na ordem ------------------
  const cc = cleanCutArgs({
    helper: '/h/clean_cut.py',
    files: [
      { transcript: '/t/a.json', media: '/p/a.mov', source: 'a.mov' },
      { transcript: '/t/b.json', media: '/p/b.mov', source: 'b.mov' },
    ],
    output: '/p/edit/edl.json',
  });
  assert.equal((cc.filter((a) => a === '--transcript')).length, 2);
  assert.equal((cc.filter((a) => a === '--audio')).length, 2);
  assert.equal((cc.filter((a) => a === '--source')).length, 2);
  // A ordem importa: o helper casa transcript/audio/source por posição.
  assert.ok(cc.indexOf('/t/a.json') < cc.indexOf('/t/b.json'));
  assert.equal(cc[cc.indexOf('-o') + 1], '/p/edit/edl.json');

  // --- 6. O resumo que o aluno lê -----------------------------------------
  const resumo = cleanCutSummary({ ranges: new Array(12).fill({ source: 'a', beat: '', start: 0, end: 1 }), total_duration_s: 127, sources: {}, version: 1 }, 175);
  assert.ok(resumo.includes('12 blocos'));
  assert.ok(/2min 07s/u.test(resumo), `duração final legível: ${resumo}`);
  assert.ok(/27%|28%/u.test(resumo), `percentual removido: ${resumo}`);
  // Precisa disparar o portão de aprovação da interface, que procura
  // "corte" + "aprove" no texto. Sem isso o aluno fica sem o botão.
  assert.ok(/\bcorte\b/iu.test(resumo) && /\baprove\b/iu.test(resumo), 'o resumo abre o gate de aprovação');
  // Nada de nome de arquivo nem termo técnico na conversa.
  assert.ok(!/\.mp4|ffmpeg|whisperx|edl/iu.test(resumo), `termo técnico no resumo: ${resumo}`);
  // Um bloco só não pode sair como "1 blocos".
  assert.ok(cleanCutSummary({ ranges: [{ source: 'a', beat: '', start: 0, end: 5 }], total_duration_s: 5, sources: {}, version: 1 }, 10).includes('1 bloco de fala'));

  console.log('test:clean-cut-pipeline ok — ordem natural, trim por bloco com áudio junto e resumo que abre o gate.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
