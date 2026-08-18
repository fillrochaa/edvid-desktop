import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppUpdateState,
  CodexEvent,
  EdvidDesktopApi,
  MemberAuthState,
  Phase2RenderState,
  RemotionRuntimeState,
  RuntimePackState,
  WhisperModelState,
} from './shared';

const api: EdvidDesktopApi = {
  getDesktopInfo: () => ipcRenderer.invoke('desktop:get-info'),
  checkRuntimes: () => ipcRenderer.invoke('runtime:check'),
  listRecentProjects: () => ipcRenderer.invoke('project:list'),
  selectProjectDirectory: () => ipcRenderer.invoke('project:select-directory'),
  openRecentProject: (directory) => ipcRenderer.invoke('project:open-recent', { directory }),
  refreshProjectWorkspace: (directory) =>
    ipcRenderer.invoke('project:refresh-workspace', { directory }),
  getCodexAccount: () => ipcRenderer.invoke('codex:account'),
  loginWithChatGPT: () => ipcRenderer.invoke('codex:login'),
  cancelChatGPTLogin: () => ipcRenderer.invoke('codex:login-cancel'),
  logoutCodex: () => ipcRenderer.invoke('codex:logout'),
  saveTimelineModel: (directory, model, loadStamp) =>
    ipcRenderer.invoke('timeline:save', { directory, model, loadStamp }),
  ensureRuntimePack: () => ipcRenderer.invoke('runtime-pack:ensure'),
  onRuntimePackState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: RuntimePackState) => listener(state);
    ipcRenderer.on('runtime-pack:state', handler);
    return () => ipcRenderer.removeListener('runtime-pack:state', handler);
  },
  ensureWhisperModel: () => ipcRenderer.invoke('whisper-model:ensure'),
  onWhisperModelState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WhisperModelState) => listener(state);
    ipcRenderer.on('whisper-model:state', handler);
    return () => ipcRenderer.removeListener('whisper-model:state', handler);
  },
  ensureRemotionRuntime: () => ipcRenderer.invoke('remotion:ensure'),
  onRemotionRuntimeState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: RemotionRuntimeState) =>
      listener(state);
    ipcRenderer.on('remotion:state', handler);
    return () => ipcRenderer.removeListener('remotion:state', handler);
  },
  scaffoldRemotionProject: (directory) =>
    ipcRenderer.invoke('remotion:scaffold', { directory }),
  getSourceWaveform: (mediaUrl) => ipcRenderer.invoke('waveform:get', { url: mediaUrl }),
  installAppUpdate: () => ipcRenderer.invoke('update:install'),
  getMemberAuth: () => ipcRenderer.invoke('member:get'),
  memberLogin: (email, password) => ipcRenderer.invoke('member:login', { email, password }),
  memberLogout: () => ipcRenderer.invoke('member:logout'),
  onMemberAuthState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: MemberAuthState) => listener(state);
    ipcRenderer.on('member:state', handler);
    return () => ipcRenderer.removeListener('member:state', handler);
  },
  onAppUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => listener(state);
    ipcRenderer.on('update:state', handler);
    return () => ipcRenderer.removeListener('update:state', handler);
  },
  renderPhase2: (directory) => ipcRenderer.invoke('phase2:render', { directory }),
  onPhase2RenderState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Phase2RenderState) =>
      listener(state);
    ipcRenderer.on('phase2:state', handler);
    return () => ipcRenderer.removeListener('phase2:state', handler);
  },
  sendCodexMessage: (input) => ipcRenderer.invoke('codex:message', input),
  interruptCodexTurn: (threadId, turnId) =>
    ipcRenderer.invoke('codex:interrupt', { threadId, turnId }),
  respondToCodexApproval: (approvalId, decision) =>
    ipcRenderer.invoke('codex:approval', { approvalId, decision }),
  onCodexEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: CodexEvent) => listener(payload);
    ipcRenderer.on('codex:event', handler);
    return () => ipcRenderer.removeListener('codex:event', handler);
  },
};

contextBridge.exposeInMainWorld('edvidDesktop', api);
