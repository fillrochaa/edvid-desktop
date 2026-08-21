import type {
  ActiveModelState,
  AiProvider,
  AiRole,
  AiRolesState,
  CatalogState,
  ClaudeAccountState,
  CodexEvent,
  EdvidDesktopApi,
  GeminiAccountState,
  ProjectSummary,
  ProjectWorkspace,
  RuntimeCheck,
  RuntimeName,
} from './shared';
import { PREVIEW_SOURCE_ID, deriveSegments, modelFromSegments, modelFromSourceFiles } from './timeline-model';

const qaProject: ProjectSummary = {
  directory: '/tmp/edvid-interface-qa',
  name: 'Projeto de interface',
  lastOpenedAt: new Date().toISOString(),
};

// Cenários de corte no QA visual:
// - padrão: corte real respaldado por EDL (gate de aprovação aparece);
// - "?semcorte": clipes seguem no preview — corte FALHOU, gate não aparece;
// - "?cortefake": EDL devolve o vídeo inteiro sem remover nada (o corte
//   inventado quando a transcrição quebra) — gate não pode aparecer;
// - "?espelho": pasta com dois vídeos-fonte antes do corte — timeline mostra
//   os dois em sequência e nenhum gate aparece.
const qaCutScenario = (() => {
  const search = new URLSearchParams(window.location.search);
  if (search.has('semcorte')) return 'semcorte';
  if (search.has('cortefake')) return 'cortefake';
  if (search.has('espelho')) return 'espelho';
  return 'corte';
})();

let qaTimelineModel = modelFromSegments(
  [
    { label: 'HOOK', start: 0, duration: 3.2, audioStart: 0, audioDuration: 3.2 },
    { label: 'PROBLEMA', start: 3.2, duration: 4.1, audioStart: 3.03, audioDuration: 4.27 },
    { label: 'SOLUÇÃO', start: 7.3, duration: 3.4, audioStart: 7.13, audioDuration: 3.57 },
  ],
  30,
);
if (qaTimelineModel && (qaCutScenario === 'corte' || qaCutScenario === 'cortefake')) {
  qaTimelineModel.clips = qaTimelineModel.clips.map((clip) => ({
    ...clip,
    sourceId: 'IMG_0001.MOV',
  }));
}
if (qaCutScenario === 'espelho') {
  qaTimelineModel = modelFromSourceFiles(
    [
      { id: 'IMG_0001.MOV', label: 'IMG_0001.MOV', duration: 16.13 },
      { id: 'IMG_0002.MOV', label: 'IMG_0002.MOV', duration: 12.4 },
    ],
    30,
  );
}

// No cortefake a fonte tem praticamente a duração mantida pelos clipes
// (10,7 s de 10,9 s): nada foi removido, então não há corte para aprovar.
const qaSourceDuration = qaCutScenario === 'cortefake' ? 10.9 : 16.13;

const qaWorkspace: ProjectWorkspace = {
  project: qaProject,
  media: {
    url: 'data:video/mp4;base64,',
    name: qaCutScenario === 'espelho' ? 'IMG_0001.MOV' : 'corte_limpo_qa.mp4',
    width: 1080,
    height: 1920,
    duration: qaCutScenario === 'espelho' ? 16.13 : 10.7,
    fps: 30,
    orientation: 'vertical',
    kind: qaCutScenario === 'espelho' ? 'source' : 'clean-cut',
  },
  timeline: qaTimelineModel ? { segments: deriveSegments(qaTimelineModel) } : null,
  timelineModel: qaTimelineModel,
  timelineModelSynced: true,
  timelineLoadStamp: 'qa',
  sources: [
    {
      id: PREVIEW_SOURCE_ID,
      name: 'corte_limpo_qa.mp4',
      url: 'data:video/mp4;base64,',
      duration: 10.7,
      fps: 30,
      width: 1080,
      height: 1920,
      available: true,
    },
    {
      id: 'IMG_0001.MOV',
      name: 'IMG_0001.MOV',
      url: 'data:video/mp4;base64,',
      duration: qaSourceDuration,
      fps: 30,
      width: 1080,
      height: 1920,
      available: true,
    },
    {
      id: 'IMG_0002.MOV',
      name: 'IMG_0002.MOV',
      url: 'data:video/mp4;base64,',
      duration: 12.4,
      fps: 30,
      width: 1080,
      height: 1920,
      available: true,
    },
  ],
  style: null,
  // Tracks de overlay no QA visual: um exemplar de cada tipo.
  overlays: {
    hookEnd: 3.2,
    images: [{ start: 4.5, end: 9, label: 'produto.png' }],
    videos: [{ start: 1.2, end: 3.4, label: 'broll.mp4' }],
    animations: [{ start: 2, end: 4, label: 'Atrás do sujeito' }],
  },
};
const listeners = new Set<(event: CodexEvent) => void>();
let turnNumber = 0;
let approvalPreviewScheduled = false;

