import type { EdlJcutEntry, EdlRange } from './timeline-model';
import { asText } from './timeline-model';

// J-Cut deterministico aplicado pelo APLICATIVO, nunca pelo agente: o video
// do corte e copiado byte a byte (c:v copy) e somente o audio e remontado,
// antecipando a fala da cena seguinte por cima do fim da anterior com um
// crossfade curto. Como o video nao e reencodado e a soma das pecas de audio
// fecha exatamente na duracao do video, dessincronia e impossivel por
// construcao — era o que acontecia quando o agente re-renderizava "com
// J-cuts" por conta propria.

export const JCUT_LEAD_SECONDS = 0.15;
// Antecipacao menor que isso nao e audivel como J-cut; vira corte seco.
const MIN_LEAD_SECONDS = 0.03;
// A antecipacao nunca consome mais que este pedaco dos takes vizinhos.
const MAX_LEAD_FRACTION = 0.45;

export type JcutSegmentPlan = {
  beat: string;
  sourceId: string;
  // Tempos no ARQUIVO-FONTE (segundos).
  sourceIn: number;
  sourceOut: number;
  // Posicao do video no arquivo de saida.
  videoStart: number;
  videoDuration: number;
  // Antecipacao de audio aplicada no INICIO deste take (0 no primeiro e nas
  // junções onde nao ha folga para o crossfade).
  lead: number;
};

export type JcutPlan = {
  segments: JcutSegmentPlan[];
  totalDuration: number;
  timeline: EdlJcutEntry[];
  // Junções que de fato ganharam antecipacao (> 0).
  leadsApplied: number;
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function planJcut(ranges: EdlRange[], leadSeconds = JCUT_LEAD_SECONDS): JcutPlan | null {
  const valid = ranges.filter(
    (range) =>
      typeof range.start === 'number' &&
      typeof range.end === 'number' &&
      Number.isFinite(range.start) &&
      Number.isFinite(range.end) &&
      range.start >= 0 &&
      range.end - range.start > MIN_LEAD_SECONDS,
  );
  // O plano so vale quando TODOS os ranges sao validos: o jcut_timeline e
  // pareado 1:1 com os ranges do EDL na migracao da timeline.
  if (valid.length !== ranges.length || ranges.length < 2) return null;

  const segments: JcutSegmentPlan[] = [];
  let cursor = 0;
  let leadsApplied = 0;
  ranges.forEach((range, index) => {
    const start = range.start as number;
    const end = range.end as number;
    const duration = end - start;
    let lead = 0;
    if (index > 0) {
      const previous = ranges[index - 1];
      const previousDuration = (previous.end as number) - (previous.start as number);
      lead = Math.min(
        leadSeconds,
        // O audio antecipado vem do proprio arquivo-fonte, ANTES do in do
        // take: precisa existir material gravado ali.
        start,
        MAX_LEAD_FRACTION * previousDuration,
        MAX_LEAD_FRACTION * duration,
      );
      if (!(lead >= MIN_LEAD_SECONDS)) lead = 0;
      if (lead > 0) leadsApplied += 1;
    }
    segments.push({
      beat: asText(range.beat) || `Take ${String(index + 1).padStart(2, '0')}`,
      sourceId: asText(range.source),
      sourceIn: round3(start),
      sourceOut: round3(end),
      videoStart: round3(cursor),
      videoDuration: round3(duration),
      lead: round3(lead),
    });
    cursor += duration;
  });
  if (leadsApplied === 0) return null;

  const timeline: EdlJcutEntry[] = segments.map((segment) => ({
    beat: segment.beat,
    ...(segment.sourceId ? { source: segment.sourceId } : {}),
    video_start_in_output: segment.videoStart,
    video_duration: segment.videoDuration,
    audio_start_in_output: round3(segment.videoStart - segment.lead),
    audio_duration: round3(segment.videoDuration + segment.lead),
  }));

  return {
    segments,
    totalDuration: round3(cursor),
    timeline,
    leadsApplied,
  };
}

// Extracao da peca de audio de um take: comeca "lead" segundos antes do in
// do video e termina no out. WAV 48 kHz estereo para a mixagem ser exata.
export function extractionArgs(
  segment: JcutSegmentPlan,
  sourcePath: string,
  outputWav: string,
): string[] {
  const from = round3(segment.sourceIn - segment.lead);
  const duration = round3(segment.videoDuration + segment.lead);
  return [
    '-hide_banner', '-nostdin', '-y',
    '-ss', from.toFixed(3),
    '-i', sourcePath,
    '-t', duration.toFixed(3),
    '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le',
    outputWav,
  ];
}

// Mixagem em UM comando: cada peca ganha fade-in no proprio lead, fade-out
// sob o lead da peca seguinte, e e posicionada por adelay no tempo exato do
// arquivo de saida; o amix soma tudo sem normalizar e o atrim fecha a
// duracao no total do video.
export function mixArgs(plan: JcutPlan, pieceWavs: string[], outputWav: string): string[] {
  const chains: string[] = [];
  const labels: string[] = [];
  plan.segments.forEach((segment, index) => {
    const nextLead = plan.segments[index + 1]?.lead ?? 0;
    const pieceDuration = segment.videoDuration + segment.lead;
    const steps: string[] = [];
    if (segment.lead > 0) {
      steps.push(`afade=t=in:st=0:d=${segment.lead.toFixed(3)}`);
    }
    if (nextLead > 0) {
      steps.push(`afade=t=out:st=${round3(pieceDuration - nextLead).toFixed(3)}:d=${nextLead.toFixed(3)}`);
    }
    const delayMs = Math.max(0, Math.round((segment.videoStart - segment.lead) * 1000));
    steps.push(`adelay=${delayMs}:all=1`);
    chains.push(`[${index}:a]${steps.join(',')}[p${index}]`);
    labels.push(`[p${index}]`);
  });
  const graph = `${chains.join(';')};${labels.join('')}amix=inputs=${plan.segments.length}:normalize=0:dropout_transition=0,atrim=end=${plan.totalDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`;
  return [
    '-hide_banner', '-nostdin', '-y',
    ...pieceWavs.flatMap((wav) => ['-i', wav]),
    '-filter_complex', graph,
    '-map', '[aout]',
    '-c:a', 'pcm_s16le',
    outputWav,
  ];
}

// Remux final: o video do corte segue INTACTO (c:v copy); so a trilha de
// audio e substituida pela mixagem com J-cuts.
export function muxArgs(cutPath: string, mixedWav: string, outputPath: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', cutPath,
    '-i', mixedWav,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ];
}
