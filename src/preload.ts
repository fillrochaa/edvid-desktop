import { contextBridge, ipcRenderer } from 'electron';
import type {
  ActiveModelState,
  AiRolesState,
  AppUpdateState,
  CatalogState,
  ClaudeAccountState,
  CodexEvent,
  EdvidDesktopApi,
  GeminiAccountState,
  ImageGenState,
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
  selectProjectDirectory: (name) => ipcRenderer.invoke('project:select-directory', { name }),
  openRecentProject: (directory) => ipcRenderer.invoke('project:open-recent', { directory }),
  renameProject: (directory, name) => ipcRenderer.invoke('project:rename', { directory, name }),
  pinProject: (directory, pinned) => ipcRenderer.invoke('project:pin', { directory, pinned }),
  removeRecentProject: (directory) => ipcRenderer.invoke('project:remove-recent', { directory }),
  openProjectFolder: (directory) => ipcRenderer.invoke('project:open-folder', { directory }),
  refreshProjectWorkspace: (directory) =>
    ipcRenderer.invoke('project:refresh-workspace', { directory }),
  getCodexAccount: () => ipcRenderer.invoke('codex:account'),
  loginWithChatGPT: () => ipcRenderer.invoke('codex:login'),
  cancelChatGPTLogin: () => ipcRenderer.invoke('codex:login-cancel'),
  logoutCodex: () => ipcRenderer.invoke('codex:logout'),
  getAiRoles: () => ipcRenderer.invoke('ai:roles-get'),
  setAiRole: (role, provider, pinned) => ipcRenderer.invoke('ai:role-set', { role, provider, pinned }),
  onAiRoles: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AiRolesState) => listener(state);
    ipcRenderer.on('ai:roles', handler);
    return () => ipcRenderer.removeListener('ai:roles', handler);
  },
  fulfillImageRequests: (directory) => ipcRenderer.invoke('image:fulfill', { directory }),
  fulfillMusicRequests: (directory) => ipcRenderer.invoke('music:fulfill', { directory }),
  applyJcut: (directory) => ipcRenderer.invoke('jcut:apply', { directory }),
  syncJcut: (directory) => ipcRenderer.invoke('jcut:sync', { directory }),
  pendingCustomAnimations: (directory) => ipcRenderer.invoke('animations:pending-custom', { directory }),
  onImageGenState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ImageGenState) => listener(state);
    ipcRenderer.on('image-gen:state', handler);
    return () => ipcRenderer.removeListener('image-gen:state', handler);
  },
  loginCodexWithApiKey: (apiKey) => ipcRenderer.invoke('codex:login-api-key', { apiKey }),
  getClaudeAccount: () => ipcRenderer.invoke('claude:account'),
  loginWithClaude: () => ipcRenderer.invoke('claude:login'),
  connectClaudeApiKey: (apiKey) => ipcRenderer.invoke('claude:connect-key', { apiKey }),
  submitClaudeLoginCode: (code) => ipcRenderer.invoke('claude:login-code', { code }),
  cancelClaudeLogin: () => ipcRenderer.invoke('claude:login-cancel'),
  logoutClaude: () => ipcRenderer.invoke('claude:logout'),
  onClaudeAccount: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ClaudeAccountState) => listener(state);
    ipcRenderer.on('claude:account', handler);
    return () => ipcRenderer.removeListener('claude:account', handler);
  },
  getGeminiAccount: () => ipcRenderer.invoke('gemini:account'),
  connectGeminiApiKey: (apiKey) => ipcRenderer.invoke('gemini:connect-key', { apiKey }),
  disconnectGemini: () => ipcRenderer.invoke('gemini:disconnect'),
  onGeminiAccount: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: GeminiAccountState) => listener(state);
    ipcRenderer.on('gemini:account', handler);
    return () => ipcRenderer.removeListener('gemini:account', handler);
  },
  getAiCatalog: () => ipcRenderer.invoke('ai-catalog:read'),
  testCatalogProvider: (id, fields) => ipcRenderer.invoke('ai-catalog:test', { id, fields }),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  connectCatalogProvider: (id, fields) => ipcRenderer.invoke('ai-catalog:connect', { id, fields }),
  disconnectCatalogProvider: (id) => ipcRenderer.invoke('ai-catalog:disconnect', { id }),
  setCatalogFreeOnly: (freeOnly) => ipcRenderer.invoke('ai-catalog:free-only', { freeOnly }),
  setCatalogChatProvider: (id) => ipcRenderer.invoke('ai-catalog:chat-provider', { id }),
  onAiCatalog: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: CatalogState) => listener(state);
    ipcRenderer.on('ai-catalog:state', handler);
    return () => ipcRenderer.removeListener('ai-catalog:state', handler);
  },
  onActiveModel: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ActiveModelState) => listener(state);
    ipcRenderer.on('ai-catalog:active-model', handler);
    return () => ipcRenderer.removeListener('ai-catalog:active-model', handler);
  },
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
