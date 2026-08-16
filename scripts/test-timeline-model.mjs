// Smoke test do modelo não destrutivo da timeline. Compila o módulo puro com
// o TypeScript do projeto e valida migração de EDL, razor, trim, ripple
// delete, prévia mapeada e export de ranges.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-timeline-test-'));

try {
  execFileSync(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(projectRoot, 'src', 'timeline-model.ts'),
      '--target', 'es2022',
      '--module', 'es2022',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
      '--outDir', outDir,
    ],
    { stdio: 'inherit' },
  );

  const model = await import(pathToFileURL(path.join(outDir, 'timeline-model.js')).href);
  const {
    applyTrim,
    clipDuration,
    clipEnd,
    deleteClipLeaveGap,
    deriveSegments,
    edlRangesFromModel,
    migrateEdlToModel,
    modelFromSegments,
    modelsEqual,
    playbackProgramme,
    programmeIndexAt,
    razorAtTime,
    rippleDeleteClip,
    sanitizeTimelineModel,
    sortedTrackClips,
    timelineModelDuration,
    trimAllowedDelta,
    VIDEO_TRACK_ID,
    VOICE_TRACK_ID,
  } = model;

  const near = (a, b, eps = 0.002) =>
    assert.ok(Math.abs(a - b) <= eps, `esperado ${b}, obtido ${a}`);

  // --- Migração de EDL com ranges + jcut (formato real do projeto Honor) ---
  const edl = {
    version: 1,
    sources: { IMG: '/tmp/IMG.MOV' },
    ranges: [
      { source: 'IMG', start: 0.74, end: 4.84, beat: 'HOOK', gain_db: 0 },
      { source: 'IMG', start: 10.0, end: 14.0, beat: 'PROBLEMA', gain_db: -2 },
      { source: 'IMG', start: 20.0, end: 23.0, beat: 'SOLUÇÃO' },
    ],
    jcut_timeline: [
      { beat: 'HOOK', source: 'IMG', video_start_in_output: 0, video_duration: 4.0, audio_start_in_output: 0, audio_duration: 4.1 },
      { beat: 'PROBLEMA', source: 'IMG', video_start_in_output: 4.0, video_duration: 4.0, audio_start_in_output: 3.9, audio_duration: 4.0 },
      { beat: 'SOLUÇÃO', source: 'IMG', video_start_in_output: 8.0, video_duration: 3.0, audio_start_in_output: 7.9, audio_duration: 3.0 },
    ],
  };
  const migrated = migrateEdlToModel(edl, 30);
  assert.ok(migrated, 'a migração do EDL deve produzir um modelo');
  assert.equal(migrated.clips.length, 6);
  const videos = sortedTrackClips(migrated, VIDEO_TRACK_ID);
  const voices = sortedTrackClips(migrated, VOICE_TRACK_ID);
  near(videos[0].sourceIn, 0.74);
  near(videos[0].sourceOut, 4.74); // range 0.74 + video_duration 4.0 (tail trim)
  near(videos[1].timelineStart, 4.0);
  near(voices[1].timelineStart, 3.9); // J-cut: áudio entra antes do vídeo
  near(voices[1].sourceOut, 14.0); // start 10 + audio_duration 4.0
  assert.equal(voices[1].gainDb, -2);
  assert.equal(videos[1].linkId, voices[1].linkId);
  near(timelineModelDuration(migrated), 11.0);

  // Migração determinística: o mesmo EDL produz o mesmo modelo.
  assert.ok(modelsEqual(migrated, migrateEdlToModel(edl, 30)));

  // Sanitização round-trip.
  assert.ok(modelsEqual(sanitizeTimelineModel(JSON.parse(JSON.stringify(migrated))), migrated));
  assert.equal(sanitizeTimelineModel({ version: 2 }), null);

  // deriveSegments preserva ordem, duração e J-cut.
  const segments = deriveSegments(migrated);
  assert.equal(segments.length, 3);
  near(segments[1].start, 4.0);
  near(segments[1].audioStart, 3.9);

  // --- Razor divide vídeo e áudio na agulha, mantendo o vínculo por metade ---
  const razored = razorAtTime(migrated, 2.0);
  assert.ok(razored, 'o razor em 2.0s deve dividir o primeiro take');
  const razoredVideos = sortedTrackClips(razored, VIDEO_TRACK_ID);
  assert.equal(razoredVideos.length, 4);
  near(razoredVideos[0].sourceOut, 2.74); // 0.74 + 2.0
  near(razoredVideos[1].sourceIn, 2.74);
  near(razoredVideos[1].timelineStart, 2.0);
  const razoredVoices = sortedTrackClips(razored, VOICE_TRACK_ID);
  assert.equal(razoredVoices.length, 4);
  assert.equal(razoredVideos[1].linkId, razoredVoices[1].linkId);
  assert.notEqual(razoredVideos[0].linkId, razoredVideos[1].linkId);
  near(timelineModelDuration(razored), 11.0); // razor não muda a duração

  // Razor fora de qualquer clipe não faz nada.
  assert.equal(razorAtTime(migrated, 30), null);

  // Razor dentro do lead-in de J-cut: o vídeo seguinte (não dividido) deve
  // permanecer vinculado à metade do áudio que se alinha a ele (a direita).
  const jcutRazor = razorAtTime(migrated, 3.95);
  assert.ok(jcutRazor);
  const jrVoices = sortedTrackClips(jcutRazor, VOICE_TRACK_ID);
  const jrVideos = sortedTrackClips(jcutRazor, VIDEO_TRACK_ID);
  // voz PROBLEMA foi dividida em 3.95; a metade direita mantém o vínculo
  const problemVideo = jrVideos.find((clip) => clip.label === 'PROBLEMA' && clip.timelineStart === 4.0);
  const problemAudioRight = jrVoices.find((clip) => clip.label === 'PROBLEMA' && clip.timelineStart === 3.95);
  const problemAudioLeft = jrVoices.find((clip) => clip.label === 'PROBLEMA' && clip.timelineStart === 3.9);
  assert.ok(problemVideo && problemAudioRight && problemAudioLeft);
  assert.equal(problemAudioRight.linkId, problemVideo.linkId);
  assert.equal(problemAudioLeft.linkId, null);

  // --- Campos com tipo inesperado no EDL escrito pelo agente ---------------
  // Regressão real: o agente gravou "beat": 1 (número) e a leitura do projeto
  // inteiro morria com "beat.trim is not a function", quebrando o refresh do
  // workspace ao fim de cada turno.
  const edlBeatNumerico = {
    source: '/tmp/IMG.MOV',
    ranges: [
      { beat: 1, start: 0.769, end: 4.758 },
      { beat: 2, start: 6.0, end: 9.0 },
    ],
  };
  const migradoNumerico = migrateEdlToModel(edlBeatNumerico, 30);
  assert.ok(migradoNumerico, 'beat numérico não pode derrubar a migração');
  assert.equal(sortedTrackClips(migradoNumerico, VIDEO_TRACK_ID)[0].label, '1');
  assert.equal(sortedTrackClips(migradoNumerico, VIDEO_TRACK_ID)[1].label, '2');

  // Qualquer outro tipo cai no rótulo padrão em vez de explodir.
  for (const beat of [null, true, {}, [], undefined, Number.NaN]) {
    const modelo = migrateEdlToModel(
      { ranges: [{ beat, start: 0, end: 2 }] },
      30,
    );
    assert.ok(modelo, `beat ${JSON.stringify(beat) ?? 'undefined'} derrubou a migração`);
    assert.equal(sortedTrackClips(modelo, VIDEO_TRACK_ID)[0].label, 'Take 01');
  }

  // --- A fonte do EDL nunca pode virar a mídia do preview -------------------
  // Regressão real: o EDL usava a forma abreviada "source": "IMG_6164.MOV" e
  // nós só líamos o mapa "sources". Os clipes caíam em PREVIEW_SOURCE_ID, que
  // resolve para o render já cortado — e como os ranges estão no tempo do
  // arquivo ORIGINAL (até 348s num render de 154s), a prévia buscava tempos
  // inexistentes e a reprodução ficava sem sentido.
  const edlAbreviado = {
    source: 'IMG_6164.MOV',
    ranges: [
      { beat: 1, start: 0.769, end: 4.758 },
      { beat: 32, start: 345.215, end: 348.507 },
    ],
  };
  const migradoAbreviado = migrateEdlToModel(edlAbreviado, 30);
  const fontesUsadas = new Set(migradoAbreviado.clips.map((clip) => clip.sourceId));
  assert.deepEqual([...fontesUsadas], ['IMG_6164.MOV']);
  assert.ok(!fontesUsadas.has('preview'), 'o EDL nunca pode apontar para o render');

  // Sem fonte declarada, a fonte fica desconhecida em vez de virar o render.
  const semFonte = migrateEdlToModel({ ranges: [{ start: 0, end: 2 }] }, 30);
  assert.equal(sortedTrackClips(semFonte, VIDEO_TRACK_ID)[0].sourceId, 'fonte-desconhecida');

  // O modelo derivado de segmentos continua usando o render, e deve: esses
  // tempos já estão na timeline de saída.
  const porSegmentos = modelFromSegments([{ label: 'Cena', start: 0, duration: 2 }], 30);
  assert.equal(sortedTrackClips(porSegmentos, VIDEO_TRACK_ID)[0].sourceId, 'preview');

  // O mesmo vale para source, que vira o id da fonte.
  const fonteNumerica = migrateEdlToModel(
    { sources: { '7': '/tmp/a.mov' }, ranges: [{ source: 7, start: 0, end: 2 }] },
    30,
  );
  assert.equal(sortedTrackClips(fonteNumerica, VIDEO_TRACK_ID)[0].sourceId, '7');

  // Um range inválido no meio não desalinha nem descarta os J-cuts.
  const edlWithBadRange = JSON.parse(JSON.stringify(edl));
  edlWithBadRange.ranges.splice(1, 0, { source: 'IMG', start: 50, end: 50 });
  edlWithBadRange.jcut_timeline.splice(1, 0, { beat: 'INVÁLIDO', source: 'IMG', video_start_in_output: 99, video_duration: 0 });
  const migratedWithBad = migrateEdlToModel(edlWithBadRange, 30);
  assert.ok(migratedWithBad);
  assert.equal(migratedWithBad.clips.length, 6);
  near(sortedTrackClips(migratedWithBad, VOICE_TRACK_ID)[1].timelineStart, 3.9); // J-cut preservado

  // Gain fora da faixa é normalizado como na sanitização (round-trip estável).
  const edlWithLoudGain = JSON.parse(JSON.stringify(edl));
  edlWithLoudGain.ranges[0].gain_db = 99;
  const migratedLoud = migrateEdlToModel(edlWithLoudGain, 30);
  assert.equal(sortedTrackClips(migratedLoud, VOICE_TRACK_ID)[0].gainDb, 12);
  assert.ok(modelsEqual(sanitizeTimelineModel(JSON.parse(JSON.stringify(migratedLoud))), migratedLoud));

  // --- Trim com limites do arquivo-fonte ---
  const sourceDurations = { IMG: 30 };
  const firstVideo = videos[0];
  // Estender o início além do começo do arquivo é limitado a sourceIn=0.
  const headRoom = trimAllowedDelta(migrated, firstVideo.id, 'start', sourceDurations);
  near(headRoom.min, -0.74);
  // Encurtar 1s pelo início: conteúdo desliza, takes seguintes fecham o vão.
  const headTrim = applyTrim(migrated, firstVideo.id, 'start', 1.0, sourceDurations, { ripple: true });
  near(headTrim.applied, 1.0);
  const headVideos = sortedTrackClips(headTrim.model, VIDEO_TRACK_ID);
  near(headVideos[0].sourceIn, 1.74);
  near(headVideos[0].timelineStart, 0);
  near(headVideos[1].timelineStart, 3.0); // deslizou 1s
  near(timelineModelDuration(headTrim.model), 10.0);
  // Áudio vinculado acompanha o trim.
  near(sortedTrackClips(headTrim.model, VOICE_TRACK_ID)[0].sourceIn, 1.74);

  // Estender o fim recupera conteúdo do arquivo original.
  const lastVideo = videos[2];
  const tailTrim = applyTrim(migrated, lastVideo.id, 'end', 2.0, sourceDurations, { ripple: true });
  near(tailTrim.applied, 2.0);
  near(sortedTrackClips(tailTrim.model, VIDEO_TRACK_ID)[2].sourceOut, 25.0);
  near(timelineModelDuration(tailTrim.model), 13.0);
  // Sem duração conhecida da fonte, não há extensão além do que já foi usado.
  const noHeadroom = trimAllowedDelta(migrated, lastVideo.id, 'end', {});
  near(noHeadroom.max, 0);

  // --- Ripple delete remove o par vídeo+áudio e fecha o vão ---
  const middleVideo = videos[1];
  const deleted = rippleDeleteClip(migrated, middleVideo.id);
  assert.ok(deleted);
  assert.equal(deleted.clips.length, 4);
  const deletedVideos = sortedTrackClips(deleted, VIDEO_TRACK_ID);
  near(deletedVideos[1].timelineStart, 4.0); // SOLUÇÃO ocupou o lugar
  near(timelineModelDuration(deleted), 7.0);
  // Áudio em J-cut do take seguinte preserva o offset relativo (7.9 - 4.0).
  const deletedVoices = sortedTrackClips(deleted, VOICE_TRACK_ID);
  near(deletedVoices[1].timelineStart, 3.9);

  // Delete deixando espaço não desloca os takes seguintes.
  const gapDeleted = deleteClipLeaveGap(migrated, middleVideo.id);
  assert.equal(gapDeleted.clips.length, 4);
  near(sortedTrackClips(gapDeleted, VIDEO_TRACK_ID)[1].timelineStart, 8.0);

  // --- Programa de reprodução mapeada ---
  const programme = playbackProgramme(gapDeleted);
  assert.equal(programme.length, 2);
  assert.equal(programmeIndexAt(programme, 2.0), 0);
  assert.equal(programmeIndexAt(programme, 5.0), -1); // dentro do vão
  assert.equal(programmeIndexAt(programme, 9.0), 1);

  // --- Export de ranges para o agente re-renderizar ---
  const ranges = edlRangesFromModel(deleted);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].label, 'HOOK');
  near(ranges[0].start, 0.74);
  near(ranges[0].end, 4.74);
  assert.equal(ranges[1].label, 'SOLUÇÃO');

  // --- Fallback por segmentos (detecção visual / jcut sem ranges) ---
  const fallback = modelFromSegments(
    [
      { label: 'Cena 01', start: 0, duration: 3.2 },
      { label: 'Cena 02', start: 3.2, duration: 4.1 },
    ],
    30,
  );
  assert.ok(fallback);
  assert.equal(fallback.clips.length, 4);
  near(clipEnd(sortedTrackClips(fallback, VIDEO_TRACK_ID)[1]), 7.3);
  near(clipDuration(sortedTrackClips(fallback, VIDEO_TRACK_ID)[0]), 3.2);

  console.log('test:timeline-model ok — migração, razor, trim, delete, programa e ranges validados.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