// QA das conexões de IA: ?ia abre o app com nenhuma IA conectada (mostra o
// onboarding); ?ia=manual força o fluxo de colar o código do Claude.
const qaSearch = () => new URLSearchParams(window.location.search);
let qaChatGptConnected = !qaSearch().has('ia') && !qaSearch().has('semchatgpt');
let qaRoles: AiRolesState = { chat: 'chatgpt', image: null, chatPinned: false, imagePinned: false };
const rolesListeners = new Set<(state: AiRolesState) => void>();

function emitRoles(): void {
  for (const listener of rolesListeners) listener(qaRoles);
}
let qaClaude: ClaudeAccountState = { status: 'signed-out', email: null };
const claudeListeners = new Set<(state: ClaudeAccountState) => void>();
// Catálogo de IAs no QA: "?catalogo" abre com o gratuito já conectado.
const qaCatalogConnected = new URLSearchParams(window.location.search).has('catalogo');
const qaSemChatGpt = new URLSearchParams(window.location.search).has('semchatgpt');
let qaCatalog: CatalogState = {
  freeOnly: qaCatalogConnected,
  chatProviderId: qaSemChatGpt ? 'ollama' : null,
  connections: [
    {
      id: 'cloudflare',
      connected: qaCatalogConnected,
      maskedKey: qaCatalogConnected ? '••••7f2a' : null,
      fields: qaCatalogConnected ? { accountId: 'a1b2c3d4e5' } : {},
      cooldownUntil: null,
    },
    { id: 'openrouter', connected: false, maskedKey: null, fields: {}, cooldownUntil: null },
    { id: 'ollama', connected: qaSemChatGpt, maskedKey: qaSemChatGpt ? '••••3c1d' : null, fields: {}, cooldownUntil: null },
  ],
};
const catalogListeners = new Set<(state: CatalogState) => void>();
const qaActiveModel: ActiveModelState = qaCatalogConnected
  ? { role: 'image', providerId: 'cloudflare', providerName: 'Cloudflare Workers AI', modelLabel: 'FLUX.1 Schnell', free: true }
  : null;
const activeModelListeners = new Set<(state: ActiveModelState) => void>();

function emitCatalog(state: CatalogState): void {
  qaCatalog = state;
  for (const listener of catalogListeners) listener(state);
}

let qaGemini: GeminiAccountState = { status: 'signed-out', maskedKey: null };
const geminiListeners = new Set<(state: GeminiAccountState) => void>();

function emitClaude(state: ClaudeAccountState): void {
  qaClaude = state;
  for (const listener of claudeListeners) listener(state);
}

function emitGemini(state: GeminiAccountState): void {
  qaGemini = state;
  for (const listener of geminiListeners) listener(state);
}

const runtimeVersions: Record<RuntimeName, string> = {
  node: '26.7.0',
  npm: '11.19.0',
  ffmpeg: '8.1.2',
  ffprobe: '8.1.2',
  uv: '0.12.3',
  'yt-dlp': '2026.07.04',
  python: '3.12.13',
  whisperx: '3.8.6',
  'codex-app-server': '0.147.0',
};

function emit(event: CodexEvent): void {
  for (const listener of listeners) listener(event);
}

const longQaResponse = Array.from(
  { length: 24 },
  (_, index) => `Trecho ${index + 1}: esta resposta longa valida a rolagem independente do chat sem mover o preview ou a timeline.`,
).join('\n\n');

const cleanCutQaResponse = [
  'O corte limpo está pronto para aprovação:',
  '',
  '- Duração: 10,70 s — original com 16,13 s',
  '- Removidos: silêncios e intervalos sem fala',
  '- Preservados: respirações naturais e finais de palavras',
  '- Arquivo validado, sem erros de áudio ou vídeo',
  '',
  '[Visualizar corte_limpo_v1.mp4]\n(</Users/qa/edicao/corte_limpo/corte_limpo_v1.mp4>)',
  '',
  'Aprova este corte? Depois da aprovação, posso avançar para os estilos.',
].join('\n');

