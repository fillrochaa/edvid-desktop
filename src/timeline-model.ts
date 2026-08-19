import type {
  ProjectTimelineSegment,
  TimelineClip,
  TimelineModel,
  TimelineTrack,
} from './shared';

// Operações puras sobre o modelo não destrutivo da timeline. O modelo é a
// fonte de verdade; EDL e render são derivados dele apenas ao aplicar.

export const VIDEO_TRACK_ID = 'video';
export const VOICE_TRACK_ID = 'voice';
export const PREVIEW_SOURCE_ID = 'preview';
// Fonte de um EDL que nao declara arquivo. Nao resolve para nada, de proposito.
export const UNKNOWN_SOURCE_ID = 'fonte-desconhecida';
export const MIN_CLIP_DURATION = 0.04;
const TIME_EPSILON = 0.001;
const MAX_CLIPS = 1000;
const MAX_TIMELINE_SECONDS = 6 * 3600;

export type EdlRange = {
  source?: string;
  start?: number;
  end?: number;
  beat?: string;
  gain_db?: number;
};

export type EdlJcutEntry = {
  beat?: string;
  source?: string;
  video_start_in_output?: number;
  video_duration?: number;
  audio_start_in_output?: number;
  audio_duration?: number;
};

export type EdlDocument = {
  sources?: Record<string, string>;
  // Forma abreviada, usada quando o corte vem de um arquivo so: "source":
  // "IMG_6164.MOV". Ignorar isso fazia os clipes cairem na midia do preview.
  source?: string;
  ranges?: EdlRange[];
  jcut_timeline?: EdlJcutEntry[];
};

export type PlaybackSegment = {
  clipId: string;
  timelineStart: number;
  timelineEnd: number;
  sourceId: string;
  sourceIn: number;
  speed: number;
};

// O edl.json e escrito pelo agente, entao os tipos declarados em EdlDocument
// sao uma promessa, nao uma garantia. Um `"beat": 1` (numero) derrubava a
// leitura inteira do projeto com "beat.trim is not a function".
export function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

let fallbackIdCounter = 0;

