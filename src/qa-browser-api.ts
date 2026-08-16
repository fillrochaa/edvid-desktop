import type {
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
    refreshProjectWorkspace: async () => qaWorkspace,
    getCodexAccount: async () => ({
      status: 'signed-in',
      account: { type: 'chatgpt', email: 'qa@edvid.local', planType: 'qa' },
      requiresOpenaiAuth: false,
    }),
    loginWithChatGPT: async () => ({
      status: 'signed-in',
      account: { type: 'chatgpt', email: 'qa@edvid.local', planType: 'qa' },
      requiresOpenaiAuth: false,
    }),
    cancelChatGPTLogin: async () => ({ status: 'signed-out', account: null, requiresOpenaiAuth: true }),
    logoutCodex: async () => ({ status: 'signed-out', account: null, requiresOpenaiAuth: true }),
    saveTimelineModel: async () => {
      // O QA visual não persiste; as edições ficam apenas em memória.
    },
    ensureWhisperModel: async () => ({ status: 'ready', model: 'small' }),
    onWhisperModelState: () => () => {},
    sendCodexMessage: async ({ text }) => {
      turnNumber += 1;
      const threadId = 'qa-thread';
      const turnId = `qa-turn-${turnNumber}`;
      const response = /inicie a edição|corte limpo/iu.test(text) && !/oficialmente aprovado/iu.test(text)
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
