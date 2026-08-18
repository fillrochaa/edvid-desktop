import type {
  AiProvider,
  ClaudeAccountState,
  CodexEvent,
  EdvidDesktopApi,
  ProjectSummary,
  ProjectWorkspace,
  RuntimeCheck,
  RuntimeName,
} from './shared';
import { PREVIEW_SOURCE_ID, deriveSegments, modelFromSegments } from './timeline-model';

const qaProject: ProjectSummary = {
  directory: '/tmp/edvid-interface-qa',
  name: 'Projeto de interface',
  lastOpenedAt: new Date().toISOString(),
};

const qaTimelineModel = modelFromSegments(
  [
    { label: 'HOOK', start: 0, duration: 3.2, audioStart: 0, audioDuration: 3.2 },
    { label: 'PROBLEMA', start: 3.2, duration: 4.1, audioStart: 3.03, audioDuration: 4.27 },
    { label: 'SOLUÇÃO', start: 7.3, duration: 3.4, audioStart: 7.13, audioDuration: 3.57 },
  ],
  30,
);

const qaWorkspace: ProjectWorkspace = {
  project: qaProject,
  media: {
    url: 'data:video/mp4;base64,',
    name: 'corte_limpo_qa.mp4',
    width: 1080,
    height: 1920,
    duration: 10.7,
    fps: 30,
    orientation: 'vertical',
    kind: 'clean-cut',
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
  ],
  style: null,
};
const listeners = new Set<(event: CodexEvent) => void>();
let turnNumber = 0;
let approvalPreviewScheduled = false;

// QA das conexões de IA: ?ia abre o app com nenhuma IA conectada (mostra o
// onboarding); ?ia=manual força o fluxo de colar o código do Claude.
const qaSearch = () => new URLSearchParams(window.location.search);
let qaChatGptConnected = !qaSearch().has('ia');
let qaProvider: AiProvider = 'chatgpt';
let qaClaude: ClaudeAccountState = { status: 'signed-out', email: null };
const claudeListeners = new Set<(state: ClaudeAccountState) => void>();

function emitClaude(state: ClaudeAccountState): void {
  qaClaude = state;
  for (const listener of claudeListeners) listener(state);
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
    getAiProvider: async () => qaProvider,
    setAiProvider: async (provider) => {
      qaProvider = provider;
      return provider;
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
    ensureWhisperModel: async () => ({ status: 'ready', model: 'small' }),
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
