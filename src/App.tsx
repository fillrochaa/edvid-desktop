import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import edvidIcon from './brand/edvid-icon.png';
import edvidLogo from './brand/edvid-logo.png';
// Thumbnails renderizadas pelo proprio template do Remotion
// (scripts/render-style-thumbs.mjs) — fieis ao resultado da Fase 2.
import thumbHeadlineOutline from './brand/thumbs/headline-outline.png';
import thumbHeadlineCard from './brand/thumbs/headline-card.png';
import thumbHeadlineRealce from './brand/thumbs/headline-realce.png';
import thumbHeadlineMisto from './brand/thumbs/headline-misto.png';
import thumbCaptionKaraoke from './brand/thumbs/caption-karaoke.mp4';
import thumbCaptionStacked from './brand/thumbs/caption-stacked.mp4';
import thumbCaptionScatter from './brand/thumbs/caption-scatter.mp4';
import thumbCaptionSimples from './brand/thumbs/caption-simples.png';
import thumbCaptionSerifada from './brand/thumbs/caption-serifada.png';
import thumbCaptionClassica from './brand/thumbs/caption-classica.png';

const headlineThumbs: Record<Exclude<HeadlineStyle, 'none'>, string> = {
  outline: thumbHeadlineOutline,
  card: thumbHeadlineCard,
  realce: thumbHeadlineRealce,
  misto: thumbHeadlineMisto,
};

// Estilos animados mostram um clipe em loop; os estáticos, um frame.
const captionThumbs: Record<Exclude<CaptionStyle, 'none'>, { kind: 'video' | 'image'; src: string }> = {
  karaoke: { kind: 'video', src: thumbCaptionKaraoke },
  stacked: { kind: 'video', src: thumbCaptionStacked },
  scatter: { kind: 'video', src: thumbCaptionScatter },
  simples: { kind: 'image', src: thumbCaptionSimples },
  serifada: { kind: 'image', src: thumbCaptionSerifada },
  classica: { kind: 'image', src: thumbCaptionClassica },
};
import type {
  AppUpdateState,
  CodexAccountState,
  CodexApproval,
  CodexEvent,
  DesktopInfo,
  MemberAuthState,
  Phase2RenderState,
  ProjectSummary,
  RuntimePackState,
  ProjectWorkspace,
  RemotionRuntimeState,
  RuntimeCheck,
  SourceWaveform,
  TimelineClip,
  TimelineModel,
  WhisperModelState,
} from './shared';
import {
  VIDEO_TRACK_ID,
  VOICE_TRACK_ID,
  applyTrim,
  clipDuration,
  clipEnd,
  deleteClipLeaveGap,
  deriveSegments,
  edlRangesFromModel,
  modelsEqual,
  nextProgrammeIndexAfter,
  playbackProgramme,
  programmeIndexAt,
  razorAtTime,
  rippleDeleteClip,
  round3,
  snapCandidateTimes,
  snapTime,
  sortedTrackClips,
  timelineModelDuration,
  trimAllowedDelta,
  type PlaybackSegment,
  type TrimEdge,
} from './timeline-model';

const labels: Record<RuntimeCheck['name'], string> = {
  node: 'Node.js',
  npm: 'npm',
  ffmpeg: 'FFmpeg',
  ffprobe: 'FFprobe',
  uv: 'uv',
  'yt-dlp': 'yt-dlp',
  python: 'Python',
  whisperx: 'WhisperX',
  'codex-app-server': 'Codex',
};

const runtimeNames = Object.keys(labels) as RuntimeCheck['name'][];

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
};

type CorrectionRange = {
  id: string;
  start: number;
  end: number;
  note: string;
};

type WorkTab = 'edit' | 'styles';
type EditStyle = 'limpa' | 'split' | 'split2';
type HeadlineStyle = 'outline' | 'card' | 'realce' | 'misto' | 'none';
type CaptionStyle =
  | 'karaoke'
  | 'stacked'
  | 'scatter'
  | 'simples'
  | 'serifada'
  | 'classica'
  | 'none';

type StyleSetup = {
  edit: EditStyle;
  headline: HeadlineStyle;
  captions: CaptionStyle;
  accent: string;
  elements: {
    tracking: boolean;
    zoomAuto: boolean;
    zoomCuts: boolean;
    flashCut: boolean;
    musicAI: boolean;
  };
  note: string;
};

type IconName =
  | 'add'
  | 'arrowDown'
  | 'captions'
  | 'chat'
  | 'check'
  | 'chevron'
  | 'enter'
  | 'folder'
  | 'image'
  | 'layers'
  | 'more'
  | 'music'
  | 'pause'
  | 'pin'
  | 'play'
  | 'scissors'
  | 'send'
  | 'settings'
  | 'skipBack'
  | 'stop'
  | 'skipForward'
  | 'sparkles'
  | 'text'
  | 'trash'
  | 'video'
  | 'volume'
  | 'volumeOff'
  | 'waveform';

const initialAccount: CodexAccountState = {
  status: 'starting',
  account: null,
  requiresOpenaiAuth: true,
};

const defaultStyleSetup: StyleSetup = {
  edit: 'limpa',
  headline: 'outline',
  captions: 'karaoke',
  accent: '#ff5200',
  elements: {
    tracking: false,
    zoomAuto: true,
    zoomCuts: true,
    flashCut: false,
    musicAI: false,
  },
  note: '',
};

const editStyles: Array<{ id: EditStyle; name: string; description: string }> = [
  { id: 'limpa', name: 'Limpa', description: 'Pessoa em tela cheia; imagens entram como inserts.' },
  { id: 'split', name: 'Tela dividida', description: 'Imagem em cima e pessoa na parte inferior.' },
  { id: 'split2', name: 'Tela dividida 2', description: 'Pessoa em cima e imagem na parte inferior.' },
];

const headlineStyles: Array<{ id: HeadlineStyle; name: string }> = [
  { id: 'outline', name: 'Outline' },
  { id: 'card', name: 'Card' },
  { id: 'realce', name: 'Realce' },
  { id: 'misto', name: 'Misto' },
  { id: 'none', name: 'Sem headline' },
];

const captionStyles: Array<{ id: CaptionStyle; name: string; kind: string }> = [
  { id: 'karaoke', name: 'Karaokê', kind: 'Animada' },
  { id: 'stacked', name: 'Empilhada', kind: 'Animada' },
  { id: 'scatter', name: 'Dispersa', kind: 'Animada' },
  { id: 'simples', name: 'Simples', kind: 'Estática' },
  { id: 'serifada', name: 'Serifada', kind: 'Estática' },
  { id: 'classica', name: 'Clássica', kind: 'Estática' },
  { id: 'none', name: 'Sem legendas', kind: 'Desativada' },
];

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    add: <path d="M8 2.3v11.4M2.3 8h11.4" />,
    arrowDown: <path d="m3.2 6 4.8 4.7L12.8 6" />,
    captions: <><rect x="1.5" y="3" width="13" height="10" rx="2.2" /><path d="M4 8.5h3M9 8.5h3" /></>,
    chat: <path d="M2 2.5h12v8.6H7l-3.7 2.4.9-2.4H2z" />,
    check: <path d="m2.6 8.2 3.2 3.1 7.6-7.4" />,
    chevron: <path d="m6 3.2 4.8 4.8L6 12.8" />,
    enter: <path d="M12.8 3.6v3.6a2.4 2.4 0 0 1-2.4 2.4H3.6M6.5 6.6 3.4 9.6l3.1 3" />,
    folder: <path d="M1.5 4.2h5l1.2 1.5h6.8v7.2h-13z" />,
    image: <><rect x="1.5" y="2.2" width="13" height="11.6" rx="2" /><path d="m3.5 11 3-3 2.1 2 1.7-1.5 2.2 2.5M11.3 5.5h.1" /></>,
    layers: <><path d="m8 1.8 6.2 3.4L8 8.6 1.8 5.2z" /><path d="m2 8 6 3.3L14 8M2 10.8l6 3.3 6-3.3" /></>,
    more: <path d="M3.4 8h.01M8 8h.01M12.6 8h.01" />,
    music: <><path d="M6 12.2V4l7-1.5v8" /><circle cx="3.9" cy="12.3" r="2" /><circle cx="10.9" cy="10.7" r="2" /></>,
    pause: <><path d="M5.2 3v10M10.8 3v10" /></>,
    pin: <path d="m5 2 6 1-1.4 3 2.1 2.1-3 1.1-2.5 4.5-.5-4.9-3-1.4 2.4-1.8z" />,
    play: <path d="m5 2.5 8 5.5-8 5.5z" />,
    scissors: <><circle cx="4.2" cy="4.4" r="1.9" /><circle cx="4.2" cy="11.6" r="1.9" /><path d="m5.7 5.6 8 6.6M5.7 10.4l8-6.6" /></>,
    send: <path d="M8 12.8V3.4M3.9 7.4 8 3.3l4.1 4.1" />,
    stop: <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6" />,
    settings: <g transform="scale(.6667)"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></g>,
    skipBack: <><path d="M4 3v10M12.8 3.2 5.4 8l7.4 4.8z" /></>,
    skipForward: <><path d="M12 3v10M3.2 3.2 10.6 8l-7.4 4.8z" /></>,
    sparkles: <><path d="M8 1.5 9.2 5 12.5 6.2 9.2 7.4 8 11 6.8 7.4 3.5 6.2 6.8 5z" /><path d="m12.8 10 .5 1.5 1.4.5-1.4.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" /></>,
    text: <path d="M3.2 3.2h9.6M8 3.2v9.6M5.8 12.8h4.4" />,
    trash: <><path d="M3.2 4.6h9.6M6 4.6V2.8h4v1.8M4.5 4.6l.7 8.5h5.6l.7-8.5M6.8 7v3.7M9.2 7v3.7" /></>,
    video: <><rect x="1.4" y="3" width="10" height="10" rx="2" /><path d="m11.4 6.2 3.2-1.8v7.2l-3.2-1.8" /></>,
    volume: <><path d="M2 6h3l3-2.7v9.4L5 10H2z" /><path d="M10 5.4a3.2 3.2 0 0 1 0 5.2M12 3.5a5.7 5.7 0 0 1 0 9" /></>,
    volumeOff: <><path d="M2 6h3l3-2.7v9.4L5 10H2z" /><path d="m10.3 6 3.7 4M14 6l-3.7 4" /></>,
    waveform: <path d="M1 8h2l1.2-4 2 8 2.2-9 2 7 1.2-4 1.2 2H15" />,
  };
  return <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">{paths[name]}</svg>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatTimecode(seconds: number, fps: number): string {
  const nominalFps = Math.max(1, Math.round(fps || 30));
  const totalFrames = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * nominalFps));
  const frames = totalFrames % nominalFps;
  const totalSeconds = Math.floor(totalFrames / nominalFps);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

const TIMELINE_LANE_START = 46;

function timelinePoint(progress: number): string {
  const clamped = Math.max(0, Math.min(progress, 1));
  return `calc(${TIMELINE_LANE_START}px + ${clamped * 100}% - ${clamped * TIMELINE_LANE_START}px)`;
}

function timelineSpan(progress: number): string {
  const clamped = Math.max(0, Math.min(progress, 1));
  return `calc(${clamped * 100}% - ${clamped * TIMELINE_LANE_START}px)`;
}

