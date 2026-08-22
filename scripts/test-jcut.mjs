// Teste do J-Cut deterministico (src/jcut.ts) com o ffmpeg empacotado:
// - plano: leads com clamp, pareamento 1:1 com os ranges e casos invalidos;
// - execucao real: video da saida IDENTICO byte a byte (framemd5 com c copy),
//   duracoes de audio e video fechadas, e antecipacao AUDIVEL (a janela
//   pre-juncao que era silencio ganha o tom da cena seguinte).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformKey = `${process.platform}-${process.arch}`;
const FFMPEG = path.join(projectRoot, 'resources', 'runtimes', platformKey, 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const work = mkdtempSync(path.join(tmpdir(), 'edvid-jcut-test-'));

try {
  execFileSync(path.join(projectRoot, 'node_modules', '.bin', 'esbuild'), [
    path.join(projectRoot, 'src', 'jcut.ts'),
    '--bundle', '--platform=node', '--format=esm',
    `--outfile=${path.join(work, 'jcut.mjs')}`,
  ], { stdio: 'inherit' });
  const { planJcut, extractionArgs, mixArgs, muxArgs, cutMatchesEdl, tracksInSync } = await import(pathToFileURL(path.join(work, 'jcut.mjs')).href);

  // --- Plano: clamps e recusas -------------------------------------------
  assert.equal(planJcut([{ start: 0, end: 5 }]), null, 'um range so nao tem juncao');
  assert.equal(planJcut([{ start: 0, end: 5 }, { start: 5, end: NaN }]), null, 'range invalido derruba o plano');

  const plano = planJcut([
    { beat: 'A', source: 'main', start: 2, end: 5 },
    { beat: 'B', source: 'main', start: 10, end: 13 },
    { beat: 'C', source: 'main', start: 20, end: 23 },
  ]);
  assert.ok(plano && plano.leadsApplied === 2, 'duas juncoes antecipadas');
  assert.equal(plano.totalDuration, 9);
  assert.deepEqual(plano.segments.map((segment) => segment.lead), [0, 0.15, 0.15]);
  assert.equal(plano.timeline.length, 3, 'timeline pareada 1:1 com os ranges');
  assert.equal(plano.timeline[1].audio_start_in_output, 2.85);
  assert.equal(plano.timeline[1].audio_duration, 3.15);

  // Take seguinte comecando no inicio absoluto da fonte: sem material antes
  // do in, o lead daquela juncao e zero.
  const semMaterial = planJcut([
    { start: 5, end: 8 },
    { start: 0.01, end: 3 },
    { start: 10, end: 13 },
  ]);
  assert.ok(semMaterial, 'plano existe (a outra juncao ainda antecipa)');
  assert.deepEqual(semMaterial.segments.map((segment) => segment.lead), [0, 0, 0.15]);

  // Takes curtissimos: o clamp de 45% derruba o lead abaixo do minimo.
  assert.equal(
    planJcut([{ start: 2, end: 2.05 }, { start: 5, end: 5.05 }]),
    null,
    'takes curtos demais nao ganham J-cut',
  );

  // --- Execucao real com o ffmpeg empacotado -----------------------------
  if (!existsSync(FFMPEG)) {
    console.log(`test:jcut ok — plano validado; execucao pulada (sem ffmpeg empacotado em ${platformKey}).`);
    process.exit(0);
  }
  const ffmpeg = (args) => execFileSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const source = path.join(work, 'source.mp4');
  const audioExpr = 'if(between(t,2,4.5),0.8*sin(2*PI*440*t),if(between(t,9.5,12.5),0.8*sin(2*PI*880*t),if(between(t,19.5,23),0.8*sin(2*PI*1320*t),0)))';
  ffmpeg(['-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=30',
    '-f', 'lavfi', '-i', `aevalsrc='${audioExpr}':s=48000:d=30`,
    '-c:v', 'mpeg4', '-q:v', '6', '-c:a', 'aac', '-b:a', '160k', source]);

  const cut = path.join(work, 'cut.mp4');
  ffmpeg(['-hide_banner', '-nostdin', '-y', '-i', source, '-filter_complex',
    '[0:v]trim=2:5,setpts=PTS-STARTPTS[v0];[0:a]atrim=2:5,asetpts=PTS-STARTPTS[a0];' +
    '[0:v]trim=10:13,setpts=PTS-STARTPTS[v1];[0:a]atrim=10:13,asetpts=PTS-STARTPTS[a1];' +
    '[0:v]trim=20:23,setpts=PTS-STARTPTS[v2];[0:a]atrim=20:23,asetpts=PTS-STARTPTS[a2];' +
    '[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'mpeg4', '-q:v', '6', '-c:a', 'aac', '-b:a', '160k', cut]);

  const pieces = plano.segments.map((segment, index) => {
    const wav = path.join(work, `piece-${index}.wav`);
    ffmpeg(extractionArgs(segment, source, wav));
    return wav;
  });
  const mixed = path.join(work, 'mixed.wav');
  ffmpeg(mixArgs(plano, pieces, mixed));
  const out = path.join(work, 'cut-jcut.mp4');
  ffmpeg(muxArgs(cut, mixed, out));

  const frameMd5 = (file) => ffmpeg(['-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framemd5', '-']);
  assert.equal(frameMd5(cut), frameMd5(out), 'video IDENTICO apos o J-cut');

  const rmsOf = (file, from, to) => {
    const result = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-i', file, '-af',
      `atrim=${from}:${to},asetpts=PTS-STARTPTS,astats`, '-f', 'null', '-'], { encoding: 'utf8' });
    const match = [...`${result.stderr ?? ''}`.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/gu)].at(-1);
    assert.ok(match, `astats sem RMS para ${file}`);
    return match[1] === '-inf' ? -120 : Number(match[1]);
  };
  assert.ok(rmsOf(cut, 2.88, 2.98) < -60, 'pre-juncao B silenciosa no corte simples');
  assert.ok(rmsOf(out, 2.88, 2.98) > -35, 'J-cut antecipa a fala do take B');
  assert.ok(rmsOf(cut, 5.88, 5.98) < -60, 'pre-juncao C silenciosa no corte simples');
  assert.ok(rmsOf(out, 5.88, 5.98) > -35, 'J-cut antecipa a fala do take C');

  // --- Guardas de sincronia -------------------------------------------------
  // Números reais da máquina do aluno: os ajustes da linha do tempo
  // reescreveram o EDL para 90,613s e o vídeo continuou o antigo, de 94,533s.
  // O J-Cut rodou assim mesmo, montou o áudio pelo EDL novo e o som saiu 3,9s
  // fora do lugar do início ao fim.
  assert.equal(cutMatchesEdl(94.533, 90.613), false, 'vídeo que não bate com o EDL precisa barrar o J-Cut');
  assert.equal(cutMatchesEdl(90.613, 90.613), true);
  // Meio quadro de folga: arredondamento de container não pode barrar.
  assert.equal(cutMatchesEdl(90.62, 90.613), true);
  assert.equal(cutMatchesEdl(90.9, 90.613), false, '0,3s já é um erro visível');
  // Sem medida confiável, não inventa bloqueio.
  assert.equal(cutMatchesEdl(NaN, 90.613), true);

  // E o arquivo pronto: a duração do CONTAINER é a do stream mais longo, então
  // só medir trilha por trilha revela o áudio curto. Foi o que faltava.
  assert.equal(tracksInSync(94.533, 90.613), false, 'áudio 3,9s mais curto não pode ser publicado');
  assert.equal(tracksInSync(94.533, 94.538), true, 'diferença de milissegundos é normal');
  assert.equal(tracksInSync(NaN, 94.5), true);

  console.log('test:jcut ok — leads, timeline 1:1, video identico, antecipacao audivel e sincronia verificada trilha a trilha.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
