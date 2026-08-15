import { contextBridge, ipcRenderer } from 'electron';
import type { CodexEvent, EdvidDesktopApi } from './shared';

const api: EdvidDesktopApi = {
  getDesktopInfo: () => ipcRenderer.invoke('desktop:get-info'),
  checkRuntimes: () => ipcRenderer.invoke('runtime:check'),
  selectProjectDirectory: () => ipcRenderer.invoke('project:select-directory'),
  getCodexAccount: () => ipcRenderer.invoke('codex:account'),
  loginWithChatGPT: () => ipcRenderer.invoke('codex:login'),
  cancelChatGPTLogin: () => ipcRenderer.invoke('codex:login-cancel'),
  logoutCodex: () => ipcRenderer.invoke('codex:logout'),
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
