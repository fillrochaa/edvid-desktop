import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import edvidLogo from './brand/edvid-logo-white.png';
import type {
  CodexAccountState,
  CodexApproval,
  CodexEvent,
  DesktopInfo,
  ProjectSummary,
  ProjectWorkspace,
  RuntimeCheck,
} from './shared';

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
  | 'folder'
  | 'image'
  | 'layers'
  | 'music'
  | 'pin'
  | 'play'
  | 'refresh'
  | 'settings'
  | 'sparkles'
  | 'video'
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
    folder: <path d="M1.5 4.2h5l1.2 1.5h6.8v7.2h-13z" />,
    image: <><rect x="1.5" y="2.2" width="13" height="11.6" rx="2" /><path d="m3.5 11 3-3 2.1 2 1.7-1.5 2.2 2.5M11.3 5.5h.1" /></>,
    layers: <><path d="m8 1.8 6.2 3.4L8 8.6 1.8 5.2z" /><path d="m2 8 6 3.3L14 8M2 10.8l6 3.3 6-3.3" /></>,
    music: <><path d="M6 12.2V4l7-1.5v8" /><circle cx="3.9" cy="12.3" r="2" /><circle cx="10.9" cy="10.7" r="2" /></>,
    pin: <path d="m5 2 6 1-1.4 3 2.1 2.1-3 1.1-2.5 4.5-.5-4.9-3-1.4 2.4-1.8z" />,
    play: <path d="m5 2.5 8 5.5-8 5.5z" />,
    refresh: <><path d="M13 6.2A5.5 5.5 0 1 0 13.3 10" /><path d="M13 2.7v3.5H9.5" /></>,
    settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" /></>,
    sparkles: <><path d="M8 1.5 9.2 5 12.5 6.2 9.2 7.4 8 11 6.8 7.4 3.5 6.2 6.8 5z" /><path d="m12.8 10 .5 1.5 1.4.5-1.4.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" /></>,
    video: <><rect x="1.4" y="3" width="10" height="10" rx="2" /><path d="m11.4 6.2 3.2-1.8v7.2l-3.2-1.8" /></>,
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

