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
  electronVersion: string;
  embeddedNodeVersion: string;
};

export type ProjectSummary = {
  directory: string;
  name: string;
  lastOpenedAt: string;
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

export type ProjectWorkspace = {
  project: ProjectSummary;
  media: ProjectMedia | null;
  timeline: ProjectTimeline | null;
  timelineModel: TimelineModel | null;
  timelineModelSynced: boolean;
  timelineLoadStamp: string;
  sources: ProjectSource[];
  style: ProjectStyleState | null;
};

export type WhisperModelState = {
  status: 'unknown' | 'downloading' | 'ready' | 'error';
  model: string;
  downloadedBytes?: number;
  error?: string;
};

export type RemotionRuntimeState = {
  status: 'unknown' | 'installing' | 'ready' | 'error';
  step?: 'dependencias' | 'navegador';
  installedBytes?: number;
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
  selectProjectDirectory: () => Promise<ProjectWorkspace | null>;
  openRecentProject: (directory: string) => Promise<ProjectWorkspace>;
  refreshProjectWorkspace: (directory: string) => Promise<ProjectWorkspace>;
  getCodexAccount: () => Promise<CodexAccountState>;
  loginWithChatGPT: () => Promise<CodexAccountState>;
  cancelChatGPTLogin: () => Promise<CodexAccountState>;
  logoutCodex: () => Promise<CodexAccountState>;
  saveTimelineModel: (
    directory: string,
    model: TimelineModel,
    loadStamp: string,
  ) => Promise<void>;
  ensureWhisperModel: () => Promise<WhisperModelState>;
  onWhisperModelState: (listener: (state: WhisperModelState) => void) => () => void;
  ensureRemotionRuntime: () => Promise<RemotionRuntimeState>;
  onRemotionRuntimeState: (
    listener: (state: RemotionRuntimeState) => void,
  ) => () => void;
  scaffoldRemotionProject: (directory: string) => Promise<void>;
  sendCodexMessage: (input: CodexSendMessageInput) => Promise<CodexSendMessageResult>;
  interruptCodexTurn: (threadId: string, turnId: string) => Promise<void>;
  respondToCodexApproval: (
    approvalId: string | number,
    decision: CodexApprovalDecision,
  ) => Promise<void>;
  onCodexEvent: (listener: (event: CodexEvent) => void) => () => void;
};
