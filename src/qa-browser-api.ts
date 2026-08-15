import type {
  CodexEvent,
  EdvidDesktopApi,
  ProjectSummary,
  ProjectWorkspace,
  RuntimeCheck,
  RuntimeName,
} from './shared';

const qaProject: ProjectSummary = {
  directory: '/tmp/edvid-interface-qa',
  name: 'Projeto de interface',
  lastOpenedAt: new Date().toISOString(),
};

const qaWorkspace: ProjectWorkspace = {
  project: qaProject,
  media: null,
  timeline: {
    segments: [
      { label: 'HOOK', start: 0, duration: 3.2 },
      { label: 'PROBLEMA', start: 3.2, duration: 4.1 },
      { label: 'SOLUÇÃO', start: 7.3, duration: 3.4 },
    ],
  },
  style: null,
};
const listeners = new Set<(event: CodexEvent) => void>();
let turnNumber = 0;

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
    sendCodexMessage: async () => {
      turnNumber += 1;
      const threadId = 'qa-thread';
      const turnId = `qa-turn-${turnNumber}`;
      window.setTimeout(() => emit({ type: 'turn-state', threadId, turnId, status: 'started' }), 20);
      const chunks = longQaResponse.match(/.{1,120}/gsu) ?? [longQaResponse];
      chunks.forEach((delta, index) => {
        window.setTimeout(() => emit({ type: 'assistant-delta', threadId, turnId, itemId: `qa-item-${turnNumber}`, delta }), 35 + index * 8);
      });
      window.setTimeout(() => {
        emit({ type: 'assistant-final', threadId, turnId, itemId: `qa-item-${turnNumber}`, text: longQaResponse });
        emit({ type: 'turn-state', threadId, turnId, status: 'completed' });
      }, 60 + chunks.length * 8);
      return { threadId, turnId };
    },
    interruptCodexTurn: async (threadId, turnId) => {
      emit({ type: 'turn-state', threadId, turnId, status: 'interrupted' });
    },
    respondToCodexApproval: async () => undefined,
    onCodexEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
