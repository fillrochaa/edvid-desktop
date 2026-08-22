// O CORTE LIMPO, decidido e montado pelo APLICATIVO.
//
// Ate a 0.18.2 quem conduzia era o agente: transcrever, rodar o helper de
// corte, cortar com FFmpeg e escrever o EDL. Funciona quando o modelo e forte
// e falha quando nao e — medido no provedor gratuito do aluno, o agente
// simplesmente NAO agia em 13 de 20 tentativas: devolvia um tutorial de como
// editar video na mao. Nada disso e criativo: e a mesma sequencia de comandos
// toda vez. Entao virou codigo, e roda igual em qualquer IA conectada — ou sem
// IA nenhuma.
//
// Este modulo e a parte pura: ordem das fontes, plano de corte e o resumo em
// portugues. Quem executa vive no main, com os runtimes empacotados.

export type CleanCutRange = {
  source: string;
  beat: string;
  start: number;
  end: number;
};

export type CleanCutEdl = {
  version: number;
  sources: Record<string, string>;
  ranges: CleanCutRange[];
  total_duration_s: number;
};

// Ordem das fontes: a MESMA da timeline, senao o corte sai numa ordem e o
// aluno ve outra. Ordem natural — "cena2" antes de "cena10".
export function orderSources(names: readonly string[]): string[] {
  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  return [...names].sort(collator.compare);
}

export function parseEdl(raw: unknown): CleanCutEdl | null {
  if (!raw || typeof raw !== 'object') return null;
  const document = raw as Record<string, unknown>;
  const ranges = Array.isArray(document.ranges) ? document.ranges : [];
  const parsed: CleanCutRange[] = [];
  for (const entry of ranges) {
    const item = entry as Record<string, unknown>;
    const start = Number(item.start);
    const end = Number(item.end);
    const source = typeof item.source === 'string' ? item.source : '';
    if (!source || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    parsed.push({ source, beat: typeof item.beat === 'string' ? item.beat : '', start, end });
  }
  if (!parsed.length) return null;
  const sources = (document.sources && typeof document.sources === 'object')
    ? (document.sources as Record<string, string>)
    : {};
  return {
    version: Number(document.version) || 1,
    sources,
    ranges: parsed,
    total_duration_s: Number(document.total_duration_s)
      || parsed.reduce((total, range) => total + (range.end - range.start), 0),
  };
}

// Corte de UMA passagem: trim por bloco e concat, sem arquivo intermediario.
//
// Nao e concat por demuxer com copia de stream: o corte cairia no keyframe
// mais proximo e a fala entraria cortada no meio da palavra. Reencodar e o
// preco da precisao — e o corte limpo e a base de tudo que vem depois.
export function ffmpegCutArgs(input: {
  inputs: readonly string[];
  ranges: readonly CleanCutRange[];
  sourceIndex: Readonly<Record<string, number>>;
  output: string;
}): string[] {
  const { inputs, ranges, sourceIndex, output } = input;
  if (!inputs.length) throw new Error('Nenhum vídeo de origem para cortar.');
  if (!ranges.length) throw new Error('Nenhum trecho para manter.');
  const parts: string[] = [];
  const labels: string[] = [];
  ranges.forEach((range, index) => {
    const stream = sourceIndex[range.source];
    if (stream === undefined) throw new Error(`O corte aponta uma origem desconhecida: ${range.source}`);
    const start = range.start.toFixed(3);
    const end = range.end.toFixed(3);
    parts.push(`[${stream}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`);
    parts.push(`[${stream}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`);
    labels.push(`[v${index}][a${index}]`);
  });
  parts.push(`${labels.join('')}concat=n=${ranges.length}:v=1:a=1[v][a]`);
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-stats',
    ...inputs.flatMap((file) => ['-i', file]),
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', '[a]',
    // veryfast porque a fonte costuma ser 4K e o aluno espera olhando: o corte
    // limpo e material de trabalho, nao a entrega final.
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ];
}

// Comando da transcricao. O modelo e o alinhamento em portugues ja estao no
// cache do aplicativo e o ambiente roda offline.
export function whisperxArgs(input: {
  media: string;
  model: string;
  outputDirectory: string;
}): string[] {
  return [
    '-B', '-m', 'whisperx', input.media,
    '--model', input.model,
    '--language', 'pt',
    '--output_dir', input.outputDirectory,
    '--output_format', 'json',
    '--device', 'cpu',
    '--compute_type', 'int8',
  ];
}

// Comando do helper que DECIDE os cortes. Um trio por arquivo, na ordem da
// concatenacao — e o contrato que o proprio helper documenta.
export function cleanCutArgs(input: {
  helper: string;
  files: ReadonlyArray<{ transcript: string; media: string; source: string }>;
  output: string;
  minPause?: number;
  keep?: number;
}): string[] {
  const args = ['-B', input.helper];
  for (const file of input.files) {
    args.push('--transcript', file.transcript, '--audio', file.media, '--source', file.source);
  }
  args.push('-o', input.output);
  if (input.minPause !== undefined) args.push('--min-pause', String(input.minPause));
  if (input.keep !== undefined) args.push('--keep', String(input.keep));
  return args;
}

// O resumo que o aluno le no chat. Numeros do proprio corte, em portugues, sem
// nome de arquivo nem termo tecnico.
export function cleanCutSummary(edl: CleanCutEdl, originalSeconds: number): string {
  const kept = edl.total_duration_s;
  const removed = Math.max(0, originalSeconds - kept);
  const percent = originalSeconds > 0 ? Math.round((removed / originalSeconds) * 100) : 0;
  const clock = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}min ${String(total % 60).padStart(2, '0')}s`;
  };
  const blocks = edl.ranges.length;
  return [
    `Corte limpo pronto: ${blocks} ${blocks === 1 ? 'bloco' : 'blocos'} de fala.`,
    `Tirei ${clock(removed)} de pausa e silêncio (${percent}%), e o vídeo ficou com ${clock(kept)}.`,
    'Assista no preview e aprove para escolher os estilos.',
  ].join(' ');
}