export function createClipId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `clip-${uuid}`;
  fallbackIdCounter += 1;
  return `clip-${fallbackIdCounter.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function defaultTracks(): TimelineTrack[] {
  return [
    { id: VIDEO_TRACK_ID, kind: 'video', name: 'Vídeo' },
    { id: VOICE_TRACK_ID, kind: 'audio', name: 'Voz' },
  ];
}

export function clipDuration(clip: TimelineClip): number {
  return Math.max(0, (clip.sourceOut - clip.sourceIn) / (clip.speed || 1));
}

export function clipEnd(clip: TimelineClip): number {
  return clip.timelineStart + clipDuration(clip);
}

export function sortedTrackClips(model: TimelineModel, trackId: string): TimelineClip[] {
  return model.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.timelineStart - b.timelineStart || a.sourceIn - b.sourceIn);
}

export function timelineModelDuration(model: TimelineModel): number {
  return model.clips.reduce((maximum, clip) => Math.max(maximum, clipEnd(clip)), 0);
}

export function linkedPartner(model: TimelineModel, clip: TimelineClip): TimelineClip | null {
  if (!clip.linkId) return null;
  return (
    model.clips.find((other) => other.id !== clip.id && other.linkId === clip.linkId) ?? null
  );
}

export function modelsEqual(a: TimelineModel | null, b: TimelineModel | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Ordem de chaves canônica: modelsEqual compara JSON, então migração,
// sanitização e comandos precisam serializar clipes de forma idêntica.
function makeClip(
  partial: Omit<TimelineClip, 'enabled' | 'speed' | 'gainDb' | 'fadeInSec' | 'fadeOutSec'> &
    Partial<TimelineClip>,
): TimelineClip {
  return {
    id: partial.id,
    trackId: partial.trackId,
    linkId: partial.linkId ?? null,
    label: partial.label,
    sourceId: partial.sourceId,
    sourceIn: partial.sourceIn,
    sourceOut: partial.sourceOut,
    timelineStart: partial.timelineStart,
    enabled: partial.enabled ?? true,
    speed: partial.speed ?? 1,
    gainDb: partial.gainDb ?? 0,
    fadeInSec: partial.fadeInSec ?? 0,
    fadeOutSec: partial.fadeOutSec ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Migração: EDL (ranges em tempo do arquivo-fonte + jcut em tempo do render)
// para o modelo de clipes. Preserva J-cuts como clipes de áudio deslocados.
// ---------------------------------------------------------------------------

export function migrateEdlToModel(edl: EdlDocument, fps: number): TimelineModel | null {
  const rawRanges = Array.isArray(edl.ranges) ? edl.ranges : [];
  const jcutRaw = Array.isArray(edl.jcut_timeline) ? edl.jcut_timeline : [];
  // O jcut é pareado com os ranges ANTES do filtro; um range inválido não
  // pode desalinhar (nem descartar) os J-cuts dos ranges válidos.
  const paired = rawRanges
    .map((range, index) => ({
      range,
      entry: jcutRaw.length === rawRanges.length ? jcutRaw[index] : null,
    }))
    .filter(
      ({ range }) =>
        finitePositive(range.start) &&
        typeof range.end === 'number' &&
        Number.isFinite(range.end) &&
        (range.end as number) - (range.start as number) > MIN_CLIP_DURATION,
    );
  if (paired.length === 0 || paired.length > MAX_CLIPS / 2) return null;

  // Nunca cair em PREVIEW_SOURCE_ID aqui: os ranges do EDL estao no tempo do
  // ARQUIVO-FONTE, enquanto o preview e o render ja cortado. Apontar um para o
  // outro faz a previa buscar 348s num arquivo de 154s. Sem fonte declarada e
  // melhor a fonte ficar indisponivel do que exibir conteudo errado.
  const sourceIds = Object.keys(edl.sources ?? {});
  const fallbackSourceId = sourceIds[0] || asText(edl.source) || UNKNOWN_SOURCE_ID;

  const clips: TimelineClip[] = [];
  let outputCursor = 0;
  paired.forEach(({ range, entry }, index) => {
    // IDs determinísticos: uma nova migração do mesmo EDL produz o mesmo
    // modelo, o que permite detectar se um timeline.json salvo tem edições.
    const ordinal = String(index + 1).padStart(3, '0');
    const start = range.start as number;
    const end = range.end as number;
    const sourceId = asText(range.source) || fallbackSourceId;
    const label = asText(range.beat) || `Take ${String(index + 1).padStart(2, '0')}`;
    const videoDuration =
      entry && finitePositive(entry.video_duration) && entry.video_duration > TIME_EPSILON
        ? entry.video_duration
        : end - start;
    const videoStart =
      entry && finitePositive(entry.video_start_in_output)
        ? entry.video_start_in_output
        : outputCursor;
    const audioDuration =
      entry && finitePositive(entry.audio_duration) && entry.audio_duration > TIME_EPSILON
        ? entry.audio_duration
        : end - start;
    const audioStart =
      entry && finitePositive(entry.audio_start_in_output)
        ? entry.audio_start_in_output
        : videoStart;
    const linkId = `link-${ordinal}`;
    clips.push(
      makeClip({
        id: `v-${ordinal}`,
        trackId: VIDEO_TRACK_ID,
        linkId,
        label,
        sourceId,
        sourceIn: round3(start),
        sourceOut: round3(start + videoDuration),
        timelineStart: round3(videoStart),
      }),
      makeClip({
        id: `a-${ordinal}`,
        trackId: VOICE_TRACK_ID,
        linkId,
        label,
        sourceId,
        sourceIn: round3(start),
        sourceOut: round3(start + audioDuration),
        timelineStart: round3(audioStart),
        // Mesmo clamp da sanitização; sem ele um gain fora da faixa quebraria
        // a detecção de sincronismo no round-trip via timeline.json.
        gainDb:
          typeof range.gain_db === 'number' && Number.isFinite(range.gain_db)
            ? Math.max(-60, Math.min(range.gain_db, 12))
            : 0,
      }),
    );
    outputCursor = videoStart + videoDuration;
  });

  return { version: 1, fps: Math.max(1, Math.round(fps || 30)), tracks: defaultTracks(), clips };
}

// Fallback: segmentos já em tempo do render (jcut sem ranges, detecção visual
// ou mídia única). Os clipes referenciam o próprio arquivo do preview.
export function modelFromSegments(
  segments: ProjectTimelineSegment[],
  fps: number,
  sourceId = PREVIEW_SOURCE_ID,
): TimelineModel | null {
  const valid = segments.filter(
    (segment) =>
      finitePositive(segment.start) &&
      Number.isFinite(segment.duration) &&
      segment.duration > MIN_CLIP_DURATION,
  );
  if (valid.length === 0 || valid.length > MAX_CLIPS / 2) return null;
  const clips: TimelineClip[] = [];
  valid.forEach((segment, index) => {
    const ordinal = String(index + 1).padStart(3, '0');
    const linkId = `link-${ordinal}`;
    const audioStart = finitePositive(segment.audioStart) ? segment.audioStart : segment.start;
    const audioDuration =
      finitePositive(segment.audioDuration) && (segment.audioDuration as number) > TIME_EPSILON
        ? (segment.audioDuration as number)
        : segment.duration;
    clips.push(
      makeClip({
        id: `v-${ordinal}`,
        trackId: VIDEO_TRACK_ID,
        linkId,
        label: segment.label,
        sourceId,
        sourceIn: round3(segment.start),
        sourceOut: round3(segment.start + segment.duration),
        timelineStart: round3(segment.start),
      }),
      makeClip({
        id: `a-${ordinal}`,
        trackId: VOICE_TRACK_ID,
        linkId,
        label: segment.label,
        sourceId,
        sourceIn: round3(audioStart),
        sourceOut: round3(audioStart + audioDuration),
        timelineStart: round3(audioStart),
      }),
    );
  });
  return { version: 1, fps: Math.max(1, Math.round(fps || 30)), tracks: defaultTracks(), clips };
}

// Espelho pré-corte de uma pasta com vários vídeos: um clipe por arquivo, em
// sequência, cada um referenciando a própria fonte. É o que a timeline mostra
// antes do corte limpo existir — todos os vídeos, na ordem em que serão
// limpos, e o preview mapeado toca um após o outro.
export function modelFromSourceFiles(
  files: { id: string; label: string; duration: number }[],
  fps: number,
): TimelineModel | null {
  const valid = files.filter((file) => (
    file.id.length > 0 && Number.isFinite(file.duration) && file.duration > MIN_CLIP_DURATION
  ));
  if (valid.length === 0 || valid.length > MAX_CLIPS / 2) return null;
  const clips: TimelineClip[] = [];
  let cursor = 0;
  valid.forEach((file, index) => {
    const ordinal = String(index + 1).padStart(3, '0');
    const linkId = `link-${ordinal}`;
    const start = round3(cursor);
    clips.push(
      makeClip({
        id: `v-${ordinal}`,
        trackId: VIDEO_TRACK_ID,
        linkId,
        label: file.label,
        sourceId: file.id,
        sourceIn: 0,
        sourceOut: round3(file.duration),
        timelineStart: start,
      }),
      makeClip({
        id: `a-${ordinal}`,
        trackId: VOICE_TRACK_ID,
        linkId,
        label: file.label,
        sourceId: file.id,
        sourceIn: 0,
        sourceOut: round3(file.duration),
        timelineStart: start,
      }),
    );
    cursor += file.duration;
  });
  return { version: 1, fps: Math.max(1, Math.round(fps || 30)), tracks: defaultTracks(), clips };
}

// Evidência de corte de verdade: o modelo mantém MENOS material do que as
// fontes têm. Um EDL que devolve os vídeos inteiros (o "corte" inventado
// quando a transcrição falha) não passa aqui — e fonte sem duração conhecida
// também não conta como evidência.
export function modelRemovesMaterial(
  model: TimelineModel,
  sourceDurations: Record<string, number>,
  toleranceSeconds = 0.5,
): boolean {
  const videoClips = sortedTrackClips(model, VIDEO_TRACK_ID).filter(
    (clip) => clip.enabled && clip.sourceId !== PREVIEW_SOURCE_ID,
  );
  if (videoClips.length === 0) return false;
  const keptBySource = new Map<string, number>();
  for (const clip of videoClips) {
    const span = Math.max(0, clip.sourceOut - clip.sourceIn);
    keptBySource.set(clip.sourceId, (keptBySource.get(clip.sourceId) ?? 0) + span);
  }
  let total = 0;
  let kept = 0;
  for (const [sourceId, keptSpan] of keptBySource) {
    const duration = sourceDurations[sourceId];
    if (!Number.isFinite(duration) || (duration as number) <= 0) return false;
    total += duration as number;
    kept += Math.min(keptSpan, duration as number);
  }
  return kept < total - toleranceSeconds;
}

// Segmentos derivados para consumidores legados (marcadores de corte, resumo).
export function deriveSegments(model: TimelineModel): ProjectTimelineSegment[] {
  return sortedTrackClips(model, VIDEO_TRACK_ID)
    .filter((clip) => clip.enabled)
    .map((clip) => {
      const partner = linkedPartner(model, clip);
      return {
        label: clip.label,
        start: round3(clip.timelineStart),
        duration: round3(clipDuration(clip)),
        audioStart: round3(partner ? partner.timelineStart : clip.timelineStart),
        audioDuration: round3(partner ? clipDuration(partner) : clipDuration(clip)),
      };
    });
}

// ---------------------------------------------------------------------------
// Comandos de edição. Todos retornam um novo modelo; nunca mutam o recebido.
// ---------------------------------------------------------------------------

function shiftClipsAfter(
  clips: TimelineClip[],
  afterTime: number,
  delta: number,
  excludeIds: ReadonlySet<string>,
): TimelineClip[] {
  if (Math.abs(delta) < TIME_EPSILON) return clips;
  return clips.map((clip) => {
    if (excludeIds.has(clip.id) || clip.timelineStart <= afterTime + TIME_EPSILON) return clip;
    return { ...clip, timelineStart: round3(Math.max(0, clip.timelineStart + delta)) };
  });
}

export function razorAtTime(model: TimelineModel, time: number): TimelineModel | null {
  const targets = model.clips.filter(
    (clip) =>
      time - clip.timelineStart >= MIN_CLIP_DURATION &&
      clipEnd(clip) - time >= MIN_CLIP_DURATION,
  );
  if (targets.length === 0) return null;
  const targetIds = new Set(targets.map((clip) => clip.id));
  const rightLinkByOldLink = new Map<string, string>();
  for (const clip of targets) {
    if (clip.linkId && !rightLinkByOldLink.has(clip.linkId)) {
      rightLinkByOldLink.set(clip.linkId, createClipId());
    }
  }
  const clips = model.clips.flatMap((clip) => {
    if (!targetIds.has(clip.id)) return [clip];
    const splitSource = round3(clip.sourceIn + (time - clip.timelineStart) * (clip.speed || 1));
    // Se o parceiro vinculado não foi dividido (J-cut: o corte cai no lead-in
    // ou na cauda do áudio), o vínculo fica com a metade que se alinha a ele.
    const partner = linkedPartner(model, clip);
    let leftLink: string | null = null;
    let rightLink: string | null = null;
    if (clip.linkId) {
      if (partner && !targetIds.has(partner.id)) {
        if (partner.timelineStart >= time - TIME_EPSILON) rightLink = clip.linkId;
        else leftLink = clip.linkId;
      } else {
        leftLink = clip.linkId;
        rightLink = rightLinkByOldLink.get(clip.linkId) ?? null;
      }
    }
    const left: TimelineClip = { ...clip, sourceOut: splitSource, linkId: leftLink };
    const right: TimelineClip = {
      ...clip,
      id: createClipId(),
      sourceIn: splitSource,
      timelineStart: round3(time),
      linkId: rightLink,
      fadeInSec: 0,
    };
    left.fadeOutSec = 0;
    return [left, right];
  });
  return { ...model, clips };
}

export type TrimEdge = 'start' | 'end';

export function trimAllowedDelta(
  model: TimelineModel,
  clipId: string,
  edge: TrimEdge,
  sourceDurations: Readonly<Record<string, number | undefined>>,
): { min: number; max: number } | null {
  const primary = model.clips.find((clip) => clip.id === clipId);
  if (!primary) return null;
  const partner = linkedPartner(model, primary);
  const clipsToTrim = partner ? [primary, partner] : [primary];
  let min = -Infinity;
  let max = Infinity;
  for (const clip of clipsToTrim) {
    const speed = clip.speed || 1;
    if (edge === 'start') {
      // Estender para trás só até o início do arquivo-fonte.
      min = Math.max(min, -clip.sourceIn / speed);
      max = Math.min(max, clipDuration(clip) - MIN_CLIP_DURATION);
    } else {
      min = Math.max(min, -(clipDuration(clip) - MIN_CLIP_DURATION));
      const sourceDuration = sourceDurations[clip.sourceId];
      const headroom = finitePositive(sourceDuration)
        ? Math.max(0, (sourceDuration as number) - clip.sourceOut) / speed
        : 0;
      max = Math.min(max, headroom);
    }
  }
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 0;
  return { min, max };
}

// Trim de uma extremidade com propagação (ripple) opcional. `delta` é em
// segundos de timeline: no início, positivo encurta; no fim, positivo estende.
export function applyTrim(
  model: TimelineModel,
  clipId: string,
  edge: TrimEdge,
  delta: number,
  sourceDurations: Readonly<Record<string, number | undefined>>,
  options: { ripple: boolean },
): { model: TimelineModel; applied: number } {
  const allowed = trimAllowedDelta(model, clipId, edge, sourceDurations);
  const primary = model.clips.find((clip) => clip.id === clipId);
  if (!allowed || !primary) return { model, applied: 0 };
  const applied = Math.max(allowed.min, Math.min(delta, allowed.max));
  if (Math.abs(applied) < TIME_EPSILON) return { model, applied: 0 };
  const partner = linkedPartner(model, primary);
  const trimIds = new Set([primary.id, ...(partner ? [partner.id] : [])]);
  let clips = model.clips.map((clip) => {
    if (!trimIds.has(clip.id)) return clip;
    const speed = clip.speed || 1;
    if (edge === 'start') {
      const sourceIn = round3(clip.sourceIn + applied * speed);
      // Sem ripple o início acompanha o ponteiro (abre espaço); com ripple a
      // borda esquerda permanece ancorada e o conteúdo desliza. A posição na
      // timeline nunca fica negativa, mesmo na prévia.
      const timelineStart = options.ripple
        ? clip.timelineStart
        : round3(Math.max(0, clip.timelineStart + applied));
      return { ...clip, sourceIn, timelineStart };
    }
    return { ...clip, sourceOut: round3(clip.sourceOut + applied * speed) };
  });
  if (options.ripple) {
    // A duração do clipe primário muda em -applied (início) ou +applied (fim);
    // tudo que começa depois dele desliza junto, inclusive áudios em J-cut.
    const durationDelta = edge === 'start' ? -applied : applied;
    clips = shiftClipsAfter(clips, primary.timelineStart, durationDelta, trimIds);
  }
  return { model: { ...model, clips }, applied };
}

export function rippleDeleteClip(model: TimelineModel, clipId: string): TimelineModel | null {
  const primary = model.clips.find((clip) => clip.id === clipId);
  if (!primary) return null;
  const partner = linkedPartner(model, primary);
  const spanClip =
    primary.trackId === VIDEO_TRACK_ID
      ? primary
      : partner?.trackId === VIDEO_TRACK_ID
        ? partner
        : primary;
  const removedIds = new Set([primary.id, ...(partner ? [partner.id] : [])]);
  const duration = clipDuration(spanClip);
  const clips = shiftClipsAfter(
    model.clips.filter((clip) => !removedIds.has(clip.id)),
    spanClip.timelineStart,
    -duration,
    new Set(),
  );
  return { ...model, clips };
}

export function deleteClipLeaveGap(model: TimelineModel, clipId: string): TimelineModel | null {
  const primary = model.clips.find((clip) => clip.id === clipId);
  if (!primary) return null;
  const partner = linkedPartner(model, primary);
  const removedIds = new Set([primary.id, ...(partner ? [partner.id] : [])]);
  return { ...model, clips: model.clips.filter((clip) => !removedIds.has(clip.id)) };
}

export function snapCandidateTimes(
  model: TimelineModel,
  excludeIds: ReadonlySet<string>,
): number[] {
  const times = new Set<number>([0]);
  for (const clip of model.clips) {
    if (excludeIds.has(clip.id)) continue;
    times.add(round3(clip.timelineStart));
    times.add(round3(clipEnd(clip)));
  }
  return [...times].sort((a, b) => a - b);
}

export function snapTime(target: number, candidates: readonly number[], threshold: number): number {
  let best = target;
  let bestDistance = threshold;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - target);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Reprodução mapeada: programa de segmentos de vídeo em ordem de timeline.
// ---------------------------------------------------------------------------

export function playbackProgramme(model: TimelineModel): PlaybackSegment[] {
  return sortedTrackClips(model, VIDEO_TRACK_ID)
    .filter((clip) => clip.enabled && clipDuration(clip) > TIME_EPSILON)
    .map((clip) => ({
      clipId: clip.id,
      timelineStart: clip.timelineStart,
      timelineEnd: clipEnd(clip),
      sourceId: clip.sourceId,
      sourceIn: clip.sourceIn,
      speed: clip.speed || 1,
    }));
}

export function programmeIndexAt(programme: readonly PlaybackSegment[], time: number): number {
  for (let index = 0; index < programme.length; index += 1) {
    const segment = programme[index];
    if (time >= segment.timelineStart - TIME_EPSILON && time < segment.timelineEnd - TIME_EPSILON) {
      return index;
    }
  }
  return -1;
}

export function nextProgrammeIndexAfter(
  programme: readonly PlaybackSegment[],
  time: number,
): number {
  for (let index = 0; index < programme.length; index += 1) {
    if (programme[index].timelineStart >= time - TIME_EPSILON) return index;
  }
  return -1;
}

// Ranges em tempo do arquivo-fonte, na ordem da timeline: é o que o agente
// precisa para regravar o edit/edl.json e re-renderizar o corte.
export function edlRangesFromModel(model: TimelineModel): Array<{
  label: string;
  sourceId: string;
  start: number;
  end: number;
  gainDb: number;
}> {
  return sortedTrackClips(model, VIDEO_TRACK_ID)
    .filter((clip) => clip.enabled && clipDuration(clip) > TIME_EPSILON)
    .map((clip) => {
      const partner = linkedPartner(model, clip);
      return {
        label: clip.label,
        sourceId: clip.sourceId,
        start: round3(clip.sourceIn),
        end: round3(clip.sourceOut),
        gainDb: partner?.gainDb ?? clip.gainDb,
      };
    });
}

// ---------------------------------------------------------------------------
// Validação de modelos vindos de disco ou do renderer.
// ---------------------------------------------------------------------------

function sanitizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

export function sanitizeTimelineModel(value: unknown): TimelineModel | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<TimelineModel>;
  if (raw.version !== 1 || !Array.isArray(raw.clips) || raw.clips.length > MAX_CLIPS) return null;
  const rawTracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const tracks: TimelineTrack[] = rawTracks
    .filter((track): track is TimelineTrack => {
      if (!track || typeof track !== 'object') return false;
      return (
        typeof track.id === 'string' &&
        track.id.length > 0 &&
        track.id.length <= 64 &&
        (track.kind === 'video' || track.kind === 'audio') &&
        typeof track.name === 'string'
      );
    })
    .slice(0, 16)
    .map((track) => ({ id: track.id, kind: track.kind, name: track.name.slice(0, 64) }));
  const trackIds = new Set(tracks.map((track) => track.id));
  if (!trackIds.has(VIDEO_TRACK_ID) || !trackIds.has(VOICE_TRACK_ID)) return null;

  const clips: TimelineClip[] = [];
  for (const rawClip of raw.clips) {
    if (!rawClip || typeof rawClip !== 'object') return null;
    const clip = rawClip as Partial<TimelineClip>;
    if (
      typeof clip.id !== 'string' ||
      clip.id.length === 0 ||
      clip.id.length > 128 ||
      typeof clip.trackId !== 'string' ||
      !trackIds.has(clip.trackId) ||
      typeof clip.sourceId !== 'string' ||
      clip.sourceId.length === 0 ||
      clip.sourceId.length > 256
    ) {
      return null;
    }
    const sourceIn = sanitizeNumber(clip.sourceIn, 0, MAX_TIMELINE_SECONDS, NaN);
    const sourceOut = sanitizeNumber(clip.sourceOut, 0, MAX_TIMELINE_SECONDS, NaN);
    const timelineStart = sanitizeNumber(clip.timelineStart, 0, MAX_TIMELINE_SECONDS, NaN);
    if (
      !Number.isFinite(sourceIn) ||
      !Number.isFinite(sourceOut) ||
      !Number.isFinite(timelineStart) ||
      sourceOut - sourceIn < MIN_CLIP_DURATION / 2
    ) {
      return null;
    }
    clips.push({
      id: clip.id,
      trackId: clip.trackId,
      linkId: typeof clip.linkId === 'string' && clip.linkId.length <= 128 ? clip.linkId : null,
      label: typeof clip.label === 'string' ? clip.label.slice(0, 120) : 'Take',
      sourceId: clip.sourceId,
      sourceIn: round3(sourceIn),
      sourceOut: round3(sourceOut),
      timelineStart: round3(timelineStart),
      enabled: clip.enabled !== false,
      speed: sanitizeNumber(clip.speed, 0.1, 10, 1),
      gainDb: sanitizeNumber(clip.gainDb, -60, 12, 0),
      fadeInSec: sanitizeNumber(clip.fadeInSec, 0, 30, 0),
      fadeOutSec: sanitizeNumber(clip.fadeOutSec, 0, 30, 0),
    });
  }
  const clipIds = new Set(clips.map((clip) => clip.id));
  if (clipIds.size !== clips.length) return null;
  return {
    version: 1,
    fps: Math.max(1, Math.min(240, Math.round(sanitizeNumber(raw.fps, 1, 240, 30)))),
    tracks,
    clips,
  };
}
