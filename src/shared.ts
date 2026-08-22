export type RuntimeName =
  | 'node'
  | 'npm'
  | 'ffmpeg'
  | 'ffprobe'
  | 'uv'
  | 'yt-dlp'
  | 'python'
  | 'whisperx'
  | 'codex-app-server';

export type RuntimeCheck = {
  name: RuntimeName;
  available: boolean;
  version: string | null;
  expectedVersion: string;
  source: 'bundled' | 'system' | 'missing';
  executablePath: string | null;
  error?: string;
};

export type DesktopInfo = {
  platform: NodeJS.Platform;
  arch: string;
  // Mostrada em Configurações → Geral, ao lado de "Verificar atualização".
  appVersion: string;
  electronVersion: string;
  embeddedNodeVersion: string;
};

export type ProjectSummary = {
  directory: string;
  name: string;
  lastOpenedAt: string;
  pinned?: boolean;
};

export type ProjectMedia = {
  url: string;
  name: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  orientation: 'vertical' | 'horizontal';
  kind: 'source' | 'clean-cut' | 'final';
};

export type ProjectTimelineSegment = {
  label: string;
  start: number;
  duration: number;
  audioStart?: number;
  audioDuration?: number;
};

export type ProjectTimeline = {
  segments: ProjectTimelineSegment[];
};

export type TimelineTrackKind = 'video' | 'audio';

export type TimelineTrack = {
  id: string;
  kind: TimelineTrackKind;
  name: string;
};

export type TimelineClip = {
  id: string;
  trackId: string;
  linkId: string | null;
  label: string;
  sourceId: string;
  sourceIn: number;
  sourceOut: number;
  timelineStart: number;
  enabled: boolean;
  speed: number;
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
};

export type TimelineModel = {
  version: 1;
  fps: number;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
};

export type ProjectSource = {
  id: string;
  name: string;
  url: string | null;
  duration: number;
  fps: number;
  width: number;
  height: number;
  available: boolean;
};