function styleStorageKey(directory: string): string {
  return `edvid:style:${directory}`;
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

function HeadlinePreview({ style, accent }: { style: HeadlineStyle; accent: string }) {
  if (style === 'none') return <div className="none-preview">Sem texto</div>;
  return (
    <div className={`headline-preview ${style}`} style={{ '--preview-accent': accent } as CSSProperties}>
      <span>Este é o seu</span>
      <span>novo headline</span>
    </div>
  );
}

function CaptionPreview({ style, accent }: { style: CaptionStyle; accent: string }) {
  if (style === 'none') return <div className="none-preview">Sem legendas</div>;
  return (
    <div className={`caption-preview ${style}`} style={{ '--preview-accent': accent } as CSSProperties}>
      <span>É assim que sua</span>
      <span>legenda aparece</span>
    </div>
  );
}

function ChoiceCard({
  selected,
  title,
  subtitle,
  onClick,
  children,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`choice-card ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <div className="choice-visual">{children}</div>
      <span className="choice-name">{title}</span>
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
        <span>{label}</span>
      </div>
      <div className="studio-lane">{children}</div>
    </div>
  );
}

function EditorWorkspace({
  workspace,
  style,
  styleApplied,
  onRefresh,
}: {
  workspace: ProjectWorkspace | null;
  style: StyleSetup;
  styleApplied: boolean;
  onRefresh: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const media = workspace?.media ?? null;
  const timelineSegments = workspace?.timeline?.segments ?? [];
  const timelineDuration = timelineSegments.reduce(
    (maximum, segment) => Math.max(maximum, segment.start + segment.duration),
    0,
  );
  const [duration, setDuration] = useState(workspace?.media?.duration ?? timelineDuration);
  const effectiveDuration = duration || timelineDuration;
  const phase = media?.kind === 'final' || styleApplied ? 2 : 1;
  const progress = effectiveDuration > 0 ? Math.min(1, currentTime / effectiveDuration) : 0;

  useEffect(() => {
    setCurrentTime(0);
    setDuration(media?.duration ?? timelineDuration);
  }, [media?.url, media?.duration, timelineDuration]);

  function seek(value: number) {
    setCurrentTime(value);
    if (videoRef.current) videoRef.current.currentTime = value;
  }

  const trackStyle = { '--timeline-progress': `${progress * 100}%` } as CSSProperties;
  const orientation = media?.orientation ?? 'horizontal';

  return (
    <div className={`editor-workspace ${orientation}`}>
      <section className="preview-section">
        <div className="preview-toolbar">
          <div>
            <span className="eyebrow">Preview</span>
            <strong>{media?.name ?? 'Aguardando vídeo'}</strong>
          </div>
          <button type="button" className="icon-button" onClick={onRefresh} title="Atualizar arquivos do projeto">
            <Icon name="refresh" />
          </button>
        </div>
        <div className={`video-stage ${orientation}`}>
          {media ? (
            <video
              key={media.url}
              ref={videoRef}
              src={media.url}
              controls
              preload="metadata"
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            />
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
        <div className="timeline-toolbar">
          <div className="phase-copy">
            <span className={`phase-badge phase-${phase}`}>Fase {phase}</span>
            <div>
              <strong>{phase === 1 ? 'Limpeza e corte' : 'Edição completa'}</strong>
              <small>{phase === 1 ? 'Aprovação do corte limpo' : 'Novas camadas na mesma timeline'}</small>
            </div>
          </div>
          <div className="timeline-time">{formatTime(currentTime)} <span>/ {formatTime(effectiveDuration)}</span></div>
        </div>
        <div className="timeline-scroll" style={trackStyle}>
          <div className="timeline-ruler">
            <span>00:00</span><span>{formatTime(effectiveDuration * 0.25)}</span><span>{formatTime(effectiveDuration * 0.5)}</span><span>{formatTime(effectiveDuration * 0.75)}</span><span>{formatTime(effectiveDuration)}</span>
          </div>
          {phase === 2 && style.headline !== 'none' && (
            <TimelineTrack icon="sparkles" label="Headline" tone="orange">
              <div className="timeline-chip headline-chip" style={{ width: '31%' }}>Headline · {style.headline}</div>
            </TimelineTrack>
          )}
          {phase === 2 && style.captions !== 'none' && (
            <TimelineTrack icon="captions" label="Legendas" tone="teal">
              <div className="timeline-chip captions-chip" style={{ left: '2%', width: '96%' }}>Legendas · {style.captions}</div>
            </TimelineTrack>
          )}
          {phase === 2 && style.edit !== 'limpa' && (
            <TimelineTrack icon="image" label="Assets" tone="orange">
              <div className="timeline-chip asset-chip" style={{ left: '8%', width: '22%' }}>Insert 01</div>
              <div className="timeline-chip asset-chip" style={{ left: '48%', width: '28%' }}>Insert 02</div>
            </TimelineTrack>
          )}
          <TimelineTrack icon="video" label="Vídeo" tone="orange">
            {(timelineSegments.length > 0
              ? timelineSegments
              : [{ label: media?.name ?? 'Vídeo', start: 0, duration: effectiveDuration || 1 }]
            ).map((segment, index) => (
              <div
                className={`timeline-clip video-clip ${index % 2 ? 'alt' : ''}`}
                key={`${segment.start}:${segment.label}`}
                style={{
                  left: `${effectiveDuration > 0 ? (segment.start / effectiveDuration) * 100 : 0}%`,
                  width: `${effectiveDuration > 0 ? (segment.duration / effectiveDuration) * 100 : 100}%`,
                }}
                title={`${segment.label} · ${formatTime(segment.duration)}`}
              >
                <span>{segment.label}</span>
              </div>
            ))}
          </TimelineTrack>
          <TimelineTrack icon="waveform" label="Voz" tone="teal">
            <div className="timeline-clip audio-clip"><span>Voz tratada</span></div>
          </TimelineTrack>
          {phase === 2 && style.elements.musicAI && (
            <TimelineTrack icon="music" label="Trilha" tone="olive">
              <div className="timeline-chip music-chip" style={{ left: '0%', width: '100%' }}>Trilha sonora · −15 dB</div>
            </TimelineTrack>
          )}
          <div className="timeline-playhead" />
        </div>
        <input
          className="timeline-scrubber"
          aria-label="Posição do vídeo"
          type="range"
          min="0"
          max={effectiveDuration || 1}
          step="0.01"
          value={Math.min(currentTime, effectiveDuration || 1)}
          onChange={(event) => seek(Number(event.target.value))}
          disabled={!media}
        />
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
}: {
  style: StyleSetup;
  onChange: (style: StyleSetup) => void;
  onApply: () => void;
  canApply: boolean;
  applying: boolean;
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
            <span className="eyebrow">Gate da Fase 2</span>
            <h2>Escolha olhando, não imaginando</h2>
            <p>Estas escolhas entram no projeto como um briefing estruturado e continuam editáveis.</p>
          </div>
          <span className="style-status"><Icon name="sparkles" /> Preview dos estilos</span>
        </div>

        <section className="style-group">
          <div className="style-group-head"><span>01</span><div><h3>Tipo de edição</h3><p>Define como pessoa e inserts dividem o quadro.</p></div></div>
          <div className="choice-grid edit-choice-grid">
            {editStyles.map((option) => (
              <ChoiceCard key={option.id} selected={style.edit === option.id} title={option.name} subtitle={option.description} onClick={() => onChange({ ...style, edit: option.id })}>
                <EditStylePreview style={option.id} />
              </ChoiceCard>
            ))}
          </div>
        </section>

        <section className="style-group accent-group">
          <div className="style-group-head"><span>02</span><div><h3>Cor de destaque</h3><p>Usada por Realce, Misto e legenda Empilhada.</p></div></div>
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
          <div className="style-group-head"><span>03</span><div><h3>Estilo de headline</h3><p>Duas linhas balanceadas para o hook.</p></div></div>
          <div className="choice-grid headline-choice-grid">
            {headlineStyles.map((option) => (
              <ChoiceCard key={option.id} selected={style.headline === option.id} title={option.name} onClick={() => onChange({ ...style, headline: option.id })}>
                <HeadlinePreview style={option.id} accent={style.accent} />
              </ChoiceCard>
            ))}
          </div>
        </section>

        <section className="style-group">
          <div className="style-group-head"><span>04</span><div><h3>Estilo de legenda</h3><p>Escolha o ritmo visual que acompanha a fala.</p></div></div>
          <div className="choice-grid caption-choice-grid">
            {captionStyles.map((option) => (
              <ChoiceCard key={option.id} selected={style.captions === option.id} title={option.name} subtitle={option.kind} onClick={() => onChange({ ...style, captions: option.id })}>
                <CaptionPreview style={option.id} accent={style.accent} />
              </ChoiceCard>
            ))}
          </div>
        </section>

        <section className="style-group">
          <div className="style-group-head"><span>05</span><div><h3>Elementos da edição</h3><p>Desmarcado significa que o elemento ficará fora.</p></div></div>
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
        <div><strong>Briefing visual pronto</strong><span>O Edvid receberá também tudo o que ficou desmarcado.</span></div>
        <button type="button" className="btn primary apply-style" onClick={onApply} disabled={!canApply || applying}>
          <Icon name="sparkles" /> {applying ? 'Enviando...' : 'Aplicar escolhas'}
        </button>
      </div>
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
  const [composer, setComposer] = useState('');
  const [checking, setChecking] = useState(true);
  const [sending, setSending] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);
  const [activeTurn, setActiveTurn] = useState<{ threadId: string; turnId: string } | null>(null);
  const [railPinned, setRailPinned] = useState(() => localStorage.getItem('edvid:rail-pinned') === 'true');
  const [workTab, setWorkTab] = useState<WorkTab>('edit');
  const [style, setStyle] = useState<StyleSetup>(defaultStyleSetup);
  const [styleApplied, setStyleApplied] = useState(false);
  const [followingOutput, setFollowingOutput] = useState(true);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const activeProjectDirectoryRef = useRef<string | null>(null);
  const booted = useRef(false);

  const projectDirectory = workspace?.project.directory ?? null;
  const canChat = Boolean(projectDirectory) && account.status === 'signed-in';
  const readyRuntimes = runtimes.filter((runtime) => runtime.available).length;
  const accountLabel = account.account?.email ?? (account.status === 'waiting-for-browser' ? 'Conclua no navegador' : 'ChatGPT desconectado');

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
    setWorkspace(next);
    setMessages([]);
    setApprovals([]);
    setStyle(readStoredStyle(next.project.directory, next.style ?? defaultStyleSetup));
    setStyleApplied(next.media?.kind === 'final' || Boolean(next.style));
    setWorkTab('edit');
    setFollowingOutput(true);
  }

  async function reloadProjects() {
    setProjects(await window.edvidDesktop.listRecentProjects());
  }

  async function chooseProjectDirectory() {
    setOpeningProject(true);
    try {
      const selected = await window.edvidDesktop.selectProjectDirectory();
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

  async function refreshWorkspace() {
    const directory = activeProjectDirectoryRef.current;
    if (!directory) return;
    try {
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
      setMessages([]);
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
      }
      return;
    }
    if (event.type === 'approval-requested') {
      setApprovals((current) => [...current, event.approval]);
      return;
    }
    if (event.type === 'approval-resolved') {
      setApprovals((current) => current.filter((approval) => approval.id !== event.approvalId));
      return;
    }
    if (event.type === 'error') {
      setSending(false);
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: event.message }]);
    }
  }

  async function dispatchMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !projectDirectory || account.status !== 'signed-in' || sending) return false;
    setSending(true);
    setFollowingOutput(true);
    setMessages((current) => [...current, { id: `user:${Date.now()}`, role: 'user', text: trimmed }]);
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
      'Use essas seleções como briefing definitivo e não peça para eu escolher os estilos novamente no chat.',
    ].join('\n');
    if (await dispatchMessage(prompt)) setWorkTab('edit');
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
    try {
      await window.edvidDesktop.respondToCodexApproval(approval.id, decision);
    } catch (error) {
      setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) }]);
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
    if (!booted.current) {
      booted.current = true;
      void window.edvidDesktop.getDesktopInfo().then(setDesktopInfo);
      void window.edvidDesktop.getCodexAccount().then(setAccount);
      void refreshRuntimes();
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
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!followingOutput) return;
    const element = messageListRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, approvals, followingOutput]);

  return (
    <div className={`studio-shell ${railPinned ? 'rail-pinned' : ''}`}>
      <aside className={`project-rail ${railPinned ? 'pinned' : ''}`}>
        <div className="rail-brand">
          <div className="rail-logo"><img src={edvidLogo} alt="Edvid" /></div>
          <div className="rail-brand-copy"><strong>Edvid</strong><span>Projetos</span></div>
          <button type="button" className={`rail-pin ${railPinned ? 'active' : ''}`} onClick={toggleRailPinned} title={railPinned ? 'Recolher barra lateral' : 'Manter barra expandida'}><Icon name="pin" /></button>
        </div>
        <button type="button" className="new-project" onClick={chooseProjectDirectory} disabled={openingProject || Boolean(activeTurn)}>
          <span><Icon name="add" /></span><strong>Novo projeto</strong>
        </button>
        <div className="project-list-heading">Recentes</div>
        <nav className="project-list" aria-label="Projetos recentes">
          {projects.map((project) => (
            <button type="button" key={project.directory} className={`project-item ${project.directory === projectDirectory ? 'active' : ''}`} onClick={() => openRecentProject(project)} title={project.directory} disabled={Boolean(activeTurn)}>
              <span className="project-item-icon"><Icon name="folder" /></span>
              <span className="project-item-copy"><strong>{project.name}</strong><small>{project.directory}</small></span>
              <Icon name="chevron" />
            </button>
          ))}
          {projects.length === 0 && <div className="project-list-empty">Seus projetos aparecerão aqui.</div>}
        </nav>
        <div className="rail-footer">
          <button type="button" className="rail-status" onClick={refreshRuntimes} title={missingRuntimeNames.length ? `Pendentes: ${missingRuntimeNames.join(', ')}` : 'Todas as dependências estão prontas'}>
            <span className={`status-orb ${readyRuntimes === runtimeNames.length ? 'ready' : ''}`} />
            <span className="rail-status-copy"><strong>{checking ? 'Verificando...' : `${readyRuntimes}/${runtimeNames.length} dependências`}</strong><small>{desktopInfo ? `${desktopInfo.platform} · ${desktopInfo.arch}` : 'Ambiente local'}</small></span>
          </button>
          <div className="rail-account">
            <span className={`account-avatar ${account.status}`}>{account.account?.email?.slice(0, 1).toUpperCase() ?? 'E'}</span>
            <span className="rail-account-copy"><strong>{accountLabel}</strong><small>{account.status === 'signed-in' ? 'Conta ChatGPT' : 'Conecte sua conta'}</small></span>
            {account.status === 'signed-in' ? <button type="button" className="account-action" onClick={logout}>Sair</button> : <button type="button" className="account-action" onClick={account.status === 'waiting-for-browser' ? cancelLogin : login}>{account.status === 'waiting-for-browser' ? 'Cancelar' : 'Entrar'}</button>}
          </div>
        </div>
      </aside>

      <main className="studio-main">
        <header className="studio-topbar">
          <div className="active-project">
            <span className="project-state-dot" />
            <div><span>Projeto ativo</span><strong>{workspace?.project.name ?? 'Nenhum projeto selecionado'}</strong></div>
            {workspace && <small>{workspace.project.directory}</small>}
          </div>
          <div className="topbar-actions">
            {workspace?.media && <span className="media-meta">{workspace.media.orientation === 'vertical' ? '9:16 vertical' : '16:9 horizontal'} · {workspace.media.width}×{workspace.media.height}</span>}
            <button type="button" className="btn ghost small" onClick={chooseProjectDirectory} disabled={openingProject || Boolean(activeTurn)}>{workspace ? 'Trocar pasta' : 'Escolher pasta'}</button>
          </div>
        </header>

        <div className="studio-grid">
          <section className="chat-panel">
            <div className="chat-head">
              <div><span className="eyebrow">Direção da edição</span><h1>Converse com o Edvid</h1></div>
              <span className={`work-status ${activeTurn ? 'working' : canChat ? 'ready' : ''}`}><span />{activeTurn ? 'Trabalhando' : canChat ? 'Pronto' : 'Configuração pendente'}</span>
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
                  <button type="button" className="btn primary" onClick={chooseProjectDirectory}>Escolher pasta</button>
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
                    <button type="button" onClick={() => setComposer('Inicie a edição do vídeo e prepare o corte limpo.')}>Iniciar corte limpo</button>
                    <button type="button" onClick={() => setComposer('Analise os vídeos e imagens da pasta assets.')}>Analisar assets</button>
                  </div>
                </div>
              )}
              {messages.map((message) => (
                <article className={`chat-message ${message.role}`} key={message.id}>
                  <span className="chat-role">{message.role === 'user' ? 'Você' : message.role === 'assistant' ? 'Edvid' : 'Sistema'}</span>
                  <p>{message.text || '...'}</p>
                </article>
              ))}
              {approvals.map((approval) => (
                <div className="approval-card" key={approval.id}>
                  <span className="approval-kicker">Aprovação necessária</span>
                  <strong>{approval.title}</strong>
                  {approval.detail && <code>{approval.detail}</code>}
                  {approval.cwd && <small>{approval.cwd}</small>}
                  <div className="approval-actions">
                    <button className="btn primary small" onClick={() => answerApproval(approval, 'accept')}>Permitir uma vez</button>
                    <button className="btn ghost small" onClick={() => answerApproval(approval, 'acceptForSession')}>Nesta sessão</button>
                    <button className="btn ghost small danger" onClick={() => answerApproval(approval, 'decline')}>Recusar</button>
                  </div>
                </div>
              ))}
            </div>
            {!followingOutput && <button type="button" className="scroll-to-latest" onClick={() => { setFollowingOutput(true); const element = messageListRef.current; if (element) element.scrollTop = element.scrollHeight; }}><Icon name="arrowDown" /> Ir para o fim</button>}
            <form className="chat-composer" onSubmit={sendMessage}>
              <textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={canChat ? 'Descreva a próxima alteração...' : 'Conecte a conta e escolha um projeto'} disabled={!canChat || sending} rows={2} />
              {activeTurn ? <button className="composer-action stop" type="button" onClick={interruptTurn}>Parar</button> : <button className="composer-action send" type="submit" disabled={!canChat || !composer.trim() || sending}>Enviar</button>}
              <div className="composer-hint"><span>Enter para enviar</span><span>Shift + Enter para nova linha</span></div>
            </form>
          </section>

          <section className="work-panel">
            <nav className="work-tabs" aria-label="Área de trabalho">
              <button type="button" className={workTab === 'edit' ? 'active' : ''} onClick={() => setWorkTab('edit')}><Icon name="layers" /><span><strong>Edição</strong><small>Preview e timeline</small></span></button>
              <button type="button" className={workTab === 'styles' ? 'active' : ''} onClick={() => setWorkTab('styles')}><Icon name="sparkles" /><span><strong>Estilos</strong><small>Visual da Fase 2</small></span></button>
            </nav>
            <div className="work-content">
              {workTab === 'edit' ? <EditorWorkspace workspace={workspace} style={style} styleApplied={styleApplied} onRefresh={refreshWorkspace} /> : <StyleWorkspace style={style} onChange={setStyle} onApply={applyStyleSelection} canApply={canChat} applying={sending} />}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