function cleanAssistantText(text: string): string {
  return text
    .replace(/^\s*\[[^\]\n]+\]\s*\(\s*<?(?:file:\/\/)?\/(?:Users|home|Volumes)\/[^)\n>]+>?\s*\)\s*$/gimu, '')
    .replace(/^\s*(?:arquivo|caminho|saída|output)\s*:\s*<?\/(?:Users|home|Volumes)\/.*$/gimu, '')
    .replace(/^\s*<?(?:file:\/\/)?\/(?:Users|home|Volumes)\/[^>\n]+>?\s*$/gimu, '')
    .replace(/^\s*(?:aprova\s+este\s+corte\?|se\s+aprovar.*(?:diga|responda)).*$/gimu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function asksForCleanCutApproval(text: string): boolean {
  return /(?:corte\s+limpo|corte).{0,80}(?:pronto\s+para\s+(?:sua\s+)?aprova|aprova(?:r|ção)|aprova\s+este\s+corte)/isu.test(text);
}

function styleStorageKey(directory: string): string {
  return `edvid:style:${directory}`;
}

// Historico do chat por projeto. Fechar e reabrir o aplicativo nao pode zerar
// a conversa nem reoferecer os botoes de inicio com o processo ja andando.
type StoredChat = {
  messages: ChatMessage[];
  handledCutApprovalId: string | null;
  jcutApplied: boolean;
};

function chatStorageKey(directory: string): string {
  return `edvid:chat:${directory}`;
}

function readStoredChat(directory: string): StoredChat {
  const empty: StoredChat = { messages: [], handledCutApprovalId: null, jcutApplied: false };
  try {
    const parsed = JSON.parse(localStorage.getItem(chatStorageKey(directory)) ?? 'null') as
      | Partial<StoredChat>
      | null;
    if (!parsed || !Array.isArray(parsed.messages)) return empty;
    return {
      messages: parsed.messages.filter((message): message is ChatMessage => (
        Boolean(message) &&
        typeof message.id === 'string' &&
        (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
        typeof message.text === 'string'
      )),
      handledCutApprovalId:
        typeof parsed.handledCutApprovalId === 'string' ? parsed.handledCutApprovalId : null,
      jcutApplied: parsed.jcutApplied === true,
    };
  } catch {
    return empty;
  }
}

function readStoredStyle(directory: string, fallback: StyleSetup = defaultStyleSetup): StyleSetup {
  try {
    const parsed = JSON.parse(localStorage.getItem(styleStorageKey(directory)) ?? 'null') as Partial<StyleSetup> | null;
    if (!parsed) return fallback;
    return {
      ...fallback,
      ...parsed,
      elements: { ...fallback.elements, ...parsed.elements },
    };
  } catch {
    return fallback;
  }
}

function EditStylePreview({ style }: { style: EditStyle }) {
  return (
    <div className={`edit-style-preview ${style}`}>
      <div className="preview-art" />
      <div className="preview-person"><span /></div>
      <div className="preview-caption" />
    </div>
  );
}

function HeadlinePreview({ style }: { style: HeadlineStyle }) {
  if (style === 'none') return <div className="none-preview">Sem texto</div>;
  // Frame real renderizado pelo template; o accent das thumbnails e o padrao
  // laranja — a cor escolhida vale no render final.
  return <img className="style-thumb" src={headlineThumbs[style]} alt="" draggable={false} />;
}

function CaptionPreview({ style }: { style: CaptionStyle }) {
  if (style === 'none') return <div className="none-preview">Sem legendas</div>;
  const thumb = captionThumbs[style];
  if (thumb.kind === 'video') {
    return <video className="style-thumb" src={thumb.src} autoPlay loop muted playsInline disablePictureInPicture />;
  }
  return <img className="style-thumb" src={thumb.src} alt="" draggable={false} />;
}

function ChoiceCard({
  selected,
  title,
  subtitle,
  label,
  onClick,
  children,
}: {
  selected: boolean;
  title?: string;
  subtitle?: string;
  label?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`choice-card ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      aria-label={title ?? label}
      onClick={onClick}
    >
      <div className="choice-visual">{children}</div>
      {title && <span className="choice-name">{title}</span>}
      {subtitle && <span className="choice-description">{subtitle}</span>}
      <span className="choice-check"><Icon name="check" /></span>
    </button>
  );
}

function TimelineTrack({
  icon,
  label,
  tone,
  children,
}: {
  icon: IconName;
  label: string;
  tone: string;
  children: ReactNode;
}) {
  return (
    <div className="studio-track">
      <div className={`studio-track-label ${tone}`} title={label}>
        <Icon name={icon} />
      </div>
      <div className="studio-lane">{children}</div>
    </div>
  );
}

function EditorWorkspace({
  workspace,
  style,
  styleApplied,
  corrections,
  onCorrectionsChange,
  onApplyCorrections,
  applyingCorrections,
  onTimelineModelChange,
  onApplyTimelineEdits,
}: {
  workspace: ProjectWorkspace | null;
  style: StyleSetup;
  styleApplied: boolean;
  corrections: CorrectionRange[];
  onCorrectionsChange: (corrections: CorrectionRange[]) => void;
  onApplyCorrections: (corrections: CorrectionRange[]) => Promise<boolean>;
  applyingCorrections: boolean;
  onTimelineModelChange: (model: TimelineModel, commit: boolean) => void;
  onApplyTimelineEdits: () => Promise<boolean>;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const currentTimeRef = useRef(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [draftRange, setDraftRange] = useState<{ start: number; end: number } | null>(null);
  const [draftNote, setDraftNote] = useState('');
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomStateRef = useRef(1);
  const pinchZoomRef = useRef<(event: WheelEvent) => void>(() => {});
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [inGap, setInGap] = useState(false);
  const correctionHistoryRef = useRef<CorrectionRange[][]>([]);
  const modelHistoryRef = useRef<TimelineModel[]>([]);
  const modelFutureRef = useRef<TimelineModel[]>([]);
  const actionOrderRef = useRef<Array<'model' | 'corrections'>>([]);
  const baselineModelRef = useRef<TimelineModel | null>(null);
  const baselineKeyRef = useRef<string | null>(null);
  const modelRef = useRef<TimelineModel | null>(null);
  const mappedRef = useRef(false);
  const playingRef = useRef(false);
  const inGapRef = useRef(false);
  const programmeRef = useRef<PlaybackSegment[]>([]);
  const mappedIndexRef = useRef(-1);
  const gapClockRef = useRef<number | null>(null);
  const pendingVideoSeekRef = useRef<{ sourceTime: number; resume: boolean } | null>(null);
  const trimDragRef = useRef<{
    clipId: string;
    edge: TrimEdge;
    baseModel: TimelineModel;
    originX: number;
    secondsPerPixel: number;
    appliedDelta: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const zoomAnchorRef = useRef<{ progress: number; viewportX: number } | null>(null);
  const activeSourceIdRef = useRef<string | null>(null);
  const timelineSeekPointerRef = useRef<number | null>(null);
  const seekRef = useRef<(value: number) => void>(() => {});
  const setVideoToProgrammeRef = useRef<(index: number, sourceTime: number, resume: boolean) => void>(() => {});

  const media = workspace?.media ?? null;
  const model = workspace?.timelineModel ?? null;
  const synced = workspace?.timelineModelSynced ?? true;
  const sources = workspace?.sources ?? [];
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const sourceDurations = useMemo(
    () => Object.fromEntries(sources.map((source) => [source.id, source.duration])),
    [sources],
  );
  modelRef.current = model;

  // A referência de comparação para "há edições pendentes" é o modelo recebido
  // ao abrir/atualizar o projeto. O token da mídia muda a cada carga.
  const loadKey = `${workspace?.project.directory ?? ''}:${media?.url ?? ''}`;
  if (baselineKeyRef.current !== loadKey) {
    baselineKeyRef.current = loadKey;
    baselineModelRef.current = model;
  }

  const timelineSegments = workspace?.timeline?.segments ?? [];
  const timelineDuration = timelineSegments.reduce(
    (maximum, segment) => Math.max(maximum, segment.start + segment.duration),
    0,
  );
  const [duration, setDuration] = useState(workspace?.media?.duration ?? timelineDuration);
  const modelDuration = model ? timelineModelDuration(model) : 0;
  const dirty = useMemo(
    () => (model ? !synced || !modelsEqual(model, baselineModelRef.current) : false),
    [model, synced],
  );
  const programme = useMemo(() => (model ? playbackProgramme(model) : []), [model]);

  // Com edições pendentes o render deixa de corresponder ao modelo; o preview
  // passa a mapear a timeline para os arquivos-fonte, sem render completo.
  const mapped = dirty && programme.length > 0;
  mappedRef.current = mapped;
  programmeRef.current = programme;
  const effectiveDuration = mapped ? modelDuration : duration || timelineDuration || modelDuration;
  const fps = model?.fps ?? media?.fps ?? 30;
  const phase = media?.kind === 'final' || styleApplied ? 2 : 1;
  const progress = effectiveDuration > 0 ? Math.min(1, currentTime / effectiveDuration) : 0;
  const activeSource = activeSourceId ? sourceById.get(activeSourceId) ?? null : null;
  const videoSrc = mapped ? activeSource?.url ?? undefined : media?.url;
  const selectedClip = selectedClipId
    ? model?.clips.find((clip) => clip.id === selectedClipId) ?? null
    : null;
  const selectedLinkId = selectedClip?.linkId ?? null;
  const videoClips = model ? sortedTrackClips(model, VIDEO_TRACK_ID) : [];
  const voiceClips = useMemo(
    () => (model ? sortedTrackClips(model, VOICE_TRACK_ID) : []),
    [model],
  );
  const canDiscard = Boolean(
    model && baselineModelRef.current && !modelsEqual(model, baselineModelRef.current),
  );

  // Ondas sonoras: os picos vêm do main uma vez por fonte e cada clipe recorta
  // o próprio trecho. null marca fonte sem áudio (não insiste de novo).
  const [waveforms, setWaveforms] = useState<Record<string, SourceWaveform | null>>({});
  const requestedWaveformsRef = useRef<Set<string>>(new Set());
  const workspaceDirectory = workspace?.project.directory ?? null;

  useEffect(() => {
    requestedWaveformsRef.current.clear();
    setWaveforms({});
  }, [workspaceDirectory]);

  useEffect(() => {
    for (const clip of voiceClips) {
      const sourceId = clip.sourceId;
      if (requestedWaveformsRef.current.has(sourceId)) continue;
      const url = sourceById.get(sourceId)?.url;
      if (!url) continue;
      requestedWaveformsRef.current.add(sourceId);
      void window.edvidDesktop.getSourceWaveform(url)
        .then((waveform) => setWaveforms((current) => ({ ...current, [sourceId]: waveform })))
        .catch(() => setWaveforms((current) => ({ ...current, [sourceId]: null })));
    }
  }, [voiceClips, sourceById]);

  const waveformPaths = useMemo(() => {
    const paths = new Map<string, string>();
    for (const clip of voiceClips) {
      const waveform = waveforms[clip.sourceId];
      if (!waveform || waveform.peaks.length === 0) continue;
      const speed = clip.speed || 1;
      const start = clip.sourceIn;
      const end = clip.sourceIn + clipDuration(clip) * speed;
      const buckets = waveform.bucketsPerSecond;
      const first = Math.max(0, Math.floor(start * buckets));
      const last = Math.min(waveform.peaks.length, Math.ceil(end * buckets));
      const available = last - first;
      if (available < 2) continue;
      const count = Math.min(240, available);
      const top: string[] = [];
      const bottom: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const bucket = first + Math.floor(((available - 1) * index) / (count - 1));
        const amplitude = Math.max(0.03, Math.min(1, waveform.peaks[bucket] ?? 0));
        const x = ((index / (count - 1)) * 100).toFixed(2);
        top.push(`${index === 0 ? 'M' : 'L'}${x} ${(16 - amplitude * 13).toFixed(2)}`);
        bottom.push(`L${x} ${(16 + amplitude * 13).toFixed(2)}`);
      }
      bottom.reverse();
      paths.set(clip.id, `${top.join(' ')} ${bottom.join(' ')} Z`);
    }
    return paths;
  }, [voiceClips, waveforms]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    currentTimeRef.current = 0;
    setCurrentTime(0);
    setPlaying(false);
    setMarkIn(null);
    setDraftRange(null);
    setDraftNote('');
    setSelectedClipId(null);
    setZoom(1);
    setActiveSourceId(null);
    setInGap(false);
    inGapRef.current = false;
    activeSourceIdRef.current = null;
    correctionHistoryRef.current = [];
    modelHistoryRef.current = [];
    modelFutureRef.current = [];
    actionOrderRef.current = [];
    trimDragRef.current = null;
    mappedIndexRef.current = -1;
    gapClockRef.current = null;
    pendingVideoSeekRef.current = null;
    setDuration(media?.duration ?? timelineDuration);
    // Reset apenas na troca de projeto/mídia (o token muda a cada carga);
    // edições do modelo alteram a duração e não podem limpar o histórico.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  function syncCurrentTime(value: number) {
    currentTimeRef.current = value;
    setCurrentTime(value);
  }

  function setGap(value: boolean) {
    inGapRef.current = value;
    setInGap(value);
  }

  function sourceUrlOf(sourceId: string | null): string | null {
    if (!sourceId) return null;
    return sourceById.get(sourceId)?.url ?? null;
  }

  function setVideoToProgramme(index: number, sourceTime: number, resume: boolean) {
    const segment = programmeRef.current[index];
    if (!segment) return;
    mappedIndexRef.current = index;
    setGap(false);
    const nextUrl = sourceUrlOf(segment.sourceId);
    const currentUrl = activeSourceIdRef.current
      ? sourceUrlOf(activeSourceIdRef.current)
      : media?.url ?? null;
    activeSourceIdRef.current = segment.sourceId;
    setActiveSourceId(segment.sourceId);
    const video = videoRef.current;
    if (video) video.playbackRate = segment.speed || 1;
    if (nextUrl && nextUrl !== currentUrl) {
      // O src muda; o seek acontece quando os novos metadados carregarem.
      pendingVideoSeekRef.current = { sourceTime, resume };
      return;
    }
    if (!video) return;
    try {
      video.currentTime = sourceTime;
    } catch {
      // A agulha continua responsiva enquanto os metadados carregam.
    }
    if (resume) void video.play().catch(() => setPlaying(false));
  }
  setVideoToProgrammeRef.current = setVideoToProgramme;

  // Rede de segurança do modo mapeado. O motor de rAF só roda enquanto o
  // React acha que está tocando; se o elemento voltar a tocar por fora desse
  // estado (retomada do navegador, promessa de play resolvendo tarde), o
  // motor não existe para segurar o corte e o arquivo-fonte corre inteiro.
  // O timeupdate vem do próprio elemento, então o limite vale sempre.
  function enforceMappedBoundary(video: HTMLVideoElement): void {
    if (!mappedRef.current || inGapRef.current) return;
    // Um seek em voo (troca de fonte pendente ou busca num arquivo grande)
    // ainda reporta o tempo antigo; tratar isso como "passou do fim" fazia a
    // borda avançar de segmento sozinha no meio de um clique na timeline.
    if (pendingVideoSeekRef.current || video.seeking) return;
    const currentProgramme = programmeRef.current;
    const index = mappedIndexRef.current;
    const segment = index >= 0 ? currentProgramme[index] : undefined;
    if (!segment) {
      video.pause();
      return;
    }
    const speed = segment.speed || 1;
    const sourceEnd = segment.sourceIn + (segment.timelineEnd - segment.timelineStart) * speed;
    // Só age quando o tempo PASSOU do fim do segmento. Antes do início não é
    // estouro: é um seek aterrissando.
    if (video.currentTime < sourceEnd - 0.01) {
      return;
    }
    const nextSegment = currentProgramme[index + 1];
    if (!nextSegment) {
      video.pause();
      syncCurrentTime(segment.timelineEnd);
      setPlaying(false);
      return;
    }
    if (nextSegment.timelineStart - segment.timelineEnd > 0.02) {
      inGapRef.current = true;
      setInGap(true);
      gapClockRef.current = null;
      mappedIndexRef.current = index + 1;
      video.pause();
      syncCurrentTime(segment.timelineEnd);
      return;
    }
    syncCurrentTime(nextSegment.timelineStart);
    setVideoToProgrammeRef.current(index + 1, nextSegment.sourceIn, !video.paused);
  }

  function seek(value: number) {
    const nextTime = Math.max(0, Math.min(value, effectiveDuration || 0));
    syncCurrentTime(nextTime);
    if (!mapped) {
      if (videoRef.current) {
        try {
          videoRef.current.currentTime = nextTime;
        } catch {
          // O estado da agulha continua responsivo enquanto os metadados carregam.
        }
      }
      return;
    }
    const currentProgramme = programmeRef.current;
    const index = programmeIndexAt(currentProgramme, nextTime);
    if (index >= 0) {
      const segment = currentProgramme[index];
      setVideoToProgramme(
        index,
        segment.sourceIn + (nextTime - segment.timelineStart) * segment.speed,
        playingRef.current,
      );
      return;
    }
    mappedIndexRef.current = nextProgrammeIndexAfter(currentProgramme, nextTime);
    gapClockRef.current = null;
    setGap(mappedIndexRef.current >= 0);
    videoRef.current?.pause();
  }
  seekRef.current = seek;

  async function togglePlayback() {
    if (mappedRef.current) {
      if (playingRef.current) {
        setPlaying(false);
        playingRef.current = false;
        // Uma troca de fonte em andamento não pode retomar contra esta pausa.
        if (pendingVideoSeekRef.current) {
          pendingVideoSeekRef.current = { ...pendingVideoSeekRef.current, resume: false };
        }
        videoRef.current?.pause();
        return;
      }
      const currentProgramme = programmeRef.current;
      if (currentProgramme.length === 0) return;
      const atEnd = currentTimeRef.current >= (effectiveDuration || 0) - 0.05;
      const target = atEnd ? 0 : currentTimeRef.current;
      syncCurrentTime(target);
      const index = programmeIndexAt(currentProgramme, target);
      if (index >= 0) {
        setPlaying(true);
        playingRef.current = true;
        const segment = currentProgramme[index];
        setVideoToProgramme(
          index,
          segment.sourceIn + (target - segment.timelineStart) * segment.speed,
          true,
        );
      } else {
        const nextIndex = nextProgrammeIndexAfter(currentProgramme, target);
        if (nextIndex < 0) return; // depois do último take não há o que tocar
        setPlaying(true);
        playingRef.current = true;
        mappedIndexRef.current = nextIndex;
        gapClockRef.current = null;
        setGap(true);
      }
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        setPlaying(false);
      }
    } else {
      video.pause();
    }
  }

  function jumpBy(seconds: number) {
    seek(currentTimeRef.current + seconds);
  }

  function stepByFrames(frames: number) {
    // O ref é atualizado na hora: o seek abaixo não pode "retomar" a
    // reprodução por ler um playingRef ainda não sincronizado pelo efeito.
    setPlaying(false);
    playingRef.current = false;
    videoRef.current?.pause();
    seek(currentTimeRef.current + frames / Math.max(fps, 1));
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }

  // Motor de reprodução: no modo normal a agulha segue o vídeo; no modo
  // mapeado o vídeo pula entre segmentos e um relógio próprio cobre os vazios.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    gapClockRef.current = null;
    const updatePlayhead = (timestamp: number) => {
      const video = videoRef.current;
      if (!mappedRef.current) {
        if (video) syncCurrentTime(video.currentTime);
      } else {
        const currentProgramme = programmeRef.current;
        const index = mappedIndexRef.current;
        if (inGapRef.current) {
          const previous = gapClockRef.current ?? timestamp;
          gapClockRef.current = timestamp;
          const nextTime = currentTimeRef.current + (timestamp - previous) / 1000;
          const segment = index >= 0 ? currentProgramme[index] : undefined;
          if (segment && nextTime >= segment.timelineStart) {
            syncCurrentTime(segment.timelineStart);
            setVideoToProgrammeRef.current(index, segment.sourceIn, true);
          } else if (!segment) {
            inGapRef.current = false;
            setInGap(false);
            setPlaying(false);
          } else {
            syncCurrentTime(nextTime);
          }
        } else if (video && index >= 0) {
          const segment = currentProgramme[index];
          const speed = segment.speed || 1;
          const sourceEnd = segment.sourceIn + (segment.timelineEnd - segment.timelineStart) * speed;
          if (video.currentTime >= sourceEnd - 0.03 || video.ended) {
            const nextSegment = currentProgramme[index + 1];
            if (!nextSegment) {
              video.pause();
              syncCurrentTime(segment.timelineEnd);
              setPlaying(false);
            } else if (nextSegment.timelineStart - segment.timelineEnd > 0.02) {
              inGapRef.current = true;
              setInGap(true);
              gapClockRef.current = null;
              mappedIndexRef.current = index + 1;
              video.pause();
              syncCurrentTime(segment.timelineEnd);
            } else {
              syncCurrentTime(nextSegment.timelineStart);
              setVideoToProgrammeRef.current(index + 1, nextSegment.sourceIn, true);
            }
          } else {
            const mappedTime = segment.timelineStart + (video.currentTime - segment.sourceIn) / speed;
            syncCurrentTime(Math.min(Math.max(mappedTime, segment.timelineStart), segment.timelineEnd));
          }
        } else if (index < 0) {
          // Sem segmento ativo nem gap: nada a reproduzir. Pausar o elemento
          // aqui e essencial — parar so o motor deixava o <video> correndo
          // sozinho pelo arquivo-fonte, exibindo o material bruto sem cortes.
          video?.pause();
          setPlaying(false);
        }
      }
      frame = window.requestAnimationFrame(updatePlayhead);
    };
    frame = window.requestAnimationFrame(updatePlayhead);
    return () => window.cancelAnimationFrame(frame);
  }, [playing]);

  // Invariante do transporte: parado significa vídeo parado. No modo mapeado
  // quem manda no <video> é o motor; sem isto, qualquer caminho que encerre o
  // motor sem pausar deixa o arquivo-fonte tocando inteiro por conta própria.
  useEffect(() => {
    if (!playing) videoRef.current?.pause();
  }, [playing]);

  // Ao entrar/sair do modo mapeado, realinha o vídeo com a agulha.
  useEffect(() => {
    if (mapped) {
      // Entrada (inclusive durante reprodução, ex.: razor com o vídeo
      // tocando): configura fonte e índice imediatamente; o seek retoma a
      // reprodução quando playingRef indicar.
      seekRef.current(currentTimeRef.current);
      return;
    }
    inGapRef.current = false;
    setInGap(false);
    setActiveSourceId(null);
    activeSourceIdRef.current = null;
    pendingVideoSeekRef.current = { sourceTime: currentTimeRef.current, resume: false };
    const video = videoRef.current;
    if (video) {
      try {
        video.currentTime = currentTimeRef.current;
      } catch {
        // O seek pendente cobre o caso de metadados ainda carregando.
      }
    }
  }, [mapped]);

  useEffect(() => {
    if (mapped && !playingRef.current && !trimDragRef.current) {
      seekRef.current(currentTimeRef.current);
    }
  }, [programme, mapped]);

  function seekTimelineAt(clientX: number, timeline: HTMLDivElement) {
    if (effectiveDuration <= 0) return;
    const rect = timeline.getBoundingClientRect();
    const laneStart = TIMELINE_LANE_START;
    const laneEndPadding = 0;
    const laneWidth = Math.max(1, rect.width - laneStart - laneEndPadding);
    const pointer = clientX - rect.left - laneStart;
    seek((Math.max(0, Math.min(pointer, laneWidth)) / laneWidth) * effectiveDuration);
  }

  function beginTimelineSeek(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || trimDragRef.current) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    timelineSeekPointerRef.current = event.pointerId;
    // Clicar no vazio limpa a selecao; clicar num clipe mantem o que o
    // proprio clipe acabou de selecionar.
    if (!(event.target as HTMLElement).closest('.timeline-clip')) {
      setSelectedClipId(null);
    }
    seekTimelineAt(event.clientX, event.currentTarget);
  }

  function continueTimelineSeek(event: ReactPointerEvent<HTMLDivElement>) {
    if (trimDragRef.current) return;
    // Só faz scrubbing de um gesto iniciado na própria timeline; sem isso um
    // clique num clipe (que não captura) viraria seek ao mover o ponteiro.
    if (timelineSeekPointerRef.current !== event.pointerId) return;
    seekTimelineAt(event.clientX, event.currentTarget);
  }

  function endTimelineSeek(event: ReactPointerEvent<HTMLDivElement>) {
    if (timelineSeekPointerRef.current === event.pointerId) {
      timelineSeekPointerRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function setInPoint() {
    if (!media || dirty) return;
    setMarkIn(currentTimeRef.current);
  }

  function setOutPoint() {
    const outPoint = currentTimeRef.current;
    if (markIn === null || outPoint <= markIn) return;
    videoRef.current?.pause();
    setDraftRange({ start: markIn, end: outPoint });
    setDraftNote('');
    setMarkIn(null);
  }

  function saveDraftCorrection(event: FormEvent) {
    event.preventDefault();
    if (!draftRange || !draftNote.trim()) return;
    commitCorrections([
      ...corrections,
      {
        id: `correction:${Date.now()}`,
        start: draftRange.start,
        end: draftRange.end,
        note: draftNote.trim(),
      },
    ]);
    setDraftRange(null);
    setDraftNote('');
  }

  function commitCorrections(next: CorrectionRange[]) {
    correctionHistoryRef.current.push(corrections);
    actionOrderRef.current.push('corrections');
    onCorrectionsChange(next);
  }

  function deleteCorrection(id: string) {
    commitCorrections(corrections.filter((correction) => correction.id !== id));
  }

  function commitModel(next: TimelineModel, before: TimelineModel | null = modelRef.current) {
    if (!before || modelsEqual(before, next)) {
      onTimelineModelChange(next, true);
      return;
    }
    modelHistoryRef.current.push(before);
    modelFutureRef.current = [];
    actionOrderRef.current.push('model');
    onTimelineModelChange(next, true);
  }

  function undoModelEdit() {
    const previous = modelHistoryRef.current.pop();
    const current = modelRef.current;
    if (!previous || !current) return;
    modelFutureRef.current.push(current);
    onTimelineModelChange(previous, true);
  }

  function redoModelEdit() {
    const next = modelFutureRef.current.pop();
    const current = modelRef.current;
    if (!next || !current) return;
    modelHistoryRef.current.push(current);
    actionOrderRef.current.push('model');
    onTimelineModelChange(next, true);
  }

  function undoTimelineAction() {
    if (draftRange) {
      setMarkIn(draftRange.start);
      setDraftRange(null);
      setDraftNote('');
      return;
    }
    if (markIn !== null) {
      setMarkIn(null);
      return;
    }
    const lastAction = actionOrderRef.current.pop();
    if (lastAction === 'model') {
      undoModelEdit();
      return;
    }
    if (lastAction === 'corrections') {
      const previous = correctionHistoryRef.current.pop();
      if (previous) onCorrectionsChange(previous);
    }
  }

  function razorAtPlayhead() {
    const current = modelRef.current;
    if (!current) return;
    const next = razorAtTime(current, currentTimeRef.current);
    if (next) commitModel(next);
  }

  function deleteSelectedClip(leaveGap: boolean) {
    const current = modelRef.current;
    if (!current || !selectedClipId) return;
    const next = leaveGap
      ? deleteClipLeaveGap(current, selectedClipId)
      : rippleDeleteClip(current, selectedClipId);
    if (next) {
      setSelectedClipId(null);
      commitModel(next);
    }
  }

  function discardTimelineEdits() {
    const baseline = baselineModelRef.current;
    if (!baseline) return;
    setSelectedClipId(null);
    commitModel(baseline);
  }

  function beginTrim(event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, edge: TrimEdge) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const current = modelRef.current;
    if (!current) return;
    setPlaying(false);
    playingRef.current = false;
    videoRef.current?.pause();
    const lane = (event.currentTarget as HTMLElement).closest('.studio-lane');
    const laneWidth = Math.max(1, lane?.getBoundingClientRect().width ?? 1);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Sem captura o arrasto ainda funciona enquanto o ponteiro estiver
      // sobre a alça; perder o capture não pode abortar o trim inteiro.
    }
    trimDragRef.current = {
      clipId: clip.id,
      edge,
      baseModel: current,
      originX: event.clientX,
      secondsPerPixel: (effectiveDuration || 1) / laneWidth,
      appliedDelta: 0,
    };
  }

  function moveTrim(event: ReactPointerEvent<HTMLElement>) {
    const drag = trimDragRef.current;
    if (!drag) return;
    event.stopPropagation();
    const allowed = trimAllowedDelta(drag.baseModel, drag.clipId, drag.edge, sourceDurations);
    const baseClip = drag.baseModel.clips.find((clip) => clip.id === drag.clipId);
    if (!allowed || !baseClip) return;
    const rawDelta = (event.clientX - drag.originX) * drag.secondsPerPixel;
    let delta = Math.max(allowed.min, Math.min(rawDelta, allowed.max));
    const excludeIds = new Set([baseClip.id]);
    if (baseClip.linkId) {
      for (const clip of drag.baseModel.clips) {
        if (clip.linkId === baseClip.linkId) excludeIds.add(clip.id);
      }
    }
    const edgeTime = drag.edge === 'start'
      ? baseClip.timelineStart + delta
      : clipEnd(baseClip) + delta;
    const snapped = snapTime(
      edgeTime,
      [...snapCandidateTimes(drag.baseModel, excludeIds), currentTimeRef.current],
      8 * drag.secondsPerPixel,
    );
    delta = Math.max(
      allowed.min,
      Math.min(
        drag.edge === 'start' ? snapped - baseClip.timelineStart : snapped - clipEnd(baseClip),
        allowed.max,
      ),
    );
    // Na borda inicial a prévia acompanha o ponteiro (abre espaço); o ripple
    // fecha o espaço ao soltar. Na borda final o ripple já acontece ao vivo.
    const preview = applyTrim(drag.baseModel, drag.clipId, drag.edge, delta, sourceDurations, {
      ripple: drag.edge === 'end',
    });
    drag.appliedDelta = preview.applied;
    onTimelineModelChange(preview.model, false);
  }

  function endTrim(event: ReactPointerEvent<HTMLElement>) {
    const drag = trimDragRef.current;
    if (!drag) return;
    event.stopPropagation();
    trimDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (Math.abs(drag.appliedDelta) < 0.001) {
      onTimelineModelChange(drag.baseModel, false);
      return;
    }
    const final = applyTrim(
      drag.baseModel,
      drag.clipId,
      drag.edge,
      drag.appliedDelta,
      sourceDurations,
      { ripple: true },
    );
    commitModel(final.model, drag.baseModel);
  }

  function changeZoom(nextZoom: number, anchorClientX?: number) {
    // Fracionário por causa da pinça do trackpad; botões continuam em passos.
    const clamped = Math.max(1, Math.min(8, Math.round(nextZoom * 100) / 100));
    if (clamped === zoomStateRef.current) return;
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller && content) {
      const width = content.getBoundingClientRect().width;
      if (anchorClientX !== undefined) {
        // Pinça: o ponto da timeline sob o cursor permanece parado.
        const contentX = anchorClientX - content.getBoundingClientRect().left;
        const lane = Math.max(1, width - TIMELINE_LANE_START);
        const pointerProgress = Math.min(1, Math.max(0, (contentX - TIMELINE_LANE_START) / lane));
        zoomAnchorRef.current = {
          progress: pointerProgress,
          viewportX: anchorClientX - scroller.getBoundingClientRect().left,
        };
      } else {
        const playheadX = TIMELINE_LANE_START + progress * Math.max(0, width - TIMELINE_LANE_START);
        zoomAnchorRef.current = { progress, viewportX: playheadX - scroller.scrollLeft };
      }
    }
    setZoom(clamped);
  }

  // Zoom ancorado na agulha: mantém a agulha no mesmo ponto do viewport.
  useLayoutEffect(() => {
    zoomStateRef.current = zoom;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    if (!anchor) return;
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const width = content.getBoundingClientRect().width;
    const playheadX = TIMELINE_LANE_START + anchor.progress * Math.max(0, width - TIMELINE_LANE_START);
    scroller.scrollLeft = Math.max(0, playheadX - anchor.viewportX);
  }, [zoom]);

  // Pinça do trackpad: o Chromium entrega o gesto como wheel com ctrlKey.
  // Listener nativo com passive: false — o onWheel do React não permite
  // preventDefault e a página daria zoom inteira.
  pinchZoomRef.current = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    changeZoom(zoomStateRef.current * Math.exp(-event.deltaY * 0.01), event.clientX);
  };
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const listener = (event: WheelEvent) => pinchZoomRef.current(event);
    scroller.addEventListener('wheel', listener, { passive: false });
    return () => scroller.removeEventListener('wheel', listener);
  }, []);

  async function applyCorrections() {
    if (corrections.length === 0) return;
    if (await onApplyCorrections(corrections)) {
      onCorrectionsChange([]);
      correctionHistoryRef.current = [];
      setMarkIn(null);
    }
  }

  useEffect(() => {
    const handleEditorShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, input, [contenteditable="true"]')) return;
      // Durante um trim, teclas que desmontariam o handle capturado (Escape,
      // Delete...) deixariam o drag órfão. Escape cancela o trim; o resto espera.
      if (trimDragRef.current) {
        if (event.key === 'Escape') {
          event.preventDefault();
          onTimelineModelChange(trimDragRef.current.baseModel, false);
          trimDragRef.current = null;
        }
        return;
      }
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'z' && !event.altKey) {
        event.preventDefault();
        if (event.shiftKey) redoModelEdit();
        else undoTimelineAction();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) void togglePlayback();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        stepByFrames(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (!selectedClipId) return;
        event.preventDefault();
        deleteSelectedClip(event.shiftKey);
        return;
      }
      if (event.key === 'Escape') {
        if (draftRange) {
          setDraftRange(null);
          setDraftNote('');
        } else {
          setSelectedClipId(null);
        }
        return;
      }
      if (key === 'c') {
        event.preventDefault();
        razorAtPlayhead();
        return;
      }
      if (key === '=' || key === '+') {
        event.preventDefault();
        changeZoom(Math.round(zoom) + 1);
        return;
      }
      if (key === '-') {
        event.preventDefault();
        changeZoom(Math.round(zoom) - 1);
        return;
      }
      if (key === '0') {
        event.preventDefault();
        changeZoom(1);
        return;
      }
      if (key === 'm') {
        event.preventDefault();
        if (markIn === null) setInPoint();
        else setOutPoint();
      } else if (key === 'i') {
        event.preventDefault();
        setInPoint();
      } else if (key === 'o') {
        event.preventDefault();
        setOutPoint();
      }
    };
    window.addEventListener('keydown', handleEditorShortcut);
    return () => window.removeEventListener('keydown', handleEditorShortcut);
  }, [corrections, draftRange, markIn, media?.fps, media?.url, model, selectedClipId, dirty, zoom, mapped, effectiveDuration, fps]);

  const trackStyle = {
    '--timeline-playhead-left': timelinePoint(progress),
  } as CSSProperties;
  const orientation = media?.orientation ?? 'horizontal';
  const displayedSegments = model
    ? deriveSegments(model)
    : timelineSegments.length > 0
      ? timelineSegments
      : [{
          label: media?.name ?? 'Vídeo',
          start: 0,
          duration: effectiveDuration || 1,
          audioStart: 0,
          audioDuration: effectiveDuration || 1,
        }];
  const rulerTicks = useMemo(() => {
    if (!(effectiveDuration > 0)) return [0];
    // Passo mínimo de 1s: formatTime não tem precisão sub-segundo.
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const ideal = effectiveDuration / (4 * zoom);
    const step = steps.find((candidate) => candidate >= ideal) ?? 900;
    const ticks: number[] = [];
    for (let tick = 0; tick <= effectiveDuration - step * 0.35; tick += step) {
      ticks.push(round3(tick));
    }
    ticks.push(round3(effectiveDuration));
    return ticks;
  }, [effectiveDuration, zoom]);

  function renderModelClip(clip: TimelineClip, index: number, kindClass: string) {
    const left = effectiveDuration > 0 ? (clip.timelineStart / effectiveDuration) * 100 : 0;
    const widthPct = effectiveDuration > 0
      ? (clipDuration(clip) / effectiveDuration) * 100
      : 100;
    const isSelected = clip.id === selectedClipId;
    const isLinkedSelected = !isSelected && selectedLinkId !== null && clip.linkId === selectedLinkId;
    return (
      <div
        className={`timeline-clip ${kindClass} ${index % 2 ? 'alt' : ''} ${isSelected ? 'selected' : ''} ${isLinkedSelected ? 'linked-selected' : ''} ${clip.enabled ? '' : 'disabled'}`}
        key={clip.id}
        style={{ left: `${left}%`, width: `calc(${Math.max(widthPct, 0.4)}% - 2px)` }}
        title={`${clip.label} · ${formatTime(clipDuration(clip))}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // Sem stopPropagation: o clique tambem chega a timeline e leva a
          // agulha ate ele, como em qualquer ponto da régua ou das pistas.
          setSelectedClipId(clip.id);
        }}
      >
        {waveformPaths.has(clip.id) && (
          <svg className="clip-waveform" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
            <path d={waveformPaths.get(clip.id)} />
          </svg>
        )}
        <span className="clip-label">{clip.label}</span>
        {isSelected && (
          <>
            <span
              className="clip-handle left"
              title="Ajustar início do take (arraste)"
              onPointerDown={(event) => beginTrim(event, clip, 'start')}
              onPointerMove={moveTrim}
              onPointerUp={endTrim}
              onPointerCancel={endTrim}
            />
            <span
              className="clip-handle right"
              title="Ajustar fim do take (arraste)"
              onPointerDown={(event) => beginTrim(event, clip, 'end')}
              onPointerMove={moveTrim}
              onPointerUp={endTrim}
              onPointerCancel={endTrim}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div className={`editor-workspace ${orientation}`}>
      <section className="preview-section">
        <div className={`video-stage ${orientation}`}>
          {media ? (
            <>
              <video
                key={media.url}
                ref={videoRef}
                src={videoSrc}
                preload="metadata"
                playsInline
                style={{
                  aspectRatio: `${media.width} / ${media.height}`,
                  ...(mapped && (inGap || !activeSource?.url) ? { opacity: 0 } : null),
                }}
                onLoadedMetadata={(event) => {
                  const pending = pendingVideoSeekRef.current;
                  if (pending) {
                    pendingVideoSeekRef.current = null;
                    try {
                      event.currentTarget.currentTime = pending.sourceTime;
                    } catch {
                      // A agulha continua responsiva enquanto os metadados carregam.
                    }
                    // A retomada só vale se o transporte ainda estiver rodando
                    // e houver segmento ativo: uma troca de fonte lenta podia
                    // dar play depois de o motor já ter parado.
                    if (pending.resume && playingRef.current && !inGapRef.current) {
                      void event.currentTarget.play().catch(() => setPlaying(false));
                    }
                  }
                  if (!mappedRef.current) setDuration(event.currentTarget.duration);
                }}
                onTimeUpdate={(event) => {
                  if (!mappedRef.current) {
                    syncCurrentTime(event.currentTarget.currentTime);
                    return;
                  }
                  enforceMappedBoundary(event.currentTarget);
                }}
                onSeeking={(event) => {
                  if (!mappedRef.current) syncCurrentTime(event.currentTarget.currentTime);
                }}
                onClick={() => void togglePlayback()}
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  if (!mappedRef.current || !inGapRef.current) setPlaying(false);
                }}
                onEnded={() => {
                  if (!mappedRef.current) setPlaying(false);
                }}
              />
              {mapped && inGap && <div className="video-stage-note">Espaço vazio na timeline</div>}
              {mapped && activeSourceId && !activeSource?.url && (
                <div className="video-stage-note">Arquivo-fonte indisponível para a prévia</div>
              )}
            </>
          ) : (
            <div className="video-placeholder">
              <span><Icon name="video" /></span>
              <strong>O preview aparecerá aqui</strong>
              <small>Abra um projeto que contenha um vídeo.</small>
            </div>
          )}
        </div>
      </section>

      <section className="timeline-section">
        <div className="timeline-toolbar slim">
          {mapped && <span className="mapped-badge" title="O preview mostra as edições ainda não renderizadas">Prévia das edições</span>}
          <div className="timeline-time">{formatTimecode(currentTime, fps)} <span>/ {formatTimecode(effectiveDuration, fps)}</span></div>
        </div>
        <div className="timeline-scroll" ref={scrollRef}>
          <div
            className="timeline-content"
            ref={contentRef}
            style={{ ...trackStyle, width: `${zoom * 100}%` }}
            tabIndex={media || model ? 0 : -1}
            aria-label="Timeline de edição. Use as setas para mover um frame."
            onPointerDown={beginTimelineSeek}
            onPointerMove={continueTimelineSeek}
            onPointerUp={endTimelineSeek}
            onPointerCancel={endTimelineSeek}
          >
            <div className="timeline-ruler">
              {rulerTicks.map((tick) => (
                <span
                  key={tick}
                  style={{ left: timelinePoint(effectiveDuration > 0 ? tick / effectiveDuration : 0) }}
                >
                  {formatTime(tick)}
                </span>
              ))}
            </div>
            {phase === 2 && style.headline !== 'none' && (
              <TimelineTrack icon="text" label="Headline" tone="orange">
                <div className="timeline-chip headline-chip" style={{ width: '31%' }}>Headline · {style.headline}</div>
              </TimelineTrack>
            )}
            {phase === 2 && style.captions !== 'none' && (
              <TimelineTrack icon="captions" label="Legendas" tone="teal">
                <div className="timeline-chip captions-chip" style={{ left: '2%', width: '96%' }}>Legendas</div>
              </TimelineTrack>
            )}
            {phase === 2 && style.edit !== 'limpa' && (
              <TimelineTrack icon="image" label="Assets" tone="orange">
                <div className="timeline-chip asset-chip" style={{ left: '8%', width: '22%' }}>Insert 01</div>
                <div className="timeline-chip asset-chip" style={{ left: '48%', width: '28%' }}>Insert 02</div>
              </TimelineTrack>
            )}
            <TimelineTrack icon="video" label="Vídeo" tone="orange">
              {model
                ? videoClips.map((clip, index) => renderModelClip(clip, index, 'video-clip'))
                : displayedSegments.map((segment, index) => (
                    <div
                      className={`timeline-clip video-clip ${index % 2 ? 'alt' : ''}`}
                      key={`${segment.start}:${segment.label}`}
                      style={{
                        left: `${effectiveDuration > 0 ? (segment.start / effectiveDuration) * 100 : 0}%`,
                        width: `calc(${effectiveDuration > 0 ? (segment.duration / effectiveDuration) * 100 : 100}% - ${index < displayedSegments.length - 1 ? 2 : 0}px)`,
                      }}
                      title={`${segment.label} · ${formatTime(segment.duration)}`}
                    >
                      <span>{segment.label}</span>
                    </div>
                  ))}
            </TimelineTrack>
            <TimelineTrack icon="waveform" label="Voz" tone="teal">
              {model
                ? voiceClips.map((clip, index) => renderModelClip(clip, index, 'audio-clip'))
                : displayedSegments.map((segment, index) => {
                    const start = segment.audioStart ?? segment.start;
                    const segmentDuration = segment.audioDuration ?? segment.duration;
                    return (
                      <div
                        className={`timeline-clip audio-clip ${index % 2 ? 'alt' : ''}`}
                        key={`audio:${segment.start}:${segment.label}`}
                        style={{
                          left: `${effectiveDuration > 0 ? (start / effectiveDuration) * 100 : 0}%`,
                          width: `calc(${effectiveDuration > 0 ? (segmentDuration / effectiveDuration) * 100 : 100}% - 2px)`,
                        }}
                        title={`${segment.label} · ${formatTime(segmentDuration)}`}
                      >
                        <span>{segment.label}</span>
                      </div>
                    );
                  })}
            </TimelineTrack>
            {phase === 2 && style.elements.musicAI && (
              <TimelineTrack icon="music" label="Trilha" tone="olive">
                <div className="timeline-chip music-chip" style={{ left: '0%', width: '100%' }}>Trilha sonora · −15 dB</div>
              </TimelineTrack>
            )}
            {corrections.map((correction, index) => (
              <div
                className="timeline-correction-range"
                key={correction.id}
                style={{
                  '--correction-left': timelinePoint(effectiveDuration > 0 ? correction.start / effectiveDuration : 0),
                  '--correction-width': timelineSpan(effectiveDuration > 0 ? (correction.end - correction.start) / effectiveDuration : 0),
                } as CSSProperties}
                title={`${formatTime(correction.start)}–${formatTime(correction.end)} · ${correction.note}`}
              >
                <span>{index + 1}</span>
                <button
                  type="button"
                  className="delete-correction"
                  title={`Excluir marcação ${index + 1}`}
                  aria-label={`Excluir marcação ${index + 1}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); deleteCorrection(correction.id); }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))}
            {markIn !== null && (
              <div
                className="timeline-in-marker"
                style={{ '--marker-left': timelinePoint(effectiveDuration > 0 ? markIn / effectiveDuration : 0) } as CSSProperties}
              >
                <span>IN</span>
              </div>
            )}
            <div className="timeline-playhead" />
          </div>
        </div>
        <div className="timeline-transport" aria-label="Controles de reprodução">
          <div className="marker-controls">
            <button type="button" className={`marker-button ${markIn !== null ? 'active' : ''}`} onClick={setInPoint} disabled={!media || dirty} title={dirty ? 'Aplique ou descarte as edições antes de marcar correções' : 'Marcar início da correção (I ou M)'}>IN</button>
            <button type="button" className="marker-button" onClick={setOutPoint} disabled={!media || dirty || markIn === null || currentTime <= markIn} title={dirty ? 'Aplique ou descarte as edições antes de marcar correções' : 'Marcar fim da correção (O ou M)'}>OUT</button>
            <button type="button" className="marker-button razor" onClick={razorAtPlayhead} disabled={!model} title="Dividir o take na agulha (C)"><Icon name="scissors" /></button>
            {corrections.length > 0 && !dirty && <span className="correction-count">{corrections.length} {corrections.length === 1 ? 'marcação' : 'marcações'}</span>}
          </div>
          <div className="transport-center">
            <button type="button" className="transport-button" onClick={() => jumpBy(-5)} disabled={!media} title="Voltar 5 segundos">
              <Icon name="skipBack" /><span>5s</span>
            </button>
            <button type="button" className="transport-button transport-play" onClick={() => void togglePlayback()} disabled={!media} title={playing ? 'Pausar' : 'Reproduzir'}>
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <button type="button" className="transport-button" onClick={() => jumpBy(5)} disabled={!media} title="Avançar 5 segundos">
              <Icon name="skipForward" /><span>5s</span>
            </button>
          </div>
          <div className="transport-right">
            <div className="timeline-zoom" aria-label="Zoom da timeline">
              <button type="button" onClick={() => changeZoom(Math.round(zoom) - 1)} disabled={zoom <= 1} title="Reduzir zoom (-)">−</button>
              <span>{(Math.round(zoom * 10) / 10).toLocaleString('pt-BR')}×</span>
              <button type="button" onClick={() => changeZoom(Math.round(zoom) + 1)} disabled={zoom >= 8} title="Aumentar zoom (+)">+</button>
              <button type="button" className="fit" onClick={() => changeZoom(1)} disabled={zoom <= 1} title="Ver a timeline inteira (0)">Fit</button>
            </div>
            <button type="button" className="transport-button" onClick={toggleMute} disabled={!media} title={muted ? 'Ativar áudio' : 'Silenciar'}>
              <Icon name={muted ? 'volumeOff' : 'volume'} />
            </button>
            {dirty ? (
              <>
                {canDiscard && (
                  <button type="button" className="discard-edits" onClick={discardTimelineEdits} title="Voltar ao corte atual sem aplicar">
                    Descartar
                  </button>
                )}
                <button type="button" className="apply-corrections" onClick={() => void onApplyTimelineEdits()} disabled={applyingCorrections} title="Enviar os novos cortes para gerar o render atualizado">
                  {applyingCorrections ? 'Aplicando...' : 'Aplicar edições'}
                </button>
              </>
            ) : (
              corrections.length > 0 && (
                <button type="button" className="apply-corrections" onClick={() => void applyCorrections()} disabled={applyingCorrections}>
                  {applyingCorrections ? 'Aplicando...' : 'Aplicar'}
                </button>
              )
            )}
          </div>
        </div>
        {draftRange && (
          <form className="correction-note-popover" onSubmit={saveDraftCorrection}>
            <span className="eyebrow">Correção na timeline</span>
            <strong>{formatTime(draftRange.start)} → {formatTime(draftRange.end)}</strong>
            <textarea autoFocus rows={3} value={draftNote} onChange={(event) => setDraftNote(event.target.value)} placeholder="Descreva o que precisa ser corrigido neste trecho..." />
            <div>
              <button type="button" className="btn ghost small" onClick={() => { setDraftRange(null); setDraftNote(''); }}>Cancelar</button>
              <button type="submit" className="btn primary small" disabled={!draftNote.trim()}>Salvar marcação</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function StyleWorkspace({
  style,
  onChange,
  onApply,
  canApply,
  applying,
  runtime,
}: {
  style: StyleSetup;
  onChange: (style: StyleSetup) => void;
  onApply: () => void;
  canApply: boolean;
  applying: boolean;
  runtime: RemotionRuntimeState;
}) {
  const accentUsed = style.headline === 'realce' || style.headline === 'misto' || style.captions === 'stacked';
  const updateElements = (key: keyof StyleSetup['elements']) => {
    onChange({ ...style, elements: { ...style.elements, [key]: !style.elements[key] } });
  };

  return (
    <div className="style-workspace" style={{ '--style-accent': style.accent } as CSSProperties}>
      <div className="style-scroll">
        <div className="style-intro">
          <div>
            <h2>Escolha estilos e elementos de edição</h2>
          </div>
        </div>

        <section className="style-group">
          <div className="style-group-head"><div><h3>Tipo de edição</h3></div></div>
          <div className="choice-grid edit-choice-grid">
            {editStyles.map((option) => (
              <ChoiceCard key={option.id} selected={style.edit === option.id} onClick={() => onChange({ ...style, edit: option.id })} label={option.name}>
                <EditStylePreview style={option.id} />
              </ChoiceCard>
            ))}
          </div>
        </section>

        <section className="style-group accent-group">
          <div className="style-group-head"><div><h3>Cor de destaque</h3></div></div>
          <div className={`accent-control ${accentUsed ? '' : 'unused'}`}>
            <input type="color" value={style.accent} onChange={(event) => onChange({ ...style, accent: event.target.value })} aria-label="Cor de destaque" />
            <input className="accent-hex" value={style.accent.toUpperCase()} onChange={(event) => {
              const value = event.target.value;
              if (/^#[0-9a-f]{6}$/iu.test(value)) onChange({ ...style, accent: value });
            }} aria-label="Cor de destaque em hexadecimal" />
            <span>{accentUsed ? 'Aplicada aos estilos escolhidos' : 'A cor não será usada com as escolhas atuais'}</span>
          </div>
        </section>

        <section className="style-group">
          <div className="style-group-head"><div><h3>Estilo de headline</h3></div></div>
          <div className="choice-grid headline-choice-grid">
            {headlineStyles.map((option) => (
              <ChoiceCard key={option.id} selected={style.headline === option.id} title={option.name} onClick={() => onChange({ ...style, headline: option.id })}>
                <HeadlinePreview style={option.id} />
              </ChoiceCard>
            ))}
          </div>
        </section>

        <section className="style-group">
          <div className="style-group-head"><div><h3>Estilo de legenda</h3></div></div>
          <div className="choice-grid caption-choice-grid">
            {captionStyles.map((option) => (
              <ChoiceCard key={option.id} selected={style.captions === option.id} title={option.name} onClick={() => onChange({ ...style, captions: option.id })}>
                <CaptionPreview style={option.id} />
              </ChoiceCard>
            ))}
          </div>
        </section>

        <section className="style-group">
          <div className="style-group-head"><div><h3>Elementos da edição</h3><p>Desmarcado significa que o elemento ficará fora.</p></div></div>
          <div className="element-grid">
            {([
              ['tracking', 'Tracking do rosto', 'Mantém olhos e rosto na zona segura.'],
              ['zoomAuto', 'Zoom automático', 'Push-in sutil dentro de cada take.'],
              ['zoomCuts', 'Zoom nos cortes', 'Varia a escala a cada mudança de take.'],
              ['flashCut', 'Flash na transição', 'Acentua mudanças de layout selecionadas.'],
              ['musicAI', 'Trilha sonora com IA', 'Composição instrumental em volume de referência.'],
            ] as Array<[keyof StyleSetup['elements'], string, string]>).map(([key, name, description]) => (
              <button type="button" className={`element-toggle ${style.elements[key] ? 'enabled' : ''}`} key={key} onClick={() => updateElements(key)} aria-pressed={style.elements[key]}>
                <span className="toggle-box"><Icon name="check" /></span>
                <span><strong>{name}</strong><small>{description}</small></span>
              </button>
            ))}
          </div>
          <label className="style-note">
            <span>Observação para a edição</span>
            <textarea rows={3} value={style.note} onChange={(event) => onChange({ ...style, note: event.target.value })} placeholder="Ex.: preservar o rosto sem inserts durante a demonstração do produto." />
          </label>
        </section>
      </div>
      <div className="style-footer">
        {runtime.status === 'installing' ? (
          <div>
            <strong>Preparando o motor de render</strong>
            <span>
              {runtime.step === 'navegador'
                ? 'Baixando o navegador de render. Isso acontece uma única vez.'
                : runtime.step === 'fontes'
                  ? 'Baixando as fontes da edição. Isso acontece uma única vez.'
                  : `Instalando as dependências${runtime.installedBytes ? ` · ${Math.round(runtime.installedBytes / 1e6)} MB` : ''}. Isso acontece uma única vez.`}
            </span>
          </div>
        ) : runtime.status === 'error' ? (
          <div>
            <strong>Motor de render indisponível</strong>
            <span>{runtime.error || 'Falha ao preparar o Remotion.'} Clique em “Salvar e aplicar” para tentar de novo.</span>
          </div>
        ) : <div />}
        <button type="button" className="btn primary apply-style" onClick={onApply} disabled={!canApply || applying || runtime.status === 'installing'}>
          <Icon name="sparkles" /> {runtime.status === 'installing' ? 'Preparando...' : applying ? 'Enviando...' : 'Salvar e aplicar'}
        </button>
      </div>
    </div>
  );
}

function MemberGate({
  auth,
  onLogin,
  onLogout,
}: {
  auth: MemberAuthState;
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || auth.status === 'checking';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !email.trim() || !password) return;
    setSubmitting(true);
    try {
      await onLogin(email.trim(), password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="member-gate">
      <section className="member-card">
        <img className="member-logo" src={edvidLogo} alt="Edvid" />
        {auth.status === 'no-access' ? (
          <>
            <h1>Sua matrícula não está ativa</h1>
            <p>
              O Edvid é liberado para alunos com o <strong>IA Edit Pro</strong> ativo na Creator
              Factory. A conta {auth.email ? <strong>{auth.email}</strong> : 'informada'} não tem essa
              matrícula no momento — se você acabou de comprar ou renovou, feche e reabra o aplicativo.
            </p>
            <p className="member-hint">Dúvidas? Fale com o suporte da Creator Factory.</p>
            <button type="button" className="btn ghost" onClick={() => void onLogout()}>Entrar com outra conta</button>
          </>
        ) : (
          <>
            <h1>Entre com sua conta de aluno</h1>
            <p>Use o mesmo e-mail e senha da área de membros da Creator Factory.</p>
            <form onSubmit={submit}>
              <label>
                <span>E-mail</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  placeholder="voce@exemplo.com"
                  disabled={busy}
                />
              </label>
              <label>
                <span>Senha</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder="Sua senha da Creator Factory"
                  disabled={busy}
                />
              </label>
              {auth.error && <div className="inline-error">{auth.error}</div>}
              <button type="submit" className="btn primary" disabled={busy || !email.trim() || !password}>
                {busy ? 'Entrando...' : 'Entrar'}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

export function App() {
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeCheck[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [account, setAccount] = useState<CodexAccountState>(initialAccount);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<CodexApproval[]>([]);
  const [answeringApprovalId, setAnsweringApprovalId] = useState<string | number | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [checking, setChecking] = useState(true);
  const [sending, setSending] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);
  const [activeTurn, setActiveTurn] = useState<{ threadId: string; turnId: string } | null>(null);
  const [railPinned, setRailPinned] = useState(() => localStorage.getItem('edvid:rail-pinned') === 'true');
  const [workTab, setWorkTab] = useState<WorkTab>('edit');
  const [style, setStyle] = useState<StyleSetup>(defaultStyleSetup);
  const [styleApplied, setStyleApplied] = useState(false);
  const [corrections, setCorrections] = useState<CorrectionRange[]>([]);
  const [handledCutApprovalId, setHandledCutApprovalId] = useState<string | null>(null);
  const [approvingCut, setApprovingCut] = useState(false);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [whisperModel, setWhisperModel] = useState<WhisperModelState>({
    status: 'unknown',
    model: '',
  });
  const [remotionRuntime, setRemotionRuntime] = useState<RemotionRuntimeState>({
    status: 'unknown',
  });
  const [phase2Render, setPhase2Render] = useState<Phase2RenderState>({ status: 'idle' });
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({ status: 'idle' });
  const [memberAuth, setMemberAuth] = useState<MemberAuthState>({ status: 'unconfigured' });
  const [runtimePack, setRuntimePack] = useState<RuntimePackState>({ status: 'unknown' });
  const [nameDialog, setNameDialog] = useState<{ mode: 'create' } | { mode: 'rename'; directory: string } | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'geral' | 'conexoes'>('geral');
  const [jcutApplied, setJcutApplied] = useState(false);
  const phase2StatusRef = useRef<Phase2RenderState['status']>('idle');
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const activeProjectDirectoryRef = useRef<string | null>(null);
  const timelineSaveTimerRef = useRef<number | null>(null);
  const pendingTimelineSaveRef = useRef<{
    directory: string;
    model: TimelineModel;
    loadStamp: string;
  } | null>(null);
  const booted = useRef(false);

  const projectDirectory = workspace?.project.directory ?? null;
  const canChat = Boolean(projectDirectory) && account.status === 'signed-in';
  const readyRuntimes = runtimes.filter((runtime) => runtime.available).length;
  const accountLabel = account.account?.email ?? (account.status === 'waiting-for-browser' ? 'Conclua no navegador' : 'ChatGPT desconectado');
  const activeApproval = approvals[0] ?? null;
  const pendingCutApprovalId = useMemo(
    () => [...messages].reverse().find((message) => (
      message.role === 'assistant' &&
      message.id !== handledCutApprovalId &&
      asksForCleanCutApproval(message.text)
    ))?.id ?? null,
    [handledCutApprovalId, messages],
  );

  const missingRuntimeNames = useMemo(
    () => runtimes.filter((runtime) => !runtime.available).map((runtime) => labels[runtime.name]),
    [runtimes],
  );

  async function refreshRuntimes() {
    setChecking(true);
    try {
      setRuntimes(await window.edvidDesktop.checkRuntimes());
    } finally {
      setChecking(false);
    }
  }

  function activateWorkspace(next: ProjectWorkspace) {
    activeProjectDirectoryRef.current = next.project.directory;
    const storedChat = readStoredChat(next.project.directory);
    setWorkspace(next);
    setMessages(storedChat.messages);
    setApprovals([]);
    setAnsweringApprovalId(null);
    setApprovalError(null);
    setStyle(readStoredStyle(next.project.directory, next.style ?? defaultStyleSetup));
    setStyleApplied(next.media?.kind === 'final' || Boolean(next.style));
    setCorrections([]);
    setHandledCutApprovalId(storedChat.handledCutApprovalId);
    setJcutApplied(storedChat.jcutApplied);
    setWorkTab('edit');
    setFollowingOutput(true);
    // Cobre dados da Fase 2 que ficaram prontos com o aplicativo fechado ou
    // um render interrompido no meio; sem nada novo, volta na hora.
    requestPhase2Render();
  }

  async function reloadProjects() {
    setProjects(await window.edvidDesktop.listRecentProjects());
  }

  async function chooseProjectDirectory(name?: string) {
    setOpeningProject(true);
    try {
      const selected = await window.edvidDesktop.selectProjectDirectory(name);
      if (selected) {
        activateWorkspace(selected);
        await reloadProjects();
      }
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
    } finally {
      setOpeningProject(false);
    }
  }

  function startCreateProject() {
    setNameValue('');
    setNameDialog({ mode: 'create' });
  }

  function startRenameProject(project: ProjectSummary) {
    setProjectMenu(null);
    setNameValue(project.name);
    setNameDialog({ mode: 'rename', directory: project.directory });
  }

  async function confirmNameDialog() {
    const dialog = nameDialog;
    if (!dialog) return;
    const name = nameValue.trim();
    setNameDialog(null);
    if (dialog.mode === 'create') {
      await chooseProjectDirectory(name || undefined);
      return;
    }
    if (!name) return;
    try {
      setProjects(await window.edvidDesktop.renameProject(dialog.directory, name));
      if (dialog.directory === projectDirectory) {
        setWorkspace((current) => current
          ? { ...current, project: { ...current.project, name } }
          : current);
      }
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
    }
  }

  async function togglePinProject(project: ProjectSummary) {
    setProjectMenu(null);
    try {
      setProjects(await window.edvidDesktop.pinProject(project.directory, !project.pinned));
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
    }
  }

  async function removeProjectFromList(project: ProjectSummary) {
    setProjectMenu(null);
    try {
      // Remove apenas da lista de recentes; a pasta continua intacta no disco.
      setProjects(await window.edvidDesktop.removeRecentProject(project.directory));
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
    }
  }

  async function openRecentProject(project: ProjectSummary) {
    if (project.directory === projectDirectory || openingProject || activeTurn) return;
    setOpeningProject(true);
    try {
      activateWorkspace(await window.edvidDesktop.openRecentProject(project.directory));
      await reloadProjects();
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
    } finally {
      setOpeningProject(false);
    }
  }

  async function flushPendingTimelineSave() {
    const pending = pendingTimelineSaveRef.current;
    if (!pending) return;
    pendingTimelineSaveRef.current = null;
    if (timelineSaveTimerRef.current !== null) {
      window.clearTimeout(timelineSaveTimerRef.current);
      timelineSaveTimerRef.current = null;
    }
    try {
      await window.edvidDesktop.saveTimelineModel(pending.directory, pending.model, pending.loadStamp);
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
    }
  }

  async function refreshWorkspace() {
    const directory = activeProjectDirectoryRef.current;
    if (!directory) return;
    try {
      // Garante que a última edição da timeline está no disco antes de reler
      // o projeto; sem isso o refresh reverteria a edição na interface.
      await flushPendingTimelineSave();
      const refreshed = await window.edvidDesktop.refreshProjectWorkspace(directory);
      setWorkspace(refreshed);
      if (refreshed.style) {
        setStyle(readStoredStyle(directory, refreshed.style));
      }
      if (refreshed.media?.kind === 'final' || refreshed.style) setStyleApplied(true);
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
    }
  }

  function requestPhase2Render() {
    const directory = activeProjectDirectoryRef.current;
    if (!directory) return;
    // O andamento e o desfecho chegam por onPhase2RenderState.
    void window.edvidDesktop.renderPhase2(directory).catch(() => {});
  }

  function handlePhase2RenderState(state: Phase2RenderState) {
    const previous = phase2StatusRef.current;
    phase2StatusRef.current = state.status;
    setPhase2Render(state);
    if (state.status === 'ready' && previous === 'rendering') {
      // Um render novo terminou; recarrega o workspace para o preview trocar
      // para o resultado estilizado.
      void refreshWorkspace();
    }
    if (state.status === 'error' && previous !== 'error' && state.error) {
      setMessages((current) => [...current, {
        id: `error:${Date.now()}`,
        role: 'system',
        text: `O render da edição estilizada falhou: ${state.error}`,
      }]);
    }
  }

  async function login() {
    setAccount({ ...initialAccount, status: 'starting' });
    try {
      setAccount(await window.edvidDesktop.loginWithChatGPT());
    } catch (error) {
      setAccount({ status: 'error', account: null, requiresOpenaiAuth: true, error: errorMessage(error) });
    }
  }

  async function logout() {
    try {
      setAccount(await window.edvidDesktop.logoutCodex());
      // O histórico não é apagado: a conversa pertence ao projeto, não à conta.
    } catch (error) {
      setAccount({ ...account, status: 'error', error: errorMessage(error) });
    }
  }

  async function cancelLogin() {
    try {
      setAccount(await window.edvidDesktop.cancelChatGPTLogin());
    } catch (error) {
      setAccount({ ...initialAccount, status: 'error', error: errorMessage(error) });
    }
  }

  function handleCodexEvent(event: CodexEvent) {
    if (event.type === 'account') {
      setAccount(event.state);
      return;
    }
    if (event.type === 'assistant-delta') {
      const id = `assistant:${event.turnId}`;
      setMessages((current) => {
        const existing = current.findIndex((message) => message.id === id);
        if (existing < 0) return [...current, { id, role: 'assistant', text: event.delta }];
        return current.map((message, index) => index === existing ? { ...message, text: message.text + event.delta } : message);
      });
      return;
    }
    if (event.type === 'assistant-final') {
      const id = `assistant:${event.turnId}`;
      setMessages((current) => {
        const existing = current.some((message) => message.id === id);
        return existing ? current.map((message) => message.id === id ? { ...message, text: event.text } : message) : [...current, { id, role: 'assistant', text: event.text }];
      });
      if (/(escolh|selecion).{0,60}(estilo|headline|legenda)|estilo.{0,60}(headline|legenda)/isu.test(event.text)) {
        setWorkTab('styles');
      }
      return;
    }
    if (event.type === 'turn-state') {
      if (event.status === 'started') {
        setActiveTurn({ threadId: event.threadId, turnId: event.turnId });
      } else {
        setActiveTurn(null);
        setSending(false);
        if (event.error) setMessages((current) => [...current, { id: `error:${event.turnId}`, role: 'system', text: event.error ?? '' }]);
        void refreshWorkspace();
        // Se o turno mudou os dados da Fase 2, o aplicativo renderiza fora do
        // sandbox — sem dados novos o main devolve na hora, sem custo.
        requestPhase2Render();
      }
      return;
    }
    if (event.type === 'approval-requested') {
      setApprovalError(null);
      setApprovals((current) => (
        current.some((approval) => approval.id === event.approval.id)
          ? current
          : [...current, event.approval]
      ));
      return;
    }
    if (event.type === 'approval-resolved') {
      setApprovals((current) => current.filter((approval) => approval.id !== event.approvalId));
      setAnsweringApprovalId((current) => current === event.approvalId ? null : current);
      setApprovalError(null);
      return;
    }
    if (event.type === 'error') {
      setSending(false);
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: event.message }]);
    }
  }

  async function dispatchMessage(text: string, displayText = text) {
    const trimmed = text.trim();
    if (!trimmed || !projectDirectory || account.status !== 'signed-in' || sending) return false;
    setSending(true);
    setFollowingOutput(true);
    setMessages((current) => [...current, { id: `user:${Date.now()}`, role: 'user', text: displayText.trim() || trimmed }]);
    try {
      const result = await window.edvidDesktop.sendCodexMessage({ projectDirectory, text: trimmed });
      setActiveTurn(result);
      return true;
    } catch (error) {
      setSending(false);
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
      return false;
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = composer.trim();
    if (!text) return;
    setComposer('');
    await dispatchMessage(text);
  }

  async function applyStyleSelection() {
    if (!projectDirectory) return;
    // A Fase 2 renderiza no Remotion. O aplicativo prepara o motor e monta o
    // projeto antes de falar com o agente, para ele nunca precisar de rede
    // nem inventar um pipeline proprio.
    const runtime = await window.edvidDesktop.ensureRemotionRuntime();
    setRemotionRuntime(runtime);
    if (runtime.status !== 'ready') {
      const reason = runtime.status === 'error' && runtime.error ? ` Motivo: ${runtime.error}` : '';
      setMessages((current) => [...current, {
        id: `error:${Date.now()}`,
        role: 'system',
        text: `Não foi possível preparar o motor de render da Fase 2.${reason} Clique em "Salvar e aplicar" para tentar de novo.`,
      }]);
      return;
    }
    try {
      await window.edvidDesktop.scaffoldRemotionProject(projectDirectory);
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
      return;
    }
    localStorage.setItem(styleStorageKey(projectDirectory), JSON.stringify(style));
    setStyleApplied(true);
    const enabled = Object.entries(style.elements).filter(([, value]) => value).map(([key]) => key).join(', ') || 'nenhum';
    const disabled = Object.entries(style.elements).filter(([, value]) => !value).map(([key]) => key).join(', ') || 'nenhum';
    const prompt = [
      'Aplique estas escolhas de estilo na Fase 2 do projeto:',
      `- Tipo de edição: ${style.edit}`,
      `- Headline: ${style.headline}`,
      `- Legendas: ${style.captions}`,
      `- Cor de destaque: ${style.accent}`,
      `- Elementos incluídos: ${enabled}`,
      `- Elementos fora: ${disabled}`,
      `- Observação: ${style.note.trim() || 'nenhuma'}`,
      '',
      'O Edvid já montou o projeto Remotion em edit/remotion, com as dependências instaladas.',
      'Prepare apenas os dados em edit/remotion/public/ (com os geradores oficiais), nunca legendas queimadas por FFmpeg nem imagens geradas em Python.',
      `Escreva as escolhas acima em edit/remotion/public/edit-data.json, incluindo hook.accent e captions.accent com ${style.accent}.`,
      'Não execute remotion render: quando os dados estiverem prontos, encerre o turno com um resumo curto — o Edvid renderiza sozinho e mostra o progresso na interface.',
      'Use essas seleções como briefing definitivo e não peça para eu escolher os estilos novamente no chat.',
    ].join('\n');
    // O briefing técnico segue completo para o agente; no chat aparece só a
    // intenção do usuário.
    if (await dispatchMessage(prompt, 'Aplicar os estilos escolhidos na edição')) setWorkTab('edit');
  }

  async function approveCleanCut(messageId: string) {
    if (approvingCut || sending) return;
    setApprovingCut(true);
    const prompt = [
      'Aprovado. Considere o corte limpo oficialmente aprovado e preserve este gate.',
      'Não faça perguntas de estilo no chat: o usuário escolherá tipo de edição, headline, legendas e elementos visualmente na aba Estilos.',
      'Aguarde o briefing estruturado que será enviado automaticamente ao clicar em “Salvar e aplicar”.',
    ].join(' ');
    const sent = await dispatchMessage(prompt, 'Aprovado');
    if (sent) {
      setHandledCutApprovalId(messageId);
      setWorkTab('styles');
      setMessages((current) => [...current, {
        id: `style-gate:${Date.now()}`,
        role: 'assistant',
        text: 'Corte aprovado. Escolha os estilos visuais na aba Estilos e clique em “Salvar e aplicar” para a Fase 2 começar — ou, se quiser, aplique antes o J-Cut nas transições.',
      }]);
    }
    setApprovingCut(false);
  }

  async function applyJcut() {
    if (jcutApplied || sending) return;
    const prompt = [
      'Aplique J-cuts no corte limpo aprovado: nas transições adequadas, antecipe o áudio da cena seguinte em relação ao corte de vídeo (entre 60 e 200 ms, conforme a respiração da fala).',
      'Re-renderize o corte com os J-cuts e atualize edit/edl.json mantendo os ranges nos tempos da fonte e preenchendo jcut_timeline com as posições reais no arquivo de saída.',
      'Preserve o gate do corte aprovado e não faça perguntas de estilo no chat.',
    ].join(' ');
    if (await dispatchMessage(prompt, 'Aplicar J-Cut')) setJcutApplied(true);
  }

  function handleTimelineModelChange(model: TimelineModel, commit: boolean) {
    const directory = activeProjectDirectoryRef.current;
    const loadStamp = workspace?.timelineLoadStamp ?? '';
    setWorkspace((current) => (
      current
        ? { ...current, timelineModel: model, timeline: { segments: deriveSegments(model) } }
        : current
    ));
    if (!commit || !directory) return;
    pendingTimelineSaveRef.current = { directory, model, loadStamp };
    if (timelineSaveTimerRef.current !== null) window.clearTimeout(timelineSaveTimerRef.current);
    timelineSaveTimerRef.current = window.setTimeout(() => {
      timelineSaveTimerRef.current = null;
      const pending = pendingTimelineSaveRef.current;
      if (!pending) return;
      pendingTimelineSaveRef.current = null;
      void window.edvidDesktop.saveTimelineModel(pending.directory, pending.model, pending.loadStamp).catch((error) => {
        setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
      });
    }, 400);
  }

  async function applyTimelineEdits() {
    const model = workspace?.timelineModel;
    if (!model) return false;
    const ranges = edlRangesFromModel(model);
    if (ranges.length === 0) return false;
    const sourceName = (id: string) => workspace?.sources.find((source) => source.id === id)?.name ?? id;
    const prompt = [
      'Editei a timeline diretamente no Edvid Desktop (trims, cortes e exclusões de takes).',
      'Atualize o edit/edl.json para conter exatamente estes ranges, nesta ordem. Os tempos são em segundos no arquivo-fonte indicado:',
      ...ranges.map((range, index) => (
        `${index + 1}. [${range.label}] fonte "${range.sourceId}" (${sourceName(range.sourceId)}): IN ${range.start.toFixed(3)}s | OUT ${range.end.toFixed(3)}s${range.gainDb ? ` | ganho ${range.gainDb} dB` : ''}`
      )),
      'Mantenha os demais campos do EDL (sources, grade, voice_master), recalcule total_duration_s e regenere o jcut_timeline ao re-renderizar.',
      'Depois re-renderize o corte com esses ranges e atualize o preview. Não peça para eu reenviar estes tempos.',
    ].join('\n');
    return dispatchMessage(
      prompt,
      `Aplicar edições da timeline (${ranges.length} ${ranges.length === 1 ? 'trecho' : 'trechos'})`,
    );
  }

  async function applyTimelineCorrections(items: CorrectionRange[]) {
    const prompt = [
      `Aplique as ${items.length} correções marcadas na timeline do preview atual.`,
      'Os tempos abaixo são In/Out do vídeo renderizado exibido no preview:',
      ...items.map((item, index) => `${index + 1}. IN ${item.start.toFixed(3)}s | OUT ${item.end.toFixed(3)}s | ${item.note}`),
      'Aplique todas as correções em uma única passagem, valide o novo resultado e atualize o preview.',
      'Crie ou atualize edit/edl.json com um range por cena mantida para a timeline refletir todos os cortes. Não peça para eu reenviar estas marcações.',
    ].join('\n');
    return dispatchMessage(
      prompt,
      `Aplicar ${items.length} ${items.length === 1 ? 'correção marcada' : 'correções marcadas'} na timeline`,
    );
  }

  async function interruptTurn() {
    if (!activeTurn) return;
    try {
      await window.edvidDesktop.interruptCodexTurn(activeTurn.threadId, activeTurn.turnId);
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
    }
  }

  async function answerApproval(approval: CodexApproval, decision: 'accept' | 'acceptForSession' | 'decline') {
    if (answeringApprovalId !== null) return;
    setAnsweringApprovalId(approval.id);
    setApprovalError(null);
    try {
      await window.edvidDesktop.respondToCodexApproval(approval.id, decision);
    } catch (error) {
      setApprovalError(errorMessage(error));
      setAnsweringApprovalId(null);
    }
  }

  function toggleRailPinned() {
    setRailPinned((current) => {
      localStorage.setItem('edvid:rail-pinned', String(!current));
      return !current;
    });
  }

  useEffect(() => {
    const unsubscribe = window.edvidDesktop.onCodexEvent(handleCodexEvent);
    const unsubscribeModel = window.edvidDesktop.onWhisperModelState(setWhisperModel);
    const unsubscribeRemotion = window.edvidDesktop.onRemotionRuntimeState(setRemotionRuntime);
    const unsubscribePhase2 = window.edvidDesktop.onPhase2RenderState(handlePhase2RenderState);
    const unsubscribeUpdate = window.edvidDesktop.onAppUpdateState(setAppUpdate);
    const unsubscribeMember = window.edvidDesktop.onMemberAuthState(setMemberAuth);
    void window.edvidDesktop.getMemberAuth().then(setMemberAuth);
    const unsubscribePack = window.edvidDesktop.onRuntimePackState((state) => {
      setRuntimePack(state);
      // Com as ferramentas instaladas, a lista de dependências da rail deixa
      // de acusar ausências.
      if (state.status === 'ready') void refreshRuntimes();
    });
    void window.edvidDesktop.ensureRuntimePack().then(setRuntimePack);
    if (!booted.current) {
      booted.current = true;
      void window.edvidDesktop.getDesktopInfo().then(setDesktopInfo);
      void window.edvidDesktop.getCodexAccount().then(setAccount);
      void refreshRuntimes();
      // O modelo de transcricao e preparado pelo aplicativo, antes de o
      // usuario pedir o corte: assim a edicao nunca para para baixar nada.
      void window.edvidDesktop.ensureWhisperModel().then(setWhisperModel);
      void window.edvidDesktop.listRecentProjects().then(async (recent) => {
        setProjects(recent);
        if (recent[0]) {
          try {
            activateWorkspace(await window.edvidDesktop.openRecentProject(recent[0].directory));
            setProjects(await window.edvidDesktop.listRecentProjects());
          } catch {
            // A lista continua visível; o usuário pode escolher outra pasta.
          }
        }
      });
    }
    return () => {
      unsubscribe();
      unsubscribeModel();
      unsubscribeRemotion();
      unsubscribePhase2();
      unsubscribeUpdate();
      unsubscribeMember();
      unsubscribePack();
    };
  }, []);

  useEffect(() => {
    if (!followingOutput) return;
    const element = messageListRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, followingOutput, phase2Render.status]);

  // Persiste a conversa e os gates do projeto aberto. As últimas 200 mensagens
  // bastam: o estado real da edição vive nos arquivos do projeto.
  useEffect(() => {
    if (!projectDirectory) return;
    localStorage.setItem(chatStorageKey(projectDirectory), JSON.stringify({
      messages: messages.slice(-200),
      handledCutApprovalId,
      jcutApplied,
    } satisfies StoredChat));
  }, [messages, handledCutApprovalId, jcutApplied, projectDirectory]);

  // Modal do primeiro boot: o pacote de ferramentas baixando com o app
  // inteiro desfocado atrás. Aparece sobre o gate e sobre o estúdio.
  const packModal = (runtimePack.status === 'downloading' || runtimePack.status === 'extracting' || runtimePack.status === 'error') && (
    <div className="pack-overlay" role="dialog" aria-modal="true" aria-label="Preparando o Edvid">
      <div className="pack-modal">
        <strong>Preparando o Edvid</strong>
        {runtimePack.status === 'error' ? (
          <>
            <p className="pack-error">{runtimePack.error ?? 'Não foi possível baixar as ferramentas.'}</p>
            <button type="button" className="btn primary" onClick={() => void window.edvidDesktop.ensureRuntimePack().then(setRuntimePack)}>
              Tentar de novo
            </button>
          </>
        ) : (
          <>
            <div className={`pack-track ${runtimePack.status === 'extracting' ? 'indeterminate' : ''}`}>
              <span
                style={runtimePack.status === 'downloading' && runtimePack.totalBytes
                  ? { width: `${Math.min(100, Math.round(((runtimePack.downloadedBytes ?? 0) / runtimePack.totalBytes) * 100))}%` }
                  : undefined}
              />
            </div>
            <small>Quando terminar você já pode iniciar suas edições</small>
          </>
        )}
      </div>
    </div>
  );

  // Gate do aluno: sem sessão válida, o estúdio inteiro fica atrás do login.
  // "unconfigured" (sem as chaves do Supabase) mantém o app aberto como antes.
  if (memberAuth.status === 'signed-out' || memberAuth.status === 'checking' || memberAuth.status === 'no-access') {
    return (
      <>
        {packModal}
        {appUpdate.status === 'ready' && (
          <button
            type="button"
            className="btn primary small update-ready update-floating"
            onClick={() => void window.edvidDesktop.installAppUpdate()}
            title="A nova versão já foi baixada; o Edvid reinicia atualizado."
          >
            {appUpdate.version ? `Atualizar para ${appUpdate.version}` : 'Atualizar o Edvid'} · Reiniciar
          </button>
        )}
        <MemberGate
          auth={memberAuth}
          onLogin={async (email, password) => {
            setMemberAuth(await window.edvidDesktop.memberLogin(email, password));
          }}
          onLogout={async () => {
            setMemberAuth(await window.edvidDesktop.memberLogout());
          }}
        />
      </>
    );
  }

  return (
    <div className={`studio-shell ${railPinned ? 'rail-pinned' : ''}`}>
      {packModal}
      {/* Menu ⋯ aberto força a rail expandida: o backdrop fica fora dela e
          mataria o hover, colapsando a rail com o menu no ar. */}
      <aside className={`project-rail ${railPinned || projectMenu ? 'pinned' : ''}`}>
        <div className="rail-brand">
          <div className="rail-logo">
            <img className="rail-brand-icon" src={edvidIcon} alt="" />
            <img className="rail-brand-wordmark" src={edvidLogo} alt="Edvid" />
          </div>
          <button type="button" className={`rail-pin ${railPinned ? 'active' : ''}`} onClick={toggleRailPinned} title={railPinned ? 'Recolher barra lateral' : 'Manter barra expandida'}><Icon name="pin" /></button>
        </div>
        <button type="button" className="new-project" onClick={startCreateProject} disabled={openingProject || Boolean(activeTurn)}>
          <span><Icon name="add" /></span><strong>Novo projeto</strong>
        </button>
        <div className="project-list-heading">Recentes</div>
        <nav className="project-list" aria-label="Projetos recentes">
          {projects.map((project) => (
            <div className="project-row" key={project.directory}>
              <button type="button" className={`project-item ${project.directory === projectDirectory ? 'active' : ''}`} onClick={() => openRecentProject(project)} title={project.directory} disabled={Boolean(activeTurn)}>
                <span className="project-item-icon"><Icon name="folder" /></span>
                <span className="project-item-copy">
                  <strong>{project.name}{project.pinned && <span className="pin-flag"><Icon name="pin" /></span>}</strong>
                  <small>{project.directory}</small>
                </span>
              </button>
              <button type="button" className="project-more" onClick={(event) => { event.stopPropagation(); setProjectMenu((current) => current === project.directory ? null : project.directory); }} title="Opções do projeto">
                <Icon name="more" />
              </button>
              {projectMenu === project.directory && (
                <div className="project-menu" role="menu">
                  <button type="button" onClick={() => void togglePinProject(project)}>{project.pinned ? 'Desafixar' : 'Fixar'}</button>
                  <button type="button" onClick={() => startRenameProject(project)}>Renomear</button>
                  <button type="button" className="danger" onClick={() => void removeProjectFromList(project)}>Excluir</button>
                </div>
              )}
            </div>
          ))}
          {projects.length === 0 && <div className="project-list-empty">Seus projetos aparecerão aqui.</div>}
        </nav>
        <div className="rail-footer">
          <div className="rail-account">
            <span className="account-avatar signed-in">{(memberAuth.name ?? memberAuth.email ?? 'E').slice(0, 1).toUpperCase()}</span>
            <span className="rail-account-copy">
              <strong>{memberAuth.name ?? memberAuth.email ?? 'Edvid'}</strong>
              <small>{memberAuth.status === 'signed-in' ? memberAuth.email : 'Creator Factory'}</small>
            </span>
            <button type="button" className="account-action gear" onClick={() => setSettingsOpen(true)} title="Configurações"><Icon name="settings" /></button>
          </div>
        </div>
      </aside>

      <main className="studio-main">
        <header className="studio-topbar">
          <div className="active-project">
            <div><span>Projeto</span><strong>{workspace?.project.name ?? 'Nenhum projeto selecionado'}</strong></div>
          </div>
          {workspace && (
            <div className="project-subcard">
              <span className="project-path" title={workspace.project.directory}>{workspace.project.directory}</span>
              <button
                type="button"
                className="subcard-action"
                onClick={() => void window.edvidDesktop.openProjectFolder(workspace.project.directory).catch(() => {})}
                title="Abrir a pasta do projeto"
              >
                <Icon name="folder" />
              </button>
              {workspace.media && (
                <span className="subcard-meta">{workspace.media.orientation === 'vertical' ? '9:16 vertical' : '16:9 horizontal'} · {workspace.media.width}×{workspace.media.height}</span>
              )}
            </div>
          )}
          <div className="topbar-actions">
            {appUpdate.status === 'ready' && (
              <button
                type="button"
                className="btn primary small update-ready"
                onClick={() => void window.edvidDesktop.installAppUpdate()}
                title="A nova versão já foi baixada; o Edvid reinicia atualizado."
              >
                {appUpdate.version ? `Atualizar para ${appUpdate.version}` : 'Atualizar o Edvid'} · Reiniciar
              </button>
            )}
          </div>
        </header>

        <div className="studio-grid">
          <section className="chat-panel">
            <div className="chat-head">
              <div><span className="eyebrow">Direção da edição</span><h1>Converse com o Edvid</h1></div>
              {!canChat && <span className="work-status"><span />Configuração pendente</span>}
            </div>
            <div
              className="chat-transcript"
              ref={messageListRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                setFollowingOutput(element.scrollHeight - element.scrollTop - element.clientHeight < 64);
              }}
            >
              {!workspace && (
                <div className="chat-empty">
                  <span className="chat-empty-icon"><Icon name="folder" /></span>
                  <h2>Comece por um projeto</h2>
                  <p>Escolha a pasta do vídeo. O preview, a timeline e a conversa ficarão reunidos nesta janela.</p>
                  <button type="button" className="btn primary" onClick={startCreateProject}>Novo projeto</button>
                </div>
              )}
              {workspace && account.status !== 'signed-in' && messages.length === 0 && (
                <div className="auth-inline">
                  <span className="chat-empty-icon"><Icon name="chat" /></span>
                  <h2>Conecte sua conta do ChatGPT</h2>
                  <p>O login acontece no navegador e volta automaticamente para o Edvid.</p>
                  {account.error && <div className="inline-error">{account.error}</div>}
                  <button type="button" className="btn primary" onClick={account.status === 'waiting-for-browser' ? cancelLogin : login} disabled={account.status === 'starting'}>{account.status === 'waiting-for-browser' ? 'Cancelar login' : account.status === 'starting' ? 'Preparando...' : 'Entrar com ChatGPT'}</button>
                </div>
              )}
              {workspace && account.status === 'signed-in' && messages.length === 0 && (
                <div className="chat-empty compact">
                  <span className="chat-empty-icon"><Icon name="sparkles" /></span>
                  <h2>O que vamos editar?</h2>
                  <p>O corte limpo vem primeiro. Depois da aprovação, os estilos aparecem visualmente na aba ao lado.</p>
                  <div className="prompt-examples">
                    <button type="button" onClick={() => void dispatchMessage('Inicie a edição do vídeo e prepare o corte limpo.', 'Iniciar o corte limpo')} disabled={sending || whisperModel.status === 'downloading' || (runtimePack.status !== 'ready' && runtimePack.status !== 'unknown')}>Iniciar corte limpo</button>
                    <button type="button" onClick={() => void dispatchMessage('Analise os vídeos e imagens da pasta assets.')} disabled={sending}>Analisar assets</button>
                  </div>
                  {whisperModel.status === 'downloading' && (
                    <div className="model-status">
                      <span className="model-status-orb" />
                      Preparando a transcrição{whisperModel.downloadedBytes ? ` · ${Math.round(whisperModel.downloadedBytes / 1e6)} MB` : ''}
                    </div>
                  )}
                  {whisperModel.status === 'error' && (
                    <div className="model-status error">
                      Não foi possível preparar a transcrição. Verifique a conexão e reabra o Edvid.
                    </div>
                  )}
                </div>
              )}
              {messages.map((message) => {
                const visibleText = message.role === 'assistant' ? cleanAssistantText(message.text) : message.text;
                const showsCutApproval = message.id === pendingCutApprovalId;
                return (
                  <article className={`chat-message ${message.role}`} key={message.id}>
                    <span className="chat-role">{message.role === 'user' ? 'Você' : message.role === 'assistant' ? 'Edvid' : 'Sistema'}</span>
                    <p>{visibleText || '...'}</p>
                    {showsCutApproval && (
                      <div className="clean-cut-gate">
                        <div><strong>Corte limpo pronto</strong><span>Assista no preview e confirme para escolher os estilos.</span></div>
                        <button type="button" className="btn primary" onClick={() => void approveCleanCut(message.id)} disabled={sending || approvingCut}>
                          <Icon name="check" /> {approvingCut ? 'Aprovando...' : 'Aprovado'}
                        </button>
                      </div>
                    )}
                    {message.id.startsWith('style-gate:') && (
                      <div className="clean-cut-gate jcut-gate">
                        <div><strong>J-Cut opcional</strong><span>Antecipa o áudio da próxima cena nas transições do corte aprovado.</span></div>
                        <button type="button" className="btn ghost small" onClick={() => void applyJcut()} disabled={sending || jcutApplied}>
                          <Icon name="waveform" /> {jcutApplied ? 'J-Cut aplicado' : 'Aplicar J-Cut'}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
              {canChat && messages.length > 0 && (
                <div className={`chat-status work-status ${activeTurn ? 'working' : 'ready'}`}>
                  <span />{activeTurn ? 'Trabalhando' : 'Pronto'}
                </div>
              )}
              {phase2Render.status === 'rendering' && (
                <div className="phase2-render-banner" role="status">
                  <span className="phase2-render-orb" />
                  <div className="phase2-render-copy">
                    <strong>Renderizando a edição estilizada</strong>
                    <small>
                      {phase2Render.totalFrames
                        ? `${Math.round((phase2Render.progress ?? 0) * 100)}% · ${phase2Render.renderedFrames ?? 0}/${phase2Render.totalFrames} frames`
                        : 'Preparando o render. O resultado entra no preview sozinho.'}
                    </small>
                  </div>
                  <div className="phase2-render-track">
                    <span style={{ width: `${Math.min(100, Math.round((phase2Render.progress ?? 0) * 100))}%` }} />
                  </div>
                </div>
              )}
            </div>
            {!followingOutput && <button type="button" className="scroll-to-latest" onClick={() => { setFollowingOutput(true); const element = messageListRef.current; if (element) element.scrollTop = element.scrollHeight; }}><Icon name="arrowDown" /> Ir para o fim</button>}
            <form className="chat-composer" onSubmit={sendMessage}>
              <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={canChat ? 'Descreva a próxima alteração...' : 'Conecte a conta e escolha um projeto'} disabled={!canChat || sending} rows={2} />
              {activeTurn
                ? <button className="composer-inline stop" type="button" onClick={interruptTurn} title="Parar"><Icon name="stop" /></button>
                : <button className="composer-inline send" type="submit" disabled={!canChat || !composer.trim() || sending} title="Enviar (Enter)"><Icon name="enter" /></button>}
            </form>
          </section>

          <section className="work-panel">
            <nav className="work-tabs" aria-label="Área de trabalho">
              <button type="button" className={workTab === 'edit' ? 'active' : ''} onClick={() => setWorkTab('edit')}><Icon name="layers" /><strong>Edição</strong></button>
              <button type="button" className={workTab === 'styles' ? 'active' : ''} onClick={() => setWorkTab('styles')}><Icon name="sparkles" /><strong>Estilos</strong></button>
            </nav>
            <div className="work-content">
              {workTab === 'edit' ? (
                <EditorWorkspace
                  workspace={workspace}
                  style={style}
                  styleApplied={styleApplied}
                  corrections={corrections}
                  onCorrectionsChange={setCorrections}
                  onApplyCorrections={applyTimelineCorrections}
                  applyingCorrections={sending}
                  onTimelineModelChange={handleTimelineModelChange}
                  onApplyTimelineEdits={applyTimelineEdits}
                />
              ) : <StyleWorkspace style={style} onChange={setStyle} onApply={applyStyleSelection} canApply={canChat} applying={sending} runtime={remotionRuntime} />}
            </div>
          </section>
        </div>
      </main>

      {activeApproval && (
        <div className="approval-overlay">
          <section
            className="approval-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="approval-title"
            aria-describedby="approval-description"
          >
            <header className="approval-dialog-head">
              <span className="approval-dialog-icon"><Icon name="settings" /></span>
              <div>
                <span className="approval-kicker">Permissão local</span>
                <h2 id="approval-title">
                  {activeApproval.kind === 'command' ? 'Permitir execução no computador?' : 'Permitir alteração nos arquivos?'}
                </h2>
              </div>
              {approvals.length > 1 && <span className="approval-queue">1 de {approvals.length}</span>}
            </header>

            <p id="approval-description" className="approval-description">
              O Edvid precisa desta autorização para continuar a tarefa. O processo ficará pausado até você decidir.
            </p>

            <div className="approval-detail">
              <span>{activeApproval.kind === 'command' ? 'Comando solicitado' : 'Alteração solicitada'}</span>
              <strong>{activeApproval.title}</strong>
              {activeApproval.detail && <code>{activeApproval.detail}</code>}
              {activeApproval.cwd && (
                <div className="approval-project">
                  <span>Projeto</span>
                  <small>{activeApproval.cwd}</small>
                </div>
              )}
            </div>

            {approvalError && <div className="approval-error">{approvalError}</div>}
            <p className="approval-privacy">Esta autorização é local e não fará parte do histórico do chat.</p>

            <div className="approval-actions">
              <button
                type="button"
                className="btn ghost danger"
                onClick={() => void answerApproval(activeApproval, 'decline')}
                disabled={answeringApprovalId !== null}
              >
                Recusar
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => void answerApproval(activeApproval, 'acceptForSession')}
                disabled={answeringApprovalId !== null}
              >
                Permitir nesta sessão
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void answerApproval(activeApproval, 'accept')}
                disabled={answeringApprovalId !== null}
              >
                {answeringApprovalId === activeApproval.id ? 'Autorizando...' : 'Permitir uma vez'}
              </button>
            </div>
          </section>
        </div>
      )}

      {projectMenu && <div className="menu-backdrop" onClick={() => setProjectMenu(null)} />}

      {nameDialog && (
        <div className="modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) setNameDialog(null); }}>
          <section className="name-dialog" role="dialog" aria-modal="true">
            <h2>{nameDialog.mode === 'create' ? 'Novo projeto' : 'Renomear projeto'}</h2>
            <p>{nameDialog.mode === 'create' ? 'Dê um nome ao projeto e escolha a pasta com o vídeo.' : 'O novo nome aparece na lista e no topo do Edvid.'}</p>
            <input
              type="text"
              value={nameValue}
              autoFocus
              maxLength={60}
              placeholder="Nome do projeto"
              onChange={(event) => setNameValue(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void confirmNameDialog(); if (event.key === 'Escape') setNameDialog(null); }}
            />
            <div className="name-dialog-actions">
              <button type="button" className="btn ghost" onClick={() => setNameDialog(null)}>Cancelar</button>
              <button type="button" className="btn primary" onClick={() => void confirmNameDialog()} disabled={nameDialog.mode === 'rename' && !nameValue.trim()}>
                {nameDialog.mode === 'create' ? 'Escolher pasta...' : 'Salvar'}
              </button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-label="Configurações">
            <header className="settings-head">
              <h2>Configurações</h2>
              <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)} title="Fechar">✕</button>
            </header>
            <nav className="settings-tabs">
              <button type="button" className={settingsTab === 'geral' ? 'active' : ''} onClick={() => setSettingsTab('geral')}>Geral</button>
              <button type="button" className={settingsTab === 'conexoes' ? 'active' : ''} onClick={() => setSettingsTab('conexoes')}>Conexões</button>
            </nav>
            {settingsTab === 'geral' ? (
              <div className="settings-body">
                <div className="settings-block">
                  <h3>Conta do aluno</h3>
                  {memberAuth.status === 'signed-in' ? (
                    <div className="settings-row">
                      <div><strong>{memberAuth.name ?? memberAuth.email}</strong><small>{memberAuth.email}{memberAuth.offline ? ' · validação offline' : ''}</small></div>
                      <button type="button" className="account-action" onClick={() => void window.edvidDesktop.memberLogout().then(setMemberAuth)}>Sair</button>
                    </div>
                  ) : (
                    <p className="settings-note">O login de aluno não está ativo nesta instalação.</p>
                  )}
                </div>
                <div className="settings-block">
                  <h3>Conexão de IA</h3>
                  <div className="settings-row">
                    <div><strong>ChatGPT</strong><small>{accountLabel}</small></div>
                    {account.status === 'signed-in'
                      ? <button type="button" className="account-action" onClick={logout}>Sair</button>
                      : <button type="button" className="account-action" onClick={account.status === 'waiting-for-browser' ? cancelLogin : login}>{account.status === 'waiting-for-browser' ? 'Cancelar' : 'Entrar'}</button>}
                  </div>
                </div>
                <div className="settings-block">
                  <h3>Dependências</h3>
                  <div className="settings-row">
                    <div>
                      <strong>{checking ? 'Verificando...' : `${readyRuntimes}/${runtimeNames.length} ferramentas prontas`}</strong>
                      <small>{missingRuntimeNames.length ? `Pendentes: ${missingRuntimeNames.join(', ')}` : `Todas instaladas${desktopInfo ? ` · ${desktopInfo.platform} ${desktopInfo.arch}` : ''}`}</small>
                    </div>
                    <button type="button" className="account-action" onClick={refreshRuntimes} disabled={checking}>Verificar</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="settings-body">
                <div className="settings-block">
                  <h3>Conexões</h3>
                  <p className="settings-note">Em breve: chaves de API e conexões MCP para ampliar o Edvid.</p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