export type ProjectStyleState = {
  edit: 'limpa' | 'split' | 'split2';
  headline: 'outline' | 'card' | 'realce' | 'misto' | 'none';
  captions: 'karaoke' | 'stacked' | 'scatter' | 'simples' | 'serifada' | 'classica' | 'none';
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

// Overlays REAIS da Fase 2, lidos do edit-data.json que o agente escreve:
// alimentam as tracks de Legendas/Texto/Animacoes/Imagem/Video da timeline.
export type OverlayClip = {
  start: number;
  end: number;
  label: string;
};

export type ProjectOverlays = {
  hookEnd: number | null;
  images: OverlayClip[];
  videos: OverlayClip[];
  animations: OverlayClip[];
};

export type ProjectWorkspace = {
  project: ProjectSummary;
  media: ProjectMedia | null;
  timeline: ProjectTimeline | null;
  timelineModel: TimelineModel | null;
  timelineModelSynced: boolean;
  timelineLoadStamp: string;
  sources: ProjectSource[];
  style: ProjectStyleState | null;
  overlays: ProjectOverlays | null;
};

export type WhisperModelState = {
  status: 'unknown' | 'downloading' | 'ready' | 'error';
  model: string;
  downloadedBytes?: number;
  error?: string;
};

export type RemotionRuntimeState = {
  status: 'unknown' | 'installing' | 'ready' | 'error';
  step?: 'dependencias' | 'navegador' | 'fontes';
  installedBytes?: number;
  error?: string;
};

// Picos de amplitude (0..1) para desenhar a onda sonora dos clipes. Os picos
// estao no tempo da FONTE; cada clipe recorta o trecho sourceIn..sourceOut.
export type SourceWaveform = {
  bucketsPerSecond: number;
  peaks: number[];
};

// Atualizacao OTA: "ready" significa nova versao ja baixada, aguardando o
// reinicio. O download e a checagem acontecem sozinhos em segundo plano.
export type AppUpdateState = {
  status: 'idle' | 'ready';
  version?: string;
};

// Pacote de runtimes sob demanda: o instalador magro nao embarca as
// ferramentas (FFmpeg, Python/WhisperX, Node, Codex...); o aplicativo baixa
// o pacote uma vez no primeiro boot e a cada mudanca de versao do manifest.
export type RuntimePackState = {
  status: 'unknown' | 'checking' | 'downloading' | 'extracting' | 'ready' | 'error';
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
};

// Login do aluno (Creator Factory / Supabase). "unconfigured" = app sem as
// chaves publicas do projeto: o gate fica desligado e tudo funciona como
// antes. "no-access" = login valido, mas sem matricula ativa no curso.
export type MemberAuthState = {
  status: 'unconfigured' | 'checking' | 'signed-out' | 'signed-in' | 'no-access';
  email?: string;
  name?: string;
  offline?: boolean;
  error?: string;
};

// Render da Fase 2 feito pelo aplicativo, fora do sandbox do agente. "idle"
// tambem cobre "nada a renderizar" (dados do public/ ausentes ou incompletos).
export type Phase2RenderState = {
  status: 'idle' | 'rendering' | 'ready' | 'error';
  progress?: number;
  renderedFrames?: number;
  totalFrames?: number;
  output?: string;
  error?: string;
};

// O corte limpo e feito pelo APLICATIVO, nao pelo agente: transcrever, medir
// o silencio, cortar e concatenar sao sempre os mesmos comandos. O estado
// abaixo e o que a interface mostra enquanto isso acontece.
export type CleanCutState = {
  status: 'idle' | 'transcrevendo' | 'analisando' | 'cortando' | 'pronto' | 'erro';
  // Progresso por ARQUIVO na transcricao (o passo longo com varias fontes).
  done?: number;
  total?: number;
  // Nome do arquivo em transcricao, para a interface dizer o que esta rodando.
  current?: string;
  // Frase pronta em portugues, com os numeros do corte.
  summary?: string;
  error?: string;
};

// Provedor de IA. Cada aluno conecta a propria conta (assinatura OU chave de
// API); o Edvid guarda as credenciais de cada um e QUAL provedor cumpre cada
// PAPEL: "chat" conduz a conversa; "image" gera as imagens pedidas pela
// edicao. Claude nao gera imagem; ChatGPT so gera com login de ASSINATURA (a
// ferramenta do Codex e atrelada a conta ChatGPT, nao a chave de API).
export type AiProvider = 'chatgpt' | 'claude' | 'gemini';

export type AiRole = 'chat' | 'image';

// "Pinned" = escolha explicita do aluno: as regras automaticas nao mexem em
// papel fixado enquanto o provedor fixado continuar conectado e capaz.
export type AiRolesState = {
  chat: AiProvider;
  image: AiProvider | null;
  chatPinned: boolean;
  imagePinned: boolean;
};

// CATALOGO DE IAs (0.15.0): alem das tres contas fixas, o aluno conecta
// provedores do catalogo com a propria chave — de preferencia os de camada
// gratuita — e o Edvid escolhe sozinho quem atende cada papel, trocando
// quando um bate no limite. O catalogo em si vive em ai-catalog.ts.
export type CatalogConnection = {
  id: string;
  connected: boolean;
  // Só o que pode ser mostrado: nunca a chave, apenas os últimos dígitos.
  maskedKey: string | null;
  // Campos nao secretos (ex.: Account ID da Cloudflare) voltam inteiros.
  fields: Record<string, string>;
  // Preenchido quando o provedor bateu no limite; o roteamento o ignora ate la.
  cooldownUntil: number | null;
};

export type CatalogState = {
  connections: CatalogConnection[];
  // Ligado pelo aluno: so usa modelo que nao gasta dinheiro dele.
  freeOnly: boolean;
  // Provedor do catalogo escolhido para CONDUZIR a conversa. Vazio = uma das
  // contas fixas (ChatGPT/Claude/Gemini).
  chatProviderId: string | null;
};

// Quem atendeu (ou vai atender) o papel agora — mostrado abaixo do campo de
// texto do chat, para o aluno nunca ficar no escuro sobre qual IA respondeu.
export type ActiveModelState = {
  role: AiRole;
  providerId: string;
  providerName: string;
  modelLabel: string;
  free: boolean;
} | null;

// Geracao das imagens pedidas pelo agente em edit/imagens/pedidos.json,
// executada pelo aplicativo fora do sandbox depois do turno (mesmo padrao do
// render da Fase 2).
export type ImageGenState = {
  status: 'idle' | 'generating' | 'ready' | 'error';
  total?: number;
  done?: number;
  error?: string;
};

// J-Cut deterministico aplicado pelo aplicativo: o video do corte e copiado
// byte a byte e so o audio e remontado (antecipacao + crossfade) a partir do
// EDL. "sync" reaplica em silencio quando o agente re-renderiza o corte.
export type JcutApplyResult = {
  applied: boolean;
  cuts: number;
  error: string | null;
};

export type JcutSyncResult = {
  changed: boolean;
};

// Conta Claude: assinatura Pro/Max (OAuth do proprio Claude Code) ou chave
// de API da Anthropic. No OAuth o login abre o navegador; "manual" indica
// que o callback local nao pode ser usado e o aluno cola o codigo do site.
export type ClaudeAccountState = {
  status: 'signed-out' | 'waiting-for-browser' | 'signed-in' | 'error';
  email: string | null;
  mode?: 'oauth' | 'api-key';
  manual?: boolean;
  // O codigo chegou e a troca pelo token esta em andamento (com novas
  // tentativas automaticas quando o servidor limita — HTTP 429).
  finishing?: boolean;
  error?: string;
};

// Conta Gemini: somente chave de API (o login gratuito com conta Google do
// Gemini CLI foi descontinuado pelo Google em 06/2026).
export type GeminiAccountState = {
  status: 'signed-out' | 'signed-in' | 'error';
  maskedKey: string | null;
  error?: string;
};

export type CodexAccount = {
  type: 'chatgpt' | 'apiKey' | 'amazonBedrock';
  email: string | null;
  planType: string | null;
};

export type CodexAccountState = {
  status: 'starting' | 'signed-out' | 'waiting-for-browser' | 'signed-in' | 'error';
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
  error?: string;
};

export type CodexApproval = {
  id: string | number;
  kind: 'command' | 'file-change';
  threadId: string;
  turnId: string;
  title: string;
  detail: string | null;
  cwd: string | null;
};

export type CodexEvent =
  | { type: 'account'; state: CodexAccountState }
  | {
      type: 'assistant-delta';
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: 'assistant-final';
      threadId: string;
      turnId: string;
      itemId: string;
      text: string;
    }
  | {
      type: 'turn-state';
      threadId: string;
      turnId: string;
      status: 'started' | 'completed' | 'interrupted' | 'failed';
      error?: string;
    }
  | { type: 'approval-requested'; approval: CodexApproval }
  | { type: 'approval-resolved'; approvalId: string | number }
  | { type: 'error'; message: string };

export type CodexSendMessageInput = {
  projectDirectory: string;
  text: string;
};

export type CodexSendMessageResult = {
  threadId: string;
  turnId: string;
};

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline';

export type EdvidDesktopApi = {
  getDesktopInfo: () => Promise<DesktopInfo>;
  checkRuntimes: () => Promise<RuntimeCheck[]>;
  listRecentProjects: () => Promise<ProjectSummary[]>;
  selectProjectDirectory: (name?: string) => Promise<ProjectWorkspace | null>;
  openRecentProject: (directory: string) => Promise<ProjectWorkspace>;
  renameProject: (directory: string, name: string) => Promise<ProjectSummary[]>;
  pinProject: (directory: string, pinned: boolean) => Promise<ProjectSummary[]>;
  removeRecentProject: (directory: string) => Promise<ProjectSummary[]>;
  openProjectFolder: (directory: string) => Promise<void>;
  refreshProjectWorkspace: (directory: string) => Promise<ProjectWorkspace>;
  getCodexAccount: () => Promise<CodexAccountState>;
  loginWithChatGPT: () => Promise<CodexAccountState>;
  cancelChatGPTLogin: () => Promise<CodexAccountState>;
  logoutCodex: () => Promise<CodexAccountState>;
  getAiRoles: () => Promise<AiRolesState>;
  setAiRole: (role: AiRole, provider: AiProvider | null, pinned: boolean) => Promise<AiRolesState>;
  onAiRoles: (listener: (state: AiRolesState) => void) => () => void;
  fulfillImageRequests: (directory: string) => Promise<ImageGenState>;
  // Trilha sonora pedida pelo agente quando o aluno liga a música com IA.
  fulfillMusicRequests: (directory: string) => Promise<{ done: number; error?: string }>;
  onImageGenState: (listener: (state: ImageGenState) => void) => () => void;
  applyJcut: (directory: string) => Promise<JcutApplyResult>;
  syncJcut: (directory: string) => Promise<JcutSyncResult>;
  // Animacoes marcadas como "custom" que o agente prometeu escrever no
  // CustomGraphics.tsx e nao escreveu. Devolve os rotulos pendentes.
  pendingCustomAnimations: (directory: string) => Promise<string[]>;
  loginCodexWithApiKey: (apiKey: string) => Promise<CodexAccountState>;
  getClaudeAccount: () => Promise<ClaudeAccountState>;
  loginWithClaude: () => Promise<ClaudeAccountState>;
  connectClaudeApiKey: (apiKey: string) => Promise<ClaudeAccountState>;
  submitClaudeLoginCode: (code: string) => Promise<ClaudeAccountState>;
  cancelClaudeLogin: () => Promise<ClaudeAccountState>;
  logoutClaude: () => Promise<ClaudeAccountState>;
  onClaudeAccount: (listener: (state: ClaudeAccountState) => void) => () => void;
  getGeminiAccount: () => Promise<GeminiAccountState>;
  connectGeminiApiKey: (apiKey: string) => Promise<GeminiAccountState>;
  disconnectGemini: () => Promise<GeminiAccountState>;
  onGeminiAccount: (listener: (state: GeminiAccountState) => void) => () => void;
  // Catalogo de IAs: conectar/desconectar por provedor, filtro de gratuitos e
  // quem esta atendendo cada papel no momento.
  getAiCatalog: () => Promise<CatalogState>;
  connectCatalogProvider: (id: string, fields: Record<string, string>) => Promise<CatalogState>;
  disconnectCatalogProvider: (id: string) => Promise<CatalogState>;
  setCatalogFreeOnly: (freeOnly: boolean) => Promise<CatalogState>;
  // Escolhe (ou limpa) o provedor do catalogo que conduz a conversa.
  setCatalogChatProvider: (id: string | null) => Promise<CatalogState>;
  // Valida a credencial ANTES de salvar, contra a API do provedor.
  testCatalogProvider: (
    id: string,
    fields: Record<string, string>,
  ) => Promise<{ ok: boolean; detail: string }>;
  onAiCatalog: (listener: (state: CatalogState) => void) => () => void;
  onActiveModel: (listener: (state: ActiveModelState) => void) => () => void;
  saveTimelineModel: (
    directory: string,
    model: TimelineModel,
    loadStamp: string,
  ) => Promise<void>;
  ensureRuntimePack: () => Promise<RuntimePackState>;
  onRuntimePackState: (listener: (state: RuntimePackState) => void) => () => void;
  ensureWhisperModel: () => Promise<WhisperModelState>;
  onWhisperModelState: (listener: (state: WhisperModelState) => void) => () => void;
  ensureRemotionRuntime: () => Promise<RemotionRuntimeState>;
  onRemotionRuntimeState: (
    listener: (state: RemotionRuntimeState) => void,
  ) => () => void;
  scaffoldRemotionProject: (directory: string) => Promise<void>;
  getSourceWaveform: (mediaUrl: string) => Promise<SourceWaveform | null>;
  installAppUpdate: () => Promise<void>;
  // Procura atualização sob demanda (o app já checa sozinho no boot).
  checkForUpdates: () => Promise<AppUpdateState>;
  onAppUpdateState: (listener: (state: AppUpdateState) => void) => () => void;
  getMemberAuth: () => Promise<MemberAuthState>;
  memberLogin: (email: string, password: string) => Promise<MemberAuthState>;
  memberLogout: () => Promise<MemberAuthState>;
  onMemberAuthState: (listener: (state: MemberAuthState) => void) => () => void;
  renderPhase2: (directory: string) => Promise<Phase2RenderState>;
  onPhase2RenderState: (listener: (state: Phase2RenderState) => void) => () => void;
  runCleanCut: (directory: string) => Promise<CleanCutState>;
  applyTimelineRanges: (
    directory: string,
    ranges: Array<{ sourceId: string; start: number; end: number; label: string }>,
  ) => Promise<CleanCutState>;
  onCleanCutState: (listener: (state: CleanCutState) => void) => () => void;
  sendCodexMessage: (input: CodexSendMessageInput) => Promise<CodexSendMessageResult>;
  interruptCodexTurn: (threadId: string, turnId: string) => Promise<void>;
  respondToCodexApproval: (
    approvalId: string | number,
    decision: CodexApprovalDecision,
  ) => Promise<void>;
  onCodexEvent: (listener: (event: CodexEvent) => void) => () => void;
};