export function createQaBrowserApi(): EdvidDesktopApi {
  return {
    getDesktopInfo: async () => ({
      platform: 'darwin',
      arch: 'arm64',
      appVersion: '0.16.0-qa',
      electronVersion: 'QA',
      embeddedNodeVersion: 'QA',
    }),
    checkRuntimes: async () => Object.entries(runtimeVersions).map(([name, version]) => ({
      name: name as RuntimeName,
      available: true,
      version,
      expectedVersion: version,
      source: 'bundled',
      executablePath: '/qa',
    } satisfies RuntimeCheck)),
    listRecentProjects: async () => [qaProject],
    selectProjectDirectory: async () => qaWorkspace,
    openRecentProject: async () => qaWorkspace,
    renameProject: async (_directory, name) => [{ ...qaProject, name }],
    pinProject: async () => [{ ...qaProject, pinned: true }],
    removeRecentProject: async () => [],
    openProjectFolder: async () => {},
    refreshProjectWorkspace: async () => qaWorkspace,
    getCodexAccount: async () => (qaChatGptConnected
      ? {
          status: 'signed-in',
          account: { type: 'chatgpt', email: 'qa@edvid.local', planType: 'qa' },
          requiresOpenaiAuth: false,
        }
      : { status: 'signed-out', account: null, requiresOpenaiAuth: true }),
    loginWithChatGPT: async () => {
      qaChatGptConnected = true;
      return {
        status: 'signed-in',
        account: { type: 'chatgpt', email: 'qa@edvid.local', planType: 'qa' },
        requiresOpenaiAuth: false,
      };
    },
    cancelChatGPTLogin: async () => ({ status: 'signed-out', account: null, requiresOpenaiAuth: true }),
    logoutCodex: async () => {
      qaChatGptConnected = false;
      return { status: 'signed-out', account: null, requiresOpenaiAuth: true };
    },
    getAiRoles: async () => qaRoles,
    setAiRole: async (role: AiRole, provider: AiProvider | null, pinned: boolean) => {
      if (role === 'chat') {
        if (provider) qaRoles = { ...qaRoles, chat: provider, chatPinned: pinned };
      } else {
        qaRoles = { ...qaRoles, image: provider, imagePinned: provider ? pinned : false };
      }
      emitRoles();
      return qaRoles;
    },
    onAiRoles: (listener) => {
      rolesListeners.add(listener);
      return () => rolesListeners.delete(listener);
    },
    fulfillImageRequests: async () => ({ status: 'idle' }),
    applyJcut: async () => ({ applied: true, cuts: 2, error: null }),
    syncJcut: async () => ({ changed: false }),
    pendingCustomAnimations: async () => [],
    onImageGenState: (listener) => {
      // QA da geracao de imagens: ?imagens simula uma fila de tres pedidos.
      if (qaSearch().has('imagens')) {
        let done = 0;
        const timer = window.setInterval(() => {
          done += 1;
          if (done >= 3) {
            window.clearInterval(timer);
            listener({ status: 'ready', total: 3, done: 3 });
          } else {
            listener({ status: 'generating', total: 3, done });
          }
        }, 900);
      }
      return () => {};
    },
    getClaudeAccount: async () => qaClaude,
    loginWithClaude: async () => {
      const manual = qaSearch().get('ia') === 'manual';
      emitClaude({ status: 'waiting-for-browser', email: null, manual });
      if (!manual) {
        window.setTimeout(() => emitClaude({ status: 'signed-in', email: 'aluno@claude.ai' }), 1600);
      }
      return qaClaude;
    },
    submitClaudeLoginCode: async (code) => {
      if (code.includes('errado')) {
        emitClaude({ status: 'waiting-for-browser', email: null, manual: true, error: 'O Claude recusou o login. Tente de novo.' });
      } else {
        emitClaude({ status: 'signed-in', email: 'aluno@claude.ai' });
      }
      return qaClaude;
    },
    cancelClaudeLogin: async () => {
      emitClaude({ status: 'signed-out', email: null });
      return qaClaude;
    },
    logoutClaude: async () => {
      emitClaude({ status: 'signed-out', email: null });
      return qaClaude;
    },
    onClaudeAccount: (listener) => {
      claudeListeners.add(listener);
      return () => claudeListeners.delete(listener);
    },
    loginCodexWithApiKey: async (apiKey) => {
      if (apiKey.includes('errada')) {
        throw new Error('Chave inválida. Confira na plataforma da OpenAI e cole de novo.');
      }
      qaChatGptConnected = true;
      return {
        status: 'signed-in',
        account: { type: 'apiKey', email: null, planType: null },
        requiresOpenaiAuth: false,
      };
    },
    connectClaudeApiKey: async (apiKey) => {
      if (apiKey.includes('errada')) {
        emitClaude({ ...qaClaude, error: 'Chave inválida. Confira no Console da Anthropic e cole de novo.' });
      } else {
        emitClaude({ status: 'signed-in', email: 'sk-ant-api…f4k3', mode: 'api-key' });
      }
      return qaClaude;
    },
    getGeminiAccount: async () => qaGemini,
    connectGeminiApiKey: async (apiKey) => {
      if (apiKey.includes('errada')) {
        emitGemini({ ...qaGemini, error: 'Chave inválida. Confira no Google AI Studio e cole de novo.' });
      } else {
        emitGemini({ status: 'signed-in', maskedKey: 'AIzaSy…f4k3' });
      }
      return qaGemini;
    },
    disconnectGemini: async () => {
      emitGemini({ status: 'signed-out', maskedKey: null });
      return qaGemini;
    },
    onGeminiAccount: (listener) => {
      geminiListeners.add(listener);
      return () => geminiListeners.delete(listener);
    },
    // Catálogo de IAs no QA visual: "?catalogo" já abre com o Cloudflare
    // conectado, para conferir badges, máscara da chave e o botão de remover.
    getAiCatalog: async () => qaCatalog,
    testCatalogProvider: async (_id, fields) => (
      (fields.apiKey ?? '').trim().length >= 8
        ? { ok: true, detail: 'Chave válida (QA).' }
        : { ok: false, detail: 'Chave curta demais para ser válida.' }
    ),
    checkForUpdates: async () => ({ status: 'idle' }),
    connectCatalogProvider: async (id, fields) => {
      const secret = Object.entries(fields).find(([key]) => key.toLowerCase().includes('key'));
      emitCatalog({
        ...qaCatalog,
        connections: qaCatalog.connections.map((connection) => connection.id === id
          ? {
            ...connection,
            connected: true,
            maskedKey: secret ? `••••${secret[1].slice(-4)}` : '••••',
            fields: Object.fromEntries(Object.entries(fields).filter(([key]) => !key.toLowerCase().includes('key'))),
          }
          : connection),
      });
      return qaCatalog;
    },
    disconnectCatalogProvider: async (id) => {
      emitCatalog({
        ...qaCatalog,
        connections: qaCatalog.connections.map((connection) => connection.id === id
          ? { ...connection, connected: false, maskedKey: null, fields: {} }
          : connection),
      });
      return qaCatalog;
    },
    setCatalogChatProvider: async (id) => {
      emitCatalog({ ...qaCatalog, chatProviderId: id });
      return qaCatalog;
    },
    setCatalogFreeOnly: async (freeOnly) => {
      emitCatalog({ ...qaCatalog, freeOnly });
      return qaCatalog;
    },
    onAiCatalog: (listener) => {
      catalogListeners.add(listener);
      return () => catalogListeners.delete(listener);
    },
    onActiveModel: (listener) => {
      if (qaActiveModel) setTimeout(() => listener(qaActiveModel), 0);
      activeModelListeners.add(listener);
      return () => activeModelListeners.delete(listener);
    },
    saveTimelineModel: async () => {
      // O QA visual não persiste; as edições ficam apenas em memória.
    },
    ensureRuntimePack: async () => (
      new URLSearchParams(window.location.search).has('pack')
        ? { status: 'downloading', downloadedBytes: 0, totalBytes: 780_000_000 }
        : { status: 'ready' }
    ),
    onRuntimePackState: (listener) => {
      // QA do primeiro boot: ?pack simula o download das ferramentas.
      if (new URLSearchParams(window.location.search).has('pack')) {
        let sent = 0;
        const timer = window.setInterval(() => {
          sent += 90_000_000;
          if (sent >= 780_000_000) {
            window.clearInterval(timer);
            listener({ status: 'ready' });
          } else {
            listener({ status: 'downloading', downloadedBytes: sent, totalBytes: 780_000_000 });
          }
        }, 350);
      }
      return () => {};
    },
    // "?modelo=erro" simula a falha de prefetch do modelo (banner com
    // "Tentar de novo"); "?modelo=baixando" simula o download em andamento.
    ensureWhisperModel: async () => {
      const modo = qaSearch().get('modelo');
      if (modo === 'erro') {
        return { status: 'error', model: 'small', error: 'sem conexão com o Hugging Face' };
      }
      if (modo === 'baixando') {
        return { status: 'downloading', model: 'small', downloadedBytes: 213_000_000 };
      }
      return { status: 'ready', model: 'small' };
    },
    onWhisperModelState: () => () => {},
    ensureRemotionRuntime: async () => ({ status: 'ready' }),
    onRemotionRuntimeState: () => () => {},
    scaffoldRemotionProject: async () => {},
    getSourceWaveform: async () => ({
      // Onda sintética para o QA visual: dois ciclos de fala com pausa.
      bucketsPerSecond: 25,
      peaks: Array.from({ length: 268 }, (_, index) => {
        const t = index / 25;
        const speaking = t % 4 < 3;
        return speaking ? 0.25 + 0.6 * Math.abs(Math.sin(index * 0.7)) : 0.05;
      }),
    }),
    renderPhase2: async () => ({ status: 'idle' }),
    onPhase2RenderState: () => () => {},
    installAppUpdate: async () => {},
    onAppUpdateState: (listener) => {
      if (new URLSearchParams(window.location.search).has('update')) {
        window.setTimeout(() => listener({ status: 'ready', version: '9.9.9' }), 400);
      }
      return () => {};
    },
    // QA do gate de aluno: ?aluno mostra o login; senha "errada" falha,
    // e-mail com "sem-acesso" cai na tela de matrícula inativa.
    getMemberAuth: async () => (
      new URLSearchParams(window.location.search).has('aluno')
        ? { status: 'signed-out' }
        : { status: 'signed-in', email: 'aluno@creatorfactory.com.br', name: 'Aluno QA' }
    ),
    memberLogin: async (email, password) => {
      if (password === 'errada') {
        return { status: 'signed-out', error: 'E-mail ou senha incorretos. Use os mesmos dados da área de membros.' };
      }
      if (email.includes('sem-acesso')) return { status: 'no-access', email };
      return { status: 'signed-in', email, name: 'Aluno QA' };
    },
    memberLogout: async () => ({ status: 'signed-out' }),
    onMemberAuthState: () => () => {},
    sendCodexMessage: async ({ text }) => {
      turnNumber += 1;
      const threadId = 'qa-thread';
      const turnId = `qa-turn-${turnNumber}`;
      // "simular limite" reproduz o erro cru de cota (em inglês) que o
      // provedor devolve, para validar a mensagem PT-BR e o fallback.
      if (/simular limite/iu.test(text)) {
        window.setTimeout(() => emit({ type: 'turn-state', threadId, turnId, status: 'started' }), 20);
        window.setTimeout(() => emit({
          type: 'turn-state',
          threadId,
          turnId,
          status: 'failed',
          error: 'RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details.',
        }), 90);
        return { threadId, turnId };
      }
      const response = /inicie a edição|corte limpo/iu.test(text) &&
        !/oficialmente aprovado|j-cut/iu.test(text)
        ? cleanCutQaResponse
        : longQaResponse;
      window.setTimeout(() => emit({ type: 'turn-state', threadId, turnId, status: 'started' }), 20);
      const chunks = response.match(/.{1,120}/gsu) ?? [response];
      chunks.forEach((delta, index) => {
        window.setTimeout(() => emit({ type: 'assistant-delta', threadId, turnId, itemId: `qa-item-${turnNumber}`, delta }), 35 + index * 8);
      });
      window.setTimeout(() => {
        emit({ type: 'assistant-final', threadId, turnId, itemId: `qa-item-${turnNumber}`, text: response });
        emit({ type: 'turn-state', threadId, turnId, status: 'completed' });
      }, 60 + chunks.length * 8);
      return { threadId, turnId };
    },
    interruptCodexTurn: async (threadId, turnId) => {
      emit({ type: 'turn-state', threadId, turnId, status: 'interrupted' });
    },
    respondToCodexApproval: async (approvalId) => {
      emit({ type: 'approval-resolved', approvalId });
    },
    onCodexEvent: (listener) => {
      listeners.add(listener);
      if (!approvalPreviewScheduled && new URLSearchParams(window.location.search).has('approval')) {
        approvalPreviewScheduled = true;
        window.setTimeout(() => emit({
          type: 'approval-requested',
          approval: {
            id: 'qa-approval',
            kind: 'command',
            threadId: 'qa-thread',
            turnId: 'qa-turn-approval',
            title: 'Executar comando',
            detail: "/bin/zsh -lc 'python3 -m venv edicao/fase_2/.venv && edicao/fase_2/.venv/bin/pip install mlx-whisper'",
            cwd: '/Users/fillrocha/Documents/Coding/Edvid/projeto de teste',
          },
        }), 300);
      }
      return () => listeners.delete(listener);
    },
  };
}
