import { app, autoUpdater, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CodexAppServer } from './codex-app-server';
import { mediaKind, mediaMimeType, mediaTier, pickPreviewMedia, resolveByteRange } from './media-selection';
import { resolveRuntime, type RuntimeResolution } from './runtime';
import type {
  AppUpdateState,
  CodexApprovalDecision,
  CodexEvent,
  CodexSendMessageInput,
  MemberAuthState,
  Phase2RenderState,
  ProjectMedia,
  SourceWaveform,
  ProjectSource,
  ProjectSummary,
  ProjectStyleState,
  ProjectTimeline,
  ProjectWorkspace,
  RemotionRuntimeState,
  RuntimeCheck,
  RuntimeName,
  TimelineModel,
  WhisperModelState,
} from './shared';
import {
  PREVIEW_SOURCE_ID,
  asText,
  deriveSegments,
  migrateEdlToModel,
  modelFromSegments,
  modelsEqual,
  sanitizeTimelineModel,
  type EdlDocument,
} from './timeline-model';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'edvid-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

if (started) {
  app.quit();
}

const runtimeCommands: Array<{
  name: RuntimeName;
  args: string[];
}> = [
  { name: 'node', args: ['--version'] },
  { name: 'npm', args: ['--version'] },
  { name: 'ffmpeg', args: ['-version'] },
  { name: 'ffprobe', args: ['-version'] },
  { name: 'uv', args: ['--version'] },
  { name: 'yt-dlp', args: ['--version'] },
  { name: 'python', args: ['--version'] },
  {
    name: 'whisperx',
    args: [
      '-c',
      "from importlib.metadata import version; print(version('whisperx'))",
    ],
  },
  { name: 'codex-app-server', args: ['--version'] },
];

let codexAppServer: CodexAppServer | null = null;
const selectedProjectDirectories = new Set<string>();
const authorizedMedia = new Map<string, string>();
const mediaTokenByFile = new Map<string, string>();

// Token estável por arquivo+versão: recargas do mesmo arquivo reutilizam a
// URL, o que evita remontar o <video> e resetar o editor a cada turno.
function authorizeMediaToken(absolutePath: string, fingerprint: string | null): string {
  const key = `${absolutePath}:${fingerprint ?? 'sem-fingerprint'}`;
  let token = mediaTokenByFile.get(key);
  if (!token) {
    token = randomUUID();
    mediaTokenByFile.set(key, token);
    authorizedMedia.set(token, absolutePath);
  }
  return token;
}
const videoExtensions = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv']);
const ignoredMediaDirectories = new Set([
  '.git',
  '.runtime-cache',
  '.venv',
  'node_modules',
  'out',
]);

type MediaCandidate = {
  absolutePath: string;
  relativePath: string;
  modifiedAt: number;
  tier: number;
};


type InspectedProjectMedia = {
  media: ProjectMedia;
  absolutePath: string;
};

const inferredTimelineCache = new Map<string, Promise<ProjectTimeline | null>>();

type FfprobeOutput = {
  format?: { duration?: string };
  streams?: Array<{
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    tags?: { rotate?: string };
    side_data_list?: Array<{ rotation?: number }>;
  }>;
};

function parseFrameRate(value?: string): number {
  if (!value) return 30;
  const [numerator, denominator = '1'] = value.split('/');
  const fps = Number(numerator) / Number(denominator);
  return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function projectsFile(): string {
  return path.join(app.getPath('userData'), 'projects.json');
}

// Caches gravaveis dos runtimes internos. Ficam nos dados do aplicativo (a
// politica "download-on-demand-to-app-data" do manifesto) e sao declarados
// como writable_roots do sandbox, para que transcrever nao precise de
// permissao do usuario nem escreva fora do bundle assinado.
function cachePaths() {
  const root = path.join(app.getPath('userData'), 'cache');
  return {
    root,
    huggingface: path.join(root, 'huggingface'),
    torch: path.join(root, 'torch'),
    matplotlib: path.join(root, 'matplotlib'),
    xdg: path.join(root, 'xdg'),
  };
}

async function prepareCacheDirectories(): Promise<void> {
  const paths = cachePaths();
  await Promise.all(
    [paths.huggingface, paths.torch, paths.matplotlib, paths.xdg].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
}

function qaProject(): ProjectSummary | null {
  const directory = process.env.EDVID_QA_PROJECT_PATH?.trim();
  if (!directory) return null;
  const resolvedDirectory = path.resolve(directory);
  return {
    directory: resolvedDirectory,
    name: path.basename(resolvedDirectory),
    lastOpenedAt: new Date().toISOString(),
  };
}

async function readRecentProjects(): Promise<ProjectSummary[]> {
  try {
    const parsed = JSON.parse(await readFile(projectsFile(), 'utf8')) as {
      projects?: unknown;
    };
    if (!Array.isArray(parsed.projects)) return [];
    return parsed.projects
      .filter((project): project is ProjectSummary => {
        if (!project || typeof project !== 'object') return false;
        const item = project as Partial<ProjectSummary>;
        return (
          typeof item.directory === 'string' &&
          typeof item.name === 'string' &&
          typeof item.lastOpenedAt === 'string'
        );
      })
      .slice(0, 16);
  } catch {
    return [];
  }
}

async function rememberProject(directory: string): Promise<ProjectSummary> {
  const resolvedDirectory = path.resolve(directory);
  const project: ProjectSummary = {
    directory: resolvedDirectory,
    name: path.basename(resolvedDirectory),
    lastOpenedAt: new Date().toISOString(),
  };
  const current = await readRecentProjects();
  const projects = [
    project,
    ...current.filter((item) => path.resolve(item.directory) !== resolvedDirectory),
  ].slice(0, 16);
  await mkdir(path.dirname(projectsFile()), { recursive: true });
  await writeFile(projectsFile(), `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
  selectedProjectDirectories.add(resolvedDirectory);
  return project;
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}


async function collectMedia(
  root: string,
  current: string,
  depth: number,
  candidates: MediaCandidate[],
): Promise<void> {
  if (depth > 5 || candidates.length >= 800) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (candidates.length >= 800 || entry.isSymbolicLink()) return;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredMediaDirectories.has(entry.name) && !entry.name.startsWith('.')) {
          await collectMedia(root, absolutePath, depth + 1, candidates);
        }
        return;
      }
      if (!entry.isFile() || !videoExtensions.has(path.extname(entry.name).toLowerCase())) {
        return;
      }
      const fileStat = await stat(absolutePath);
      const relativePath = path.relative(root, absolutePath);
      candidates.push({
        absolutePath,
        relativePath,
        modifiedAt: fileStat.mtimeMs,
        tier: mediaTier(relativePath),
      });
    }),
  );
}

function inspectVideo(executable: string, argsPrefix: string[], filePath: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        ...argsPrefix,
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'format=duration:stream=width,height,avg_frame_rate,r_frame_rate:stream_tags=rotate:stream_side_data=rotation',
        '-of',
        'json',
        filePath,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Tempo esgotado ao analisar o video do projeto.'));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || 'O FFprobe nao conseguiu analisar o video.'));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as FfprobeOutput);
      } catch {
        reject(new Error('O FFprobe retornou dados invalidos para o video.'));
      }
    });
  });
}

async function inspectProjectMedia(directory: string): Promise<InspectedProjectMedia | null> {
  const candidates: MediaCandidate[] = [];
  await collectMedia(directory, directory, 0, candidates);
  const candidate = pickPreviewMedia(candidates);
  if (!candidate) return null;

  const ffprobe = resolveRuntime('ffprobe', {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  if (!ffprobe.command) return null;
  const probe = await inspectVideo(ffprobe.command, ffprobe.argsPrefix, candidate.absolutePath);
  const stream = probe.streams?.[0];
  if (!stream?.width || !stream.height) return null;
  const rotation = Math.abs(
    Number(stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation)
      || Number(stream.tags?.rotate)
      || 0,
  );
  const rotated = rotation % 180 === 90;
  const width = rotated ? stream.height : stream.width;
  const height = rotated ? stream.width : stream.height;
  const kind = mediaKind(candidate.relativePath, candidate.tier);
  const token = authorizeMediaToken(candidate.absolutePath, `${candidate.modifiedAt}`);
  return {
    absolutePath: candidate.absolutePath,
    media: {
      url: `edvid-media://local/${token}`,
      name: path.basename(candidate.absolutePath),
      width,
      height,
      duration: Number(probe.format?.duration) || 0,
      fps: parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate),
      orientation: height > width ? 'vertical' : 'horizontal',
      kind,
    },
  };
}

function detectSceneBoundaries(filePath: string, duration: number): Promise<ProjectTimeline | null> {
  const ffmpeg = resolveRuntime('ffmpeg', {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  if (!ffmpeg.command || duration <= 0 || duration > 900) return Promise.resolve(null);

  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg.command as string,
      [
        ...ffmpeg.argsPrefix,
        '-hide_banner',
        '-i',
        filePath,
        '-filter:v',
        "scale=320:-2,select='gt(scene,0.05)',metadata=print:key=lavfi.scene_score",
        '-an',
        '-f',
        'null',
        '-',
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 2_000_000) stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const detected: number[] = [];
      for (const match of stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/gu)) {
        const time = Number(match[1]);
        const previous = detected.at(-1) ?? -1;
        if (time > 0.2 && time < duration - 0.2 && time - previous >= 0.25) {
          detected.push(time);
        }
      }
      if (detected.length === 0) {
        resolve(null);
        return;
      }
      const boundaries = [0, ...detected, duration];
      resolve({
        segments: boundaries.slice(0, -1).map((start, index) => ({
          label: `Cena ${String(index + 1).padStart(2, '0')}`,
          start,
          duration: boundaries[index + 1] - start,
          audioStart: start,
          audioDuration: boundaries[index + 1] - start,
        })),
      });
    });
  });
}

async function inferProjectTimeline(
  inspectedMedia: InspectedProjectMedia | null,
): Promise<ProjectTimeline | null> {
  if (!inspectedMedia || inspectedMedia.media.kind === 'source') return null;
  try {
    const fileStat = await stat(inspectedMedia.absolutePath);
    const cacheKey = `${inspectedMedia.absolutePath}:${fileStat.size}:${fileStat.mtimeMs}`;
    let pending = inferredTimelineCache.get(cacheKey);
    if (!pending) {
      pending = detectSceneBoundaries(
        inspectedMedia.absolutePath,
        inspectedMedia.media.duration,
      );
      inferredTimelineCache.set(cacheKey, pending);
    }
    return await pending;
  } catch {
    return null;
  }
}

type EdlFileInfo = {
  path: string;
  document: EdlDocument;
  fingerprint: string;
};

type StoredTimelineFile = {
  path: string;
  edlFingerprint: string | null;
  mediaFingerprint: string | null;
  model: TimelineModel;
};

type ProjectTimelineMeta = {
  timelinePath: string;
  edlFingerprint: string | null;
  mediaFingerprint: string | null;
};

const projectTimelineMeta = new Map<string, ProjectTimelineMeta>();
const sourceProbeCache = new Map<string, Promise<FfprobeOutput | null>>();

async function fingerprintOf(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath);
    return `${fileStat.size}:${Math.round(fileStat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function edlCandidatePaths(directory: string): string[] {
  return [
    path.join(directory, 'edit', 'edl.json'),
    path.join(directory, 'edit', 'corte_limpo', 'edl.json'),
    path.join(directory, 'edicao', 'edl.json'),
    path.join(directory, 'edicao', 'corte_limpo', 'edl.json'),
    path.join(directory, 'edl.json'),
  ];
}

async function readEdlDocument(directory: string): Promise<EdlFileInfo | null> {
  for (const candidatePath of edlCandidatePaths(directory)) {
    try {
      const document = JSON.parse(await readFile(candidatePath, 'utf8')) as EdlDocument;
      const fingerprint = await fingerprintOf(candidatePath);
      if (!document || typeof document !== 'object' || !fingerprint) continue;
      return { path: candidatePath, document, fingerprint };
    } catch {
      // Tenta a proxima localizacao conhecida do EDL.
    }
  }
  return null;
}

async function readStoredTimeline(candidatePaths: string[]): Promise<StoredTimelineFile | null> {
  for (const candidatePath of candidatePaths) {
    try {
      const parsed = JSON.parse(await readFile(candidatePath, 'utf8')) as {
        version?: number;
        edlFingerprint?: unknown;
        mediaFingerprint?: unknown;
        model?: unknown;
      };
      if (parsed.version !== 1) continue;
      const model = sanitizeTimelineModel(parsed.model);
      if (!model) continue;
      return {
        path: candidatePath,
        edlFingerprint: typeof parsed.edlFingerprint === 'string' ? parsed.edlFingerprint : null,
        mediaFingerprint:
          typeof parsed.mediaFingerprint === 'string' ? parsed.mediaFingerprint : null,
        model,
      };
    } catch {
      // Tenta a proxima localizacao conhecida do modelo salvo.
    }
  }
  return null;
}

function segmentsFromJcut(edl: EdlDocument | null): ProjectTimeline['segments'] | null {
  const jcut = Array.isArray(edl?.jcut_timeline) ? edl.jcut_timeline : [];
  if (jcut.length === 0) return null;
  const segments = jcut
    .map((segment, index) => ({
      label: asText(segment.beat) || `Take ${String(index + 1).padStart(2, '0')}`,
      start: Number(segment.video_start_in_output),
      duration: Number(segment.video_duration),
      audioStart: Number(segment.audio_start_in_output),
      audioDuration: Number(segment.audio_duration),
    }))
    .filter((segment) => Number.isFinite(segment.start) && segment.duration > 0)
    .map((segment) => ({
      ...segment,
      audioStart: Number.isFinite(segment.audioStart) ? segment.audioStart : segment.start,
      audioDuration: Number.isFinite(segment.audioDuration) && segment.audioDuration > 0
        ? segment.audioDuration
        : segment.duration,
    }));
  return segments.length > 0 ? segments : null;
}

async function probeSourceFile(absolutePath: string): Promise<FfprobeOutput | null> {
  const fingerprint = await fingerprintOf(absolutePath);
  if (!fingerprint) return null;
  const cacheKey = `${absolutePath}:${fingerprint}`;
  let pending = sourceProbeCache.get(cacheKey);
  if (!pending) {
    const ffprobe = resolveRuntime('ffprobe', {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    });
    pending = ffprobe.command
      ? inspectVideo(ffprobe.command, ffprobe.argsPrefix, absolutePath).catch(() => null)
      : Promise.resolve(null);
    sourceProbeCache.set(cacheKey, pending);
    // Falhas do FFprobe podem ser transitórias; não ficam no cache.
    void pending.then((result) => {
      if (!result) sourceProbeCache.delete(cacheKey);
    });
  }
  return pending;
}

async function buildProjectSources(
  directory: string,
  model: TimelineModel,
  edl: EdlFileInfo | null,
  inspectedMedia: InspectedProjectMedia | null,
): Promise<ProjectSource[]> {
  const referencedIds = [...new Set(model.clips.map((clip) => clip.sourceId))];
  const edlSources = edl?.document.sources ?? {};
  const sources: ProjectSource[] = [];
  for (const sourceId of referencedIds) {
    const usedDuration = model.clips
      .filter((clip) => clip.sourceId === sourceId)
      .reduce((maximum, clip) => Math.max(maximum, clip.sourceOut), 0);
    if (sourceId === PREVIEW_SOURCE_ID && inspectedMedia) {
      sources.push({
        id: sourceId,
        name: inspectedMedia.media.name,
        url: inspectedMedia.media.url,
        duration: inspectedMedia.media.duration || usedDuration,
        fps: inspectedMedia.media.fps,
        width: inspectedMedia.media.width,
        height: inspectedMedia.media.height,
        available: true,
      });
      continue;
    }
    // O id pode ser uma chave do mapa "sources" ou o proprio nome do arquivo,
    // quando o EDL usa a forma abreviada "source": "IMG_6164.MOV".
    const mappedPath = asText(edlSources[sourceId]) || asText(sourceId);
    const absolutePath = mappedPath
      ? path.isAbsolute(mappedPath)
        ? path.resolve(mappedPath)
        : path.resolve(directory, mappedPath)
      : null;
    // Só arquivos de vídeo dentro da pasta do projeto ganham token de mídia.
    const relativeToProject = absolutePath ? path.relative(directory, absolutePath) : null;
    const isContained = Boolean(
      relativeToProject !== null &&
      relativeToProject !== '' &&
      !relativeToProject.startsWith('..') &&
      !path.isAbsolute(relativeToProject) &&
      absolutePath &&
      videoExtensions.has(path.extname(absolutePath).toLowerCase()),
    );
    let probe: FfprobeOutput | null = null;
    let isFile = false;
    if (absolutePath && isContained) {
      try {
        isFile = (await stat(absolutePath)).isFile();
      } catch {
        isFile = false;
      }
      if (isFile) probe = await probeSourceFile(absolutePath);
    }
    const stream = probe?.streams?.[0];
    if (absolutePath && isFile && stream?.width && stream.height) {
      const token = authorizeMediaToken(absolutePath, await fingerprintOf(absolutePath));
      sources.push({
        id: sourceId,
        name: path.basename(absolutePath),
        url: `edvid-media://local/${token}`,
        duration: Number(probe?.format?.duration) || usedDuration,
        fps: parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate),
        width: stream.width,
        height: stream.height,
        available: true,
      });
      continue;
    }
    sources.push({
      id: sourceId,
      name: absolutePath ? path.basename(absolutePath) : sourceId,
      url: null,
      // Sem o arquivo, o limite de trim é o trecho já usado pelos clipes.
      duration: usedDuration,
      fps: model.fps,
      width: 0,
      height: 0,
      available: false,
    });
  }
  return sources;
}

type LoadedTimeline = {
  model: TimelineModel | null;
  synced: boolean;
  sources: ProjectSource[];
  timeline: ProjectTimeline | null;
  loadStamp: string;
};

function timelineLoadStampOf(meta: ProjectTimelineMeta | undefined): string {
  return `${meta?.edlFingerprint ?? 'sem-edl'}|${meta?.mediaFingerprint ?? 'sem-midia'}`;
}

async function loadProjectTimeline(
  directory: string,
  inspectedMedia: InspectedProjectMedia | null,
): Promise<LoadedTimeline> {
  const edl = await readEdlDocument(directory);
  const mediaFingerprint = inspectedMedia
    ? await fingerprintOf(inspectedMedia.absolutePath)
    : null;
  const fps = inspectedMedia?.media.fps ?? 30;

  // O modelo derivado do estado atual do projeto (EDL, jcut, detecção visual
  // ou clipe único). É a referência de "sincronizado com o render".
  let derived = edl ? migrateEdlToModel(edl.document, fps) : null;
  if (!derived) {
    const jcutSegments = segmentsFromJcut(edl?.document ?? null);
    const segments = jcutSegments
      ?? (await inferProjectTimeline(inspectedMedia))?.segments
      ?? null;
    if (segments) {
      derived = modelFromSegments(segments, fps);
    } else if (inspectedMedia && inspectedMedia.media.duration > 0.1) {
      derived = modelFromSegments(
        [{ label: inspectedMedia.media.name, start: 0, duration: inspectedMedia.media.duration }],
        fps,
      );
    }
  }

  const storedCandidates = [
    ...(edl ? [path.join(path.dirname(edl.path), 'timeline.json')] : []),
    path.join(directory, 'edit', 'timeline.json'),
    path.join(directory, 'edicao', 'timeline.json'),
  ];
  const stored = await readStoredTimeline([...new Set(storedCandidates)]);
  const storedIsCurrent =
    stored !== null &&
    stored.edlFingerprint === (edl?.fingerprint ?? null) &&
    stored.mediaFingerprint === mediaFingerprint;

  const model = storedIsCurrent ? stored.model : derived;
  const synced = storedIsCurrent ? modelsEqual(stored.model, derived) : true;
  const timelinePath = storedIsCurrent && stored
    ? stored.path
    : edl
      ? path.join(path.dirname(edl.path), 'timeline.json')
      : path.join(directory, 'edit', 'timeline.json');
  const meta: ProjectTimelineMeta = {
    timelinePath,
    edlFingerprint: edl?.fingerprint ?? null,
    mediaFingerprint,
  };
  projectTimelineMeta.set(directory, meta);
  const loadStamp = timelineLoadStampOf(meta);

  if (!model) return { model: null, synced: true, sources: [], timeline: null, loadStamp };
  const sources = await buildProjectSources(directory, model, edl, inspectedMedia);
  return { model, synced, sources, timeline: { segments: deriveSegments(model) }, loadStamp };
}

type BriefingFile = {
  editing_type?: string;
  headline?: string;
  captions?: string;
  accent_color?: string;
  elements_included?: unknown;
  elements_excluded?: unknown;
  notes?: unknown;
};

// O agente grava o briefing da Fase 2 em briefing.json com nomes proprios.
// Converter aqui evita que a interface perca as escolhas ja aplicadas.
function styleFromBriefing(briefing: BriefingFile): Partial<ProjectStyleState> | null {
  if (!briefing.editing_type && !briefing.headline && !briefing.captions) return null;
  const included = new Set(
    (Array.isArray(briefing.elements_included) ? briefing.elements_included : [])
      .filter((item): item is string => typeof item === 'string'),
  );
  return {
    edit: briefing.editing_type as ProjectStyleState['edit'],
    headline: briefing.headline as ProjectStyleState['headline'],
    captions: briefing.captions as ProjectStyleState['captions'],
    accent: briefing.accent_color,
    elements: {
      tracking: included.has('tracking'),
      zoomAuto: included.has('zoomAuto'),
      zoomCuts: included.has('zoomCuts'),
      flashCut: included.has('flashCut'),
      musicAI: included.has('musicAI'),
    },
    note: typeof briefing.notes === 'string' ? briefing.notes : '',
  };
}

async function inspectProjectStyle(directory: string): Promise<ProjectStyleState | null> {
  const candidatePaths = [
    path.join(directory, 'edit', 'state.json'),
    path.join(directory, 'edicao', 'state.json'),
    path.join(directory, 'state.json'),
    path.join(directory, 'edit', 'fase_2', 'briefing.json'),
    path.join(directory, 'edicao', 'fase_2', 'briefing.json'),
  ];
  const validEdits = new Set(['limpa', 'split', 'split2']);
  const validHeadlines = new Set(['outline', 'card', 'realce', 'misto', 'none']);
  const validCaptions = new Set([
    'karaoke', 'stacked', 'scatter', 'simples', 'serifada', 'classica', 'none',
  ]);
  for (const candidatePath of candidatePaths) {
    try {
      const state = JSON.parse(await readFile(candidatePath, 'utf8')) as {
        style?: Partial<ProjectStyleState>;
      } & BriefingFile;
      const style = state.style ?? styleFromBriefing(state) ?? undefined;
      if (
        !style ||
        !validEdits.has(String(style.edit)) ||
        !validHeadlines.has(String(style.headline)) ||
        !validCaptions.has(String(style.captions))
      ) {
        continue;
      }
      const elements = style.elements ?? {} as ProjectStyleState['elements'];
      return {
        edit: style.edit as ProjectStyleState['edit'],
        headline: style.headline as ProjectStyleState['headline'],
        captions: style.captions as ProjectStyleState['captions'],
        accent: /^#[0-9a-f]{6}$/iu.test(style.accent ?? '') ? style.accent as string : '#ff5200',
        elements: {
          tracking: Boolean(elements.tracking),
          zoomAuto: Boolean(elements.zoomAuto),
          zoomCuts: Boolean(elements.zoomCuts),
          flashCut: Boolean(elements.flashCut),
          musicAI: Boolean(elements.musicAI),
        },
        note: typeof style.note === 'string' ? style.note : '',
      };
    } catch {
      // Tenta a proxima localizacao conhecida do estado do projeto.
    }
  }
  return null;
}

async function openProject(directory: string, remember = true): Promise<ProjectWorkspace> {
  const resolvedDirectory = path.resolve(directory);
  if (!(await isDirectory(resolvedDirectory))) {
    throw new Error('A pasta deste projeto nao esta mais disponivel.');
  }
  const project = remember
    ? await rememberProject(resolvedDirectory)
    : {
        directory: resolvedDirectory,
        name: path.basename(resolvedDirectory),
        lastOpenedAt: new Date().toISOString(),
      };
  selectedProjectDirectories.add(resolvedDirectory);
  const inspectedMedia = await inspectProjectMedia(resolvedDirectory);
  const [loaded, style] = await Promise.all([
    loadProjectTimeline(resolvedDirectory, inspectedMedia),
    inspectProjectStyle(resolvedDirectory),
  ]);
  return {
    project,
    media: inspectedMedia?.media ?? null,
    timeline: loaded.timeline,
    timelineModel: loaded.model,
    timelineModelSynced: loaded.synced,
    timelineLoadStamp: loaded.loadStamp,
    sources: loaded.sources,
    style,
  };
}

function broadcastCodexEvent(event: CodexEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('codex:event', event);
  }
}

// --- Modelo de transcricao -------------------------------------------------
// O aplicativo baixa o modelo do WhisperX no processo principal, com rede
// normal e progresso visivel. O agente roda sempre offline sobre esse cache,
// o que elimina o pedido de permissao a cada transcricao.

const WHISPERX_MODEL_NAME = 'small';
const WHISPERX_MODEL_REPO = 'Systran/faster-whisper-small';

let modelPrefetch: Promise<WhisperModelState> | null = null;
let modelState: WhisperModelState = { status: 'unknown', model: WHISPERX_MODEL_NAME };

function broadcastModelState(state: WhisperModelState): void {
  modelState = state;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('whisper-model:state', state);
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else if (entry.isFile()) {
      try {
        total += (await stat(entryPath)).size;
      } catch {
        // Arquivo removido durante a varredura; ignora.
      }
    }
  }
  return total;
}

function runModelDownload(python: string, hubCache: string): Promise<void> {
  const script = [
    'from huggingface_hub import snapshot_download',
    `snapshot_download(${JSON.stringify(WHISPERX_MODEL_REPO)})`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_HOME: path.dirname(hubCache),
        HUGGINGFACE_HUB_CACHE: hubCache,
        HF_HUB_DISABLE_TELEMETRY: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
      },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || 'Falha ao baixar o modelo.'));
    });
  });
}

// --- Ondas sonoras da timeline ---------------------------------------------
// Picos de amplitude por fonte, calculados uma vez com o FFmpeg empacotado e
// guardados em cache por caminho+mtime. A interface pede pela URL de midia ja
// autorizada (edvid-media://), entao nao ha resolucao de caminho nova aqui.

const WAVEFORM_BUCKETS_PER_SECOND = 25;
const WAVEFORM_SAMPLE_RATE = 8000;
const waveformJobs = new Map<string, Promise<SourceWaveform | null>>();

function waveformCacheDirectory(): string {
  return path.join(app.getPath('userData'), 'cache', 'waveforms');
}

function extractWaveformPeaks(mediaPath: string): Promise<number[] | null> {
  const ffmpeg = resolveRuntime('ffmpeg', {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  if (!ffmpeg.command) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg.command as string,
      [
        ...ffmpeg.argsPrefix,
        '-v', 'error',
        '-i', mediaPath,
        '-map', 'a:0',
        '-ac', '1',
        '-ar', String(WAVEFORM_SAMPLE_RATE),
        '-f', 's16le',
        '-',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const samplesPerBucket = Math.round(WAVEFORM_SAMPLE_RATE / WAVEFORM_BUCKETS_PER_SECOND);
    const peaks: number[] = [];
    let bucketPeak = 0;
    let bucketCount = 0;
    let leftover: Buffer | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      const data = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = data.length - (data.length % 2);
      for (let offset = 0; offset < usable; offset += 2) {
        const amplitude = Math.abs(data.readInt16LE(offset)) / 32768;
        if (amplitude > bucketPeak) bucketPeak = amplitude;
        bucketCount += 1;
        if (bucketCount === samplesPerBucket) {
          peaks.push(Math.round(bucketPeak * 1000) / 1000);
          bucketPeak = 0;
          bucketCount = 0;
        }
      }
      leftover = usable < data.length ? data.subarray(usable) : null;
      // Backstop para midias absurdamente longas: ~11 h ja passam de qualquer
      // timeline real e o JSON continuaria pequeno, mas nao crescemos alem.
      if (peaks.length > 1_000_000) child.kill();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (bucketCount > 0) peaks.push(Math.round(bucketPeak * 1000) / 1000);
      resolve(code === 0 && peaks.length > 0 ? peaks : null);
    });
  });
}

async function readSourceWaveform(mediaUrl: string): Promise<SourceWaveform | null> {
  let token = '';
  try {
    const url = new URL(mediaUrl);
    if (url.protocol !== 'edvid-media:' || url.hostname !== 'local') return null;
    token = url.pathname.slice(1);
  } catch {
    return null;
  }
  const mediaPath = authorizedMedia.get(token);
  if (!mediaPath) return null;
  let fingerprint: string | null = null;
  try {
    fingerprint = await fingerprintOf(mediaPath);
  } catch {
    return null;
  }
  if (!fingerprint) return null;
  const cacheKey = createHash('sha1').update(`${mediaPath}:${fingerprint}`).digest('hex');
  const pending = waveformJobs.get(cacheKey);
  if (pending) return pending;
  const job = (async (): Promise<SourceWaveform | null> => {
    const cacheFile = path.join(waveformCacheDirectory(), `${cacheKey}.json`);
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as SourceWaveform;
      if (Array.isArray(cached.peaks) && cached.peaks.length > 0) return cached;
    } catch {
      // Sem cache: calcula agora.
    }
    const peaks = await extractWaveformPeaks(mediaPath);
    if (!peaks) return null;
    const waveform: SourceWaveform = {
      bucketsPerSecond: WAVEFORM_BUCKETS_PER_SECOND,
      peaks,
    };
    try {
      await mkdir(waveformCacheDirectory(), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(waveform));
    } catch {
      // Cache e conveniencia; sem ele o proximo pedido recalcula.
    }
    return waveform;
  })();
  waveformJobs.set(cacheKey, job);
  return job;
}

// --- Motor de render da Fase 2 ---------------------------------------------
// O Remotion nao cabe no instalador (node_modules + Chrome passam de 700 MB
// por plataforma), entao o aplicativo instala uma vez em userData e todos os
// projetos compartilham. O agente nunca roda npm install.

function remotionRuntimeDirectory(): string {
  return path.join(app.getPath('userData'), 'runtime', 'remotion');
}

function bundledResourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
}

function remotionTemplateDirectory(): string {
  return path.join(bundledResourcesRoot(), 'remotion-template');
}

function helpersDirectory(): string {
  return path.join(bundledResourcesRoot(), 'helpers');
}

// As familias que o template usa. O @remotion/google-fonts nao embarca os
// arquivos: ele aponta para fonts.gstatic.com e baixa durante o render, o que
// nao funciona no sandbox sem rede. O aplicativo baixa uma vez aqui e o
// template carrega de public/fonts.
const REMOTION_FONTS = [
  { family: 'Poppins', axis: 'ital,wght@0,400;0,600;0,700;0,800;0,900;1,700;1,900' },
  { family: 'Playfair Display', axis: 'ital,wght@0,700;0,900;1,700;1,900' },
  { family: 'Lora', axis: 'ital,wght@0,400;0,600;1,400;1,600' },
  { family: 'Libre Baskerville', axis: 'wght@700' },
  { family: 'Inter', axis: 'wght@500' },
];
// Um Chrome recente na requisicao garante woff2; sem isso o Google devolve ttf.
const FONT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Marca de versao do fonts.css. A v2 embute os woff2 como data URIs: durante
// o render, o servidor estatico do Remotion tambem atende a extracao de
// frames do OffthreadVideo, e uma requisicao de fonte que entra nessa fila
// pode nunca ser atendida — o delayRender das fontes estoura e derruba o
// render inteiro depois de minutos. Com data URI nao existe requisicao.
const FONTS_CSS_VERSION = 'Edvid fonts v2 (woff2 embutido)';

async function downloadRemotionFonts(fontsDirectory: string): Promise<void> {
  await mkdir(fontsDirectory, { recursive: true });
  const blocks: string[] = [];
  for (const font of REMOTION_FONTS) {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      font.family,
    ).replace(/%20/g, '+')}:${font.axis}&display=block`;
    const response = await net.fetch(url, { headers: { 'User-Agent': FONT_USER_AGENT } });
    if (!response.ok) throw new Error(`Falha ao consultar a fonte ${font.family}.`);
    const css = await response.text();
    // O css2 devolve um bloco por subset, precedido de um comentario com o
    // nome dele. Latino basico e estendido cobrem portugues.
    const pattern = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gu;
    for (const match of css.matchAll(pattern)) {
      const [, subset, block] = match;
      if (subset !== 'latin' && subset !== 'latin-ext') continue;
      const source = /src:\s*url\((https:\/\/[^)]+)\)/u.exec(block)?.[1];
      if (!source) continue;
      const file = await net.fetch(source);
      if (!file.ok) throw new Error(`Falha ao baixar a fonte ${font.family}.`);
      const encoded = Buffer.from(await file.arrayBuffer()).toString('base64');
      blocks.push(
        block.replace(
          /src:\s*url\([^)]+\)/u,
          `src: url(data:font/woff2;base64,${encoded})`,
        ),
      );
    }
  }
  if (blocks.length === 0) throw new Error('Nenhuma fonte foi baixada.');
  await writeFile(
    path.join(fontsDirectory, 'fonts.css'),
    `/* ${FONTS_CSS_VERSION} — gerado pelo Edvid Desktop para render offline. */\n${blocks.join('\n')}\n`,
  );
}

let remotionInstall: Promise<RemotionRuntimeState> | null = null;
let remotionState: RemotionRuntimeState = { status: 'unknown' };

function broadcastRemotionState(state: RemotionRuntimeState): void {
  remotionState = state;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('remotion:state', state);
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...extraEnvironment },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 32_768) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || `Comando falhou (${code}).`));
    });
  });
}

// Roda um runtime resolvido respeitando o argsPrefix. O npm empacotado, por
// exemplo, e "node npm-cli.js": passar so o command executaria o binario do
// node como script e quebraria na hora.
function runResolved(
  resolution: RuntimeResolution,
  args: string[],
  cwd: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<void> {
  if (!resolution.command) {
    return Promise.reject(new Error(`${resolution.name} nao esta disponivel nesta plataforma.`));
  }
  return runCommand(resolution.command, [...resolution.argsPrefix, ...args], cwd, extraEnvironment);
}

async function remotionRuntimeIsReady(): Promise<boolean> {
  const runtime = remotionRuntimeDirectory();
  const binary = path.join(
    runtime,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'remotion.cmd' : 'remotion',
  );
  try {
    await stat(binary);
  } catch {
    return false;
  }
  // O Chrome nao vem do npm: sem ele o primeiro render tentaria a rede.
  try {
    await stat(path.join(runtime, 'node_modules', '.remotion', 'chrome-headless-shell'));
  } catch {
    return false;
  }
  // As fontes tambem sao baixadas por fora; sem elas o render sai com a fonte
  // padrao do sistema e todos os estilos ficam errados. A versao no proprio
  // arquivo forca a regeneracao quando o formato muda (v2 = data URIs).
  try {
    const css = await readFile(path.join(runtime, 'fonts', 'fonts.css'), 'utf8');
    return css.startsWith(`/* ${FONTS_CSS_VERSION}`);
  } catch {
    return false;
  }
}

function ensureRemotionRuntime(): Promise<RemotionRuntimeState> {
  if (remotionInstall) return remotionInstall;
  const pending = (async (): Promise<RemotionRuntimeState> => {
    const runtime = remotionRuntimeDirectory();
    if (await remotionRuntimeIsReady()) return { status: 'ready' };

    const runtimeContext = {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    };
    const node = resolveRuntime('node', runtimeContext);
    const npm = resolveRuntime('npm', runtimeContext);
    if (!node.command || !npm.command) {
      return { status: 'error', error: 'Node interno nao esta disponivel nesta plataforma.' };
    }

    await mkdir(runtime, { recursive: true });
    // Somente as dependencias de producao: typescript e @types/react so
    // servem ao editor, e o Remotion compila o TSX com o proprio bundler.
    const template = JSON.parse(
      await readFile(path.join(remotionTemplateDirectory(), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    await writeFile(
      path.join(runtime, 'package.json'),
      `${JSON.stringify(
        {
          name: 'edvid-remotion-runtime',
          version: '1.0.0',
          private: true,
          dependencies: template.dependencies ?? {},
        },
        null,
        2,
      )}\n`,
    );

    const nodeDirectory = path.dirname(node.command);
    const environment = {
      PATH: [nodeDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    };
    const ticker = setInterval(() => {
      void directorySize(path.join(runtime, 'node_modules')).then((installedBytes) => {
        if (remotionState.status === 'installing') {
          broadcastRemotionState({ ...remotionState, installedBytes });
        }
      });
    }, 900);
    try {
      broadcastRemotionState({ status: 'installing', step: 'dependencias', installedBytes: 0 });
      await runResolved(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], runtime, environment);
      broadcastRemotionState({ status: 'installing', step: 'navegador' });
      // Busca o Chrome headless shell agora, com progresso, em vez de deixar
      // o primeiro render travar pedindo rede dentro do sandbox.
      await runResolved(
        node,
        [path.join(runtime, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'), 'browser', 'ensure'],
        runtime,
        environment,
      );
      broadcastRemotionState({ status: 'installing', step: 'fontes' });
      await downloadRemotionFonts(path.join(runtime, 'fonts'));
      return { status: 'ready' };
    } catch (error) {
      const step = remotionState.status === 'installing' ? remotionState.step : undefined;
      const prefix = step === 'navegador'
        ? 'Falha ao baixar o navegador de render'
        : step === 'fontes'
          ? 'Falha ao baixar as fontes'
          : 'Falha ao instalar as dependências';
      return {
        status: 'error',
        error: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearInterval(ticker);
    }
  })();
  const install = pending.then((state) => {
    // Qualquer resultado que nao esteja pronto libera nova tentativa; um erro
    // cacheado obrigaria a reiniciar o aplicativo para tentar de novo.
    if (state.status !== 'ready' && remotionInstall === install) remotionInstall = null;
    broadcastRemotionState(state);
    return state;
  });
  remotionInstall = install;
  return install;
}

// Monta o projeto Remotion dentro do video, ligando o node_modules
// compartilhado. O agente so preenche public/ e roda o render.
async function scaffoldRemotionProject(projectDirectory: string): Promise<void> {
  const template = remotionTemplateDirectory();
  const destination = path.join(projectDirectory, 'edit', 'remotion');
  await mkdir(destination, { recursive: true });
  for (const entry of ['src', 'remotion.config.ts', 'tsconfig.json', 'package.json']) {
    await cp(path.join(template, entry), path.join(destination, entry), {
      recursive: true,
      force: true,
    });
  }
  // public/ guarda os dados da edicao: nunca sobrescrever o que ja existe.
  await cp(path.join(template, 'public'), path.join(destination, 'public'), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  // As fontes vivem no runtime compartilhado; o template le de public/fonts.
  await cp(
    path.join(remotionRuntimeDirectory(), 'fonts'),
    path.join(destination, 'public', 'fonts'),
    { recursive: true, force: true },
  );
  const link = path.join(destination, 'node_modules');
  const target = path.join(remotionRuntimeDirectory(), 'node_modules');
  // lstat, nao stat: um link apontando para um runtime removido precisa ser
  // refeito, e stat seguiria o link e falharia de um jeito que mascara isso.
  try {
    await lstat(link);
  } catch {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

// --- Render da Fase 2 pelo aplicativo -------------------------------------
// O Chromium do Remotion nao inicia dentro do sandbox do agente
// (MachPortRendezvousServer: Permission denied), entao cada render pelo
// agente exigia escalacao e aprovacao do usuario — e o limite de tempo dos
// comandos ainda o forcava a fatiar em partes. O aplicativo renderiza fora do
// sandbox, numa passada, com progresso; o agente apenas preenche public/.

// Entradas que definem o render. Mudou qualquer uma depois de um turno, o
// aplicativo re-renderiza; nada mudou, o resultado gravado continua valendo.
const PHASE2_INPUTS = [
  'edit-data.json',
  'captions.json',
  'caption-cues.json',
  'segments.json',
  'track.json',
  'cut.mp4',
];

let phase2Job: { directory: string; promise: Promise<Phase2RenderState> } | null = null;
let phase2State: Phase2RenderState = { status: 'idle' };

function broadcastPhase2State(state: Phase2RenderState): void {
  phase2State = state;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('phase2:state', state);
  }
}

async function phase2Fingerprint(publicDirectory: string): Promise<string | null> {
  // Sem o briefing e o video de entrada nao existe edicao para renderizar.
  try {
    await stat(path.join(publicDirectory, 'edit-data.json'));
    await stat(path.join(publicDirectory, 'cut.mp4'));
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const name of PHASE2_INPUTS) {
    try {
      const info = await stat(path.join(publicDirectory, name));
      parts.push(`${name}:${info.size}:${Math.floor(info.mtimeMs)}`);
    } catch {
      parts.push(`${name}:ausente`);
    }
  }
  return parts.join('|');
}

function renderPhase2(projectDirectory: string): Promise<Phase2RenderState> {
  if (phase2Job) {
    // Um render por vez. Para outro projeto, devolve o andamento atual sem
    // enfileirar; o proximo turno concluido tenta de novo.
    return phase2Job.directory === projectDirectory
      ? phase2Job.promise
      : Promise.resolve(phase2State);
  }
  const promise = (async (): Promise<Phase2RenderState> => {
    const remotionDirectory = path.join(projectDirectory, 'edit', 'remotion');
    const publicDirectory = path.join(remotionDirectory, 'public');
    const fingerprint = await phase2Fingerprint(publicDirectory);
    if (!fingerprint) return { status: 'idle' };

    const stampFile = path.join(remotionDirectory, 'out', 'render-stamp.json');
    let stamp: { fingerprint?: unknown; output?: unknown } = {};
    try {
      stamp = JSON.parse(await readFile(stampFile, 'utf8')) as typeof stamp;
    } catch {
      // Sem carimbo: primeiro render deste projeto.
    }
    const stampOutput = asText(stamp.output);
    if (stamp.fingerprint === fingerprint && stampOutput) {
      try {
        await stat(path.join(projectDirectory, stampOutput));
        return { status: 'ready', output: path.basename(stampOutput) };
      } catch {
        // Resultado sumiu; renderiza de novo.
      }
    }

    const runtime = await ensureRemotionRuntime();
    if (runtime.status !== 'ready') {
      return {
        status: 'error',
        error: runtime.status === 'error' && runtime.error
          ? runtime.error
          : 'Motor de render indisponivel.',
      };
    }
    // Reaplica o template antes de renderizar: correcoes no codigo (src/)
    // chegam aos projetos ja montados, e public/ nunca e sobrescrito.
    await scaffoldRemotionProject(projectDirectory);
    // O cache do webpack e compartilhado pelo runtime e ja serviu um modulo
    // velho mesmo com o arquivo mudado no disco — duas rodadas de depuracao
    // perdidas. Renderizar sempre do zero custa ~30 s e e deterministico.
    await rm(path.join(remotionRuntimeDirectory(), 'node_modules', '.cache', 'webpack'), {
      recursive: true,
      force: true,
    });
    const node = resolveRuntime('node', {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    });
    if (!node.command) {
      return { status: 'error', error: 'Node interno nao esta disponivel nesta plataforma.' };
    }

    await mkdir(path.join(remotionDirectory, 'out'), { recursive: true });
    // "tmp" no nome mantem o arquivo parcial fora do preview se algo falhar.
    const temporaryOutput = path.join(remotionDirectory, 'out', 'render_tmp_fase2.mp4');
    broadcastPhase2State({ status: 'rendering', progress: 0 });
    await new Promise<void>((resolveRender, rejectRender) => {
      const child = spawn(
        node.command as string,
        [
          ...node.argsPrefix,
          path.join(remotionDirectory, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'),
          'render',
          'Reels',
          temporaryOutput,
          '--timeout=120000',
        ],
        {
          cwd: remotionDirectory,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: [path.dirname(node.command as string), process.env.PATH]
              .filter(Boolean)
              .join(path.delimiter),
          },
        },
      );
      let stderrTail = '';
      const readProgress = (chunk: string) => {
        // O CLI imprime "Rendered 674/4340, time remaining: 1m 54s".
        const latest = [...chunk.matchAll(/Rendered (\d+)\/(\d+)/gu)].at(-1);
        if (!latest) return;
        const renderedFrames = Number(latest[1]);
        const totalFrames = Number(latest[2]);
        if (totalFrames > 0 && renderedFrames <= totalFrames) {
          broadcastPhase2State({
            status: 'rendering',
            progress: renderedFrames / totalFrames,
            renderedFrames,
            totalFrames,
          });
        }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', readProgress);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderrTail.length < 32_768) stderrTail += chunk;
        readProgress(chunk);
      });
      child.on('error', rejectRender);
      child.on('close', (code) => {
        if (code === 0) resolveRender();
        else {
          const lastLine = stderrTail
            .trim()
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .at(-1);
          rejectRender(new Error(lastLine || `Render falhou (${code}).`));
        }
      });
    });

    // Versao nova a cada render: artefatos anteriores nunca sao apagados e o
    // preview escolhe o mais recente sozinho.
    const targetDirectory = path.join(projectDirectory, 'edicao', 'fase_2');
    await mkdir(targetDirectory, { recursive: true });
    let version = 1;
    for (;;) {
      try {
        await stat(path.join(targetDirectory, `fase_2_v${version}.mp4`));
        version += 1;
      } catch {
        break;
      }
    }
    const finalName = `fase_2_v${version}.mp4`;
    await rename(temporaryOutput, path.join(targetDirectory, finalName));
    await writeFile(
      stampFile,
      `${JSON.stringify(
        { fingerprint, output: path.join('edicao', 'fase_2', finalName) },
        null,
        2,
      )}\n`,
    );
    return { status: 'ready', output: finalName };
  })()
    .catch((error): Phase2RenderState => ({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }))
    .then((state) => {
      phase2Job = null;
      broadcastPhase2State(state);
      return state;
    });
  phase2Job = { directory: projectDirectory, promise };
  return promise;
}

function ensureWhisperModel(): Promise<WhisperModelState> {
  if (modelPrefetch) return modelPrefetch;
  modelPrefetch = (async (): Promise<WhisperModelState> => {
    const caches = cachePaths();
    const hubCache = path.join(caches.huggingface, 'hub');
    const modelDirectory = path.join(
      hubCache,
      `models--${WHISPERX_MODEL_REPO.replace('/', '--')}`,
    );
    await prepareCacheDirectories();
    // Um snapshot ja baixado tem os pesos; qualquer coisa menor esta pela metade.
    if ((await directorySize(modelDirectory)) > 100_000_000) {
      return { status: 'ready', model: WHISPERX_MODEL_NAME };
    }
    const python = resolveRuntime('python', {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    });
    if (!python.command) {
      return {
        status: 'error',
        model: WHISPERX_MODEL_NAME,
        error: 'Python interno nao esta disponivel nesta plataforma.',
      };
    }
    broadcastModelState({ status: 'downloading', model: WHISPERX_MODEL_NAME, downloadedBytes: 0 });
    const ticker = setInterval(() => {
      void directorySize(modelDirectory).then((downloadedBytes) => {
        if (modelState.status === 'downloading') {
          broadcastModelState({ status: 'downloading', model: WHISPERX_MODEL_NAME, downloadedBytes });
        }
      });
    }, 700);
    try {
      await runModelDownload(python.command, hubCache);
      return { status: 'ready', model: WHISPERX_MODEL_NAME };
    } catch (error) {
      modelPrefetch = null; // Falha de rede pode ser transitoria; permite repetir.
      return {
        status: 'error',
        model: WHISPERX_MODEL_NAME,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearInterval(ticker);
    }
  })().then((state) => {
    broadcastModelState(state);
    return state;
  });
  return modelPrefetch;
}

function getCodexAppServer(): CodexAppServer {
  if (codexAppServer) return codexAppServer;
  const resolution = resolveRuntime('codex-app-server', {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  if (!resolution.command) {
    throw new Error('Codex App Server interno nao foi empacotado para esta plataforma.');
  }
  const runtimeContext = {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  };
  const localRuntimes = ['node', 'ffmpeg', 'ffprobe', 'uv', 'yt-dlp', 'python']
    .map((name) => resolveRuntime(name as RuntimeName, runtimeContext));
  const runtimePath = [
    ...new Set(localRuntimes.flatMap((runtime) => runtime.command ? [path.dirname(runtime.command)] : [])),
    process.env.PATH,
  ].filter((entry): entry is string => Boolean(entry)).join(path.delimiter);
  const runtimeCommand = (name: RuntimeName) => (
    localRuntimes.find((runtime) => runtime.name === name)?.command ?? ''
  );
  const caches = cachePaths();
  codexAppServer = new CodexAppServer(
    resolution.command,
    path.join(app.getPath('userData'), 'codex'),
    app.getVersion(),
    broadcastCodexEvent,
    {
      PATH: runtimePath,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      EDVID_PYTHON: runtimeCommand('python'),
      EDVID_FFMPEG: runtimeCommand('ffmpeg'),
      EDVID_FFPROBE: runtimeCommand('ffprobe'),
      EDVID_UV: runtimeCommand('uv'),
      EDVID_YTDLP: runtimeCommand('yt-dlp'),
      // Caches dentro dos dados do aplicativo: o WhisperX encontra o modelo
      // ja baixado e o matplotlib tem onde escrever, sem sair do sandbox.
      HF_HOME: caches.huggingface,
      HUGGINGFACE_HUB_CACHE: path.join(caches.huggingface, 'hub'),
      TORCH_HOME: caches.torch,
      XDG_CACHE_HOME: caches.xdg,
      MPLCONFIGDIR: caches.matplotlib,
      // O download do modelo e responsabilidade do aplicativo, nunca do
      // agente: assim o sandbox continua sem rede.
      HF_HUB_OFFLINE: '1',
      EDVID_WHISPER_MODEL: WHISPERX_MODEL_NAME,
      // Helpers oficiais da Fase 2, embutidos no aplicativo. Sem eles o agente
      // escrevia os JSONs do Remotion na mao, com formato proprio.
      EDVID_HELPERS: helpersDirectory(),
    },
    [caches.root],
  );
  return codexAppServer;
}

function checkRuntime(
  resolution: RuntimeResolution,
  args: string[],
): Promise<RuntimeCheck> {
  if (!resolution.command) {
    return Promise.resolve({
      name: resolution.name,
      available: false,
      version: null,
      expectedVersion: resolution.expectedVersion,
      source: 'missing',
      executablePath: null,
      error: 'Runtime interno ainda nao empacotado',
    });
  }

  return new Promise((resolve) => {
    const timeoutMs = resolution.name === 'yt-dlp' ? 30_000 : 10_000;
    const child = spawn(resolution.command as string, [...resolution.argsPrefix, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const complete = (check: RuntimeCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(check);
    };
    const timer = setTimeout(() => {
      child.kill();
      complete({
        name: resolution.name,
        available: false,
        version: null,
        expectedVersion: resolution.expectedVersion,
        source: resolution.source,
        executablePath: resolution.command,
        error: `Tempo esgotado apos ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 65_536) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 65_536) stderr += chunk;
    });
    child.on('error', (error) => {
      complete({
        name: resolution.name,
        available: false,
        version: null,
        expectedVersion: resolution.expectedVersion,
        source: resolution.source,
        executablePath: resolution.command,
        error: error.message,
      });
    });
    child.on('close', (status) => {
      if (status !== 0) {
        complete({
          name: resolution.name,
          available: false,
          version: null,
          expectedVersion: resolution.expectedVersion,
          source: resolution.source,
          executablePath: resolution.command,
          error: stderr.trim() || `Processo encerrou com codigo ${status ?? 'n/a'}`,
        });
        return;
      }
      const output = `${stdout}\n${stderr}`.trim();
      complete({
        name: resolution.name,
        available: true,
        version: output.split(/\r?\n/, 1)[0] || null,
        expectedVersion: resolution.expectedVersion,
        source: resolution.source,
        executablePath: resolution.command,
      });
    });
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-info', () => ({
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    embeddedNodeVersion: process.versions.node,
  }));

  ipcMain.handle('runtime:check', () =>
    Promise.all(runtimeCommands.map(({ name, args }) => {
      const resolution = resolveRuntime(name, {
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
      });
      return checkRuntime(resolution, args);
    })),
  );

  ipcMain.handle('project:list', async () => {
    const projects = await readRecentProjects();
    const qa = qaProject();
    return qa
      ? [qa, ...projects.filter((project) => project.directory !== qa.directory)]
      : projects;
  });

  ipcMain.handle('project:select-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Escolha a pasta do projeto de video',
      buttonLabel: 'Usar esta pasta',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || !result.filePaths[0]) return null;
    return openProject(result.filePaths[0]);
  });

  ipcMain.handle('project:open-recent', async (_event, input: { directory?: string }) => {
    const requestedDirectory = path.resolve(asText(input.directory));
    const projects = await readRecentProjects();
    const qa = qaProject();
    const isRecent = projects.some(
      (project) => path.resolve(project.directory) === requestedDirectory,
    ) || qa?.directory === requestedDirectory;
    if (!isRecent) throw new Error('Este projeto nao esta na lista recente do Edvid.');
    return openProject(requestedDirectory, qa?.directory !== requestedDirectory);
  });

  ipcMain.handle(
    'project:refresh-workspace',
    async (_event, input: { directory?: string }) => {
      const requestedDirectory = path.resolve(asText(input.directory));
      if (!selectedProjectDirectories.has(requestedDirectory)) {
        throw new Error('Abra o projeto antes de atualizar a edicao.');
      }
      return openProject(requestedDirectory, false);
    },
  );

  ipcMain.handle(
    'timeline:save',
    async (_event, input: { directory?: string; model?: unknown; loadStamp?: unknown }) => {
      const requestedDirectory = path.resolve(asText(input.directory));
      if (!selectedProjectDirectories.has(requestedDirectory)) {
        throw new Error('Abra o projeto antes de salvar a timeline.');
      }
      const model = sanitizeTimelineModel(input.model);
      if (!model) throw new Error('O modelo de timeline recebido e invalido.');
      const meta = projectTimelineMeta.get(requestedDirectory);
      // O carimbo viaja com o workspace que originou o modelo. Se o projeto
      // foi recarregado com outro EDL/mídia, este modelo é obsoleto: ignorar
      // é seguro (o EDL novo é a verdade) e evita gravar com carimbo errado.
      if (typeof input.loadStamp === 'string' && input.loadStamp !== timelineLoadStampOf(meta)) {
        return;
      }
      const timelinePath = meta?.timelinePath
        ?? path.join(requestedDirectory, 'edit', 'timeline.json');
      await mkdir(path.dirname(timelinePath), { recursive: true });
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        edlFingerprint: meta?.edlFingerprint ?? null,
        mediaFingerprint: meta?.mediaFingerprint ?? null,
        model,
      };
      // Escrita atômica: um crash no meio nunca deixa timeline.json truncado.
      const temporaryPath = `${timelinePath}.tmp-${process.pid}`;
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
      await rename(temporaryPath, timelinePath);
    },
  );

  ipcMain.handle('whisper-model:ensure', () => ensureWhisperModel());

  ipcMain.handle('remotion:ensure', () => ensureRemotionRuntime());

  ipcMain.handle('remotion:scaffold', async (_event, input: { directory?: string }) => {
    const requestedDirectory = path.resolve(asText(input.directory));
    if (!selectedProjectDirectories.has(requestedDirectory)) {
      throw new Error('Abra o projeto antes de preparar a Fase 2.');
    }
    await scaffoldRemotionProject(requestedDirectory);
  });

  ipcMain.handle('phase2:render', (_event, input: { directory?: string }) => {
    const requestedDirectory = path.resolve(asText(input.directory));
    if (!selectedProjectDirectories.has(requestedDirectory)) {
      throw new Error('Abra o projeto antes de renderizar a Fase 2.');
    }
    return renderPhase2(requestedDirectory);
  });

  ipcMain.handle('waveform:get', (_event, input: { url?: string }) =>
    readSourceWaveform(asText(input.url)));

  ipcMain.handle('codex:account', () => getCodexAppServer().readAccount());

  ipcMain.handle('codex:login', async () => {
    const login = await getCodexAppServer().startChatGptLogin();
    const authUrl = new URL(login.authUrl);
    if (authUrl.protocol !== 'https:' || authUrl.origin !== 'https://auth.openai.com') {
      throw new Error('O Codex retornou um endereco de login inesperado.');
    }
    await shell.openExternal(login.authUrl);
    return login.state;
  });

  ipcMain.handle('codex:login-cancel', () => getCodexAppServer().cancelLogin());

  ipcMain.handle('codex:logout', () => getCodexAppServer().logout());

  ipcMain.handle('codex:message', (_event, input: CodexSendMessageInput) => {
    const projectDirectory = asText(input.projectDirectory);
    const text = input.text?.trim();
    if (!projectDirectory) throw new Error('Escolha uma pasta de projeto.');
    const resolvedProjectDirectory = path.resolve(projectDirectory);
    if (!selectedProjectDirectories.has(resolvedProjectDirectory)) {
      throw new Error('Escolha a pasta do projeto pelo seletor do Edvid.');
    }
    if (!text) throw new Error('Escreva uma mensagem para o Edvid.');
    return getCodexAppServer().sendMessage(resolvedProjectDirectory, text);
  });

  ipcMain.handle(
    'codex:interrupt',
    (_event, input: { threadId: string; turnId: string }) =>
      getCodexAppServer().interrupt(input.threadId, input.turnId),
  );

  ipcMain.handle(
    'codex:approval',
    (
      _event,
      input: { approvalId: string | number; decision: CodexApprovalDecision },
    ) => getCodexAppServer().respondToApproval(input.approvalId, input.decision),
  );
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#090b10',
    title: 'Edvid',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const pageLoad = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : mainWindow.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      );

  // Opt-in visual regression hook for local/CI validation. It is inert for
  // users and avoids requiring macOS Screen Recording permission in tests.
  const screenshotPath = process.env.EDVID_SCREENSHOT_PATH;
  if (screenshotPath) {
    const requestedDelay = Number(process.env.EDVID_SCREENSHOT_DELAY_MS);
    const screenshotDelay = Number.isFinite(requestedDelay)
      ? Math.min(Math.max(requestedDelay, 0), 60_000)
      : 500;
    void pageLoad
      .then(() => new Promise((resolve) => setTimeout(resolve, screenshotDelay)))
      .then(() => mainWindow.webContents.capturePage())
      .then(async (capture) => {
        await writeFile(screenshotPath, capture.toPNG());
        app.exit(0);
      })
      .catch((error: unknown) => {
        console.error('Falha ao capturar screenshot de QA:', error);
        app.exit(1);
      });
  } else {
    void pageLoad;
  }
}

// --- Login do aluno (Creator Factory / Supabase) ---------------------------
// O aluno entra com o MESMO e-mail/senha da area de membros: autenticacao
// direta no Supabase Auth da plataforma com a anon key (chave publica,
// protegida pelas RLS). O direito de uso e a matricula ativa no curso
// IA Edit Pro, lida pela politica existente enrollments_select_own_or_admin.
// Sem as duas chaves abaixo o gate fica desligado e o app se comporta como
// sempre. A senha nunca e persistida; guardamos apenas o refresh token.

const MEMBER_SUPABASE_URL =
  process.env.EDVID_SUPABASE_URL?.trim() ||
  // URL publica do projeto Supabase da Creator Factory.
  'https://pvefvoskgqthaazucuol.supabase.co';
const MEMBER_SUPABASE_ANON_KEY =
  process.env.EDVID_SUPABASE_ANON_KEY?.trim() ||
  // Anon key publica do projeto (a mesma que o site entrega ao navegador;
  // protegida pelas RLS — a service_role jamais entra aqui).
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2ZWZ2b3NrZ3F0aGFhenVjdW9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzOTUyNDgsImV4cCI6MjA5Nzk3MTI0OH0.meYSpQTVUQf2a3dlgFe8LCjOApJkle2Hk6dhvrkpMaY';
// Matriculas que dao direito ao Edvid. O slug e o estavel; o titulo cobre o
// caso de o curso ser recriado com slug novo.
const MEMBER_ACCESS_SLUGS = new Set(['ia-edit-pro-thpgfw']);
const MEMBER_ACCESS_TITLE = 'ia edit pro';
// Ficar offline nao pode trancar o aluno na hora: a ultima validacao vale
// por este periodo.
const MEMBER_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

let memberAuthState: MemberAuthState = { status: 'unconfigured' };

type StoredMemberAuth = {
  refreshToken: string;
  email: string;
  name?: string;
  lastValidatedAt: number;
};

function memberConfigured(): boolean {
  return MEMBER_SUPABASE_URL.startsWith('https://') && MEMBER_SUPABASE_ANON_KEY.length > 20;
}

function memberAuthFile(): string {
  return path.join(app.getPath('userData'), 'member-auth.json');
}

function broadcastMemberAuth(state: MemberAuthState): void {
  memberAuthState = state;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('member:state', state);
  }
}

async function readStoredMemberAuth(): Promise<StoredMemberAuth | null> {
  try {
    const parsed = JSON.parse(await readFile(memberAuthFile(), 'utf8')) as Partial<StoredMemberAuth>;
    const refreshToken = asText(parsed.refreshToken);
    const email = asText(parsed.email);
    if (!refreshToken || !email) return null;
    return {
      refreshToken,
      email,
      name: asText(parsed.name) || undefined,
      lastValidatedAt: Number(parsed.lastValidatedAt) || 0,
    };
  } catch {
    return null;
  }
}

async function writeStoredMemberAuth(stored: StoredMemberAuth | null): Promise<void> {
  if (!stored) {
    await rm(memberAuthFile(), { force: true });
    return;
  }
  await writeFile(memberAuthFile(), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}

type MemberTokens = {
  accessToken: string;
  refreshToken: string;
  email: string;
  name?: string;
};

type MemberTokenResult =
  | { kind: 'ok'; tokens: MemberTokens }
  | { kind: 'denied'; message: string }
  | { kind: 'network' };

async function requestMemberTokens(body: Record<string, string>, grantType: string): Promise<MemberTokenResult> {
  let response: Response;
  try {
    response = await net.fetch(`${MEMBER_SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      headers: {
        apikey: MEMBER_SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'network' };
  }
  let payload: {
    access_token?: string;
    refresh_token?: string;
    user?: { email?: string; user_metadata?: { name?: string } };
    error_description?: string;
    msg?: string;
    error_code?: string;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return response.ok ? { kind: 'network' } : { kind: 'denied', message: 'Falha ao entrar. Tente de novo.' };
  }
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    const raw = asText(payload.error_description) || asText(payload.msg);
    const message = /invalid login credentials/iu.test(raw)
      ? 'E-mail ou senha incorretos. Use os mesmos dados da área de membros.'
      : /email not confirmed/iu.test(raw)
        ? 'Confirme seu e-mail na Creator Factory antes de entrar.'
        : raw || 'Não foi possível entrar.';
    return { kind: 'denied', message };
  }
  return {
    kind: 'ok',
    tokens: {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      email: asText(payload.user?.email),
      name: asText(payload.user?.user_metadata?.name) || undefined,
    },
  };
}

type MemberEntitlement = 'active' | 'inactive' | 'network';

async function checkMemberEntitlement(accessToken: string): Promise<MemberEntitlement> {
  let response: Response;
  try {
    response = await net.fetch(
      `${MEMBER_SUPABASE_URL}/rest/v1/enrollments?select=status,expires_at,course:courses(slug,title)`,
      {
        headers: {
          apikey: MEMBER_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
  } catch {
    return 'network';
  }
  if (!response.ok) return response.status >= 500 ? 'network' : 'inactive';
  let rows: Array<{
    status?: string;
    expires_at?: string | null;
    course?: { slug?: string; title?: string } | null;
  }>;
  try {
    rows = (await response.json()) as typeof rows;
  } catch {
    return 'network';
  }
  const now = Date.now();
  const active = (Array.isArray(rows) ? rows : []).some((row) => {
    if (asText(row.status) !== 'active') return false;
    const expires = asText(row.expires_at);
    if (expires && Date.parse(expires) <= now) return false;
    const slug = asText(row.course?.slug).toLocaleLowerCase('pt-BR');
    const title = asText(row.course?.title).toLocaleLowerCase('pt-BR');
    return MEMBER_ACCESS_SLUGS.has(slug) || title === MEMBER_ACCESS_TITLE;
  });
  return active ? 'active' : 'inactive';
}

async function memberLogin(email: string, password: string): Promise<MemberAuthState> {
  if (!memberConfigured()) return memberAuthState;
  broadcastMemberAuth({ status: 'checking' });
  const result = await requestMemberTokens({ email, password }, 'password');
  if (result.kind === 'network') {
    broadcastMemberAuth({ status: 'signed-out', error: 'Sem conexão. Verifique a internet e tente de novo.' });
    return memberAuthState;
  }
  if (result.kind === 'denied') {
    broadcastMemberAuth({ status: 'signed-out', error: result.message });
    return memberAuthState;
  }
  const entitlement = await checkMemberEntitlement(result.tokens.accessToken);
  if (entitlement === 'network') {
    broadcastMemberAuth({ status: 'signed-out', error: 'Sem conexão para validar sua matrícula. Tente de novo.' });
    return memberAuthState;
  }
  const identity = { email: result.tokens.email || email, name: result.tokens.name };
  if (entitlement === 'inactive') {
    // Guarda a sessao mesmo sem matricula: se o acesso for liberado depois,
    // reabrir o aplicativo ja resolve sem novo login.
    await writeStoredMemberAuth({
      refreshToken: result.tokens.refreshToken,
      email: identity.email,
      name: identity.name,
      lastValidatedAt: 0,
    });
    broadcastMemberAuth({ status: 'no-access', ...identity });
    return memberAuthState;
  }
  await writeStoredMemberAuth({
    refreshToken: result.tokens.refreshToken,
    email: identity.email,
    name: identity.name,
    lastValidatedAt: Date.now(),
  });
  broadcastMemberAuth({ status: 'signed-in', ...identity });
  return memberAuthState;
}

async function memberLogout(): Promise<MemberAuthState> {
  await writeStoredMemberAuth(null);
  if (memberConfigured()) broadcastMemberAuth({ status: 'signed-out' });
  return memberAuthState;
}

async function memberBoot(): Promise<void> {
  if (!memberConfigured()) {
    broadcastMemberAuth({ status: 'unconfigured' });
    return;
  }
  const stored = await readStoredMemberAuth();
  if (!stored) {
    broadcastMemberAuth({ status: 'signed-out' });
    return;
  }
  broadcastMemberAuth({ status: 'checking' });
  const offlineFallback = (): void => {
    if (Date.now() - stored.lastValidatedAt < MEMBER_OFFLINE_GRACE_MS) {
      broadcastMemberAuth({ status: 'signed-in', email: stored.email, name: stored.name, offline: true });
    } else {
      broadcastMemberAuth({
        status: 'signed-out',
        error: 'Não foi possível validar seu acesso. Conecte-se à internet e entre de novo.',
      });
    }
  };
  const result = await requestMemberTokens({ refresh_token: stored.refreshToken }, 'refresh_token');
  if (result.kind === 'network') {
    offlineFallback();
    return;
  }
  if (result.kind === 'denied') {
    await writeStoredMemberAuth(null);
    broadcastMemberAuth({ status: 'signed-out' });
    return;
  }
  const identity = {
    email: result.tokens.email || stored.email,
    name: result.tokens.name ?? stored.name,
  };
  // O refresh token rotaciona a cada uso; salvar o novo e obrigatorio.
  const entitlement = await checkMemberEntitlement(result.tokens.accessToken);
  await writeStoredMemberAuth({
    refreshToken: result.tokens.refreshToken,
    email: identity.email,
    name: identity.name,
    lastValidatedAt: entitlement === 'active' ? Date.now() : stored.lastValidatedAt,
  });
  if (entitlement === 'network') {
    offlineFallback();
    return;
  }
  if (entitlement === 'inactive') {
    broadcastMemberAuth({ status: 'no-access', ...identity });
    return;
  }
  broadcastMemberAuth({ status: 'signed-in', ...identity });
}

// --- Atualizacao OTA -------------------------------------------------------
// Estilo ChatGPT: checa um feed estatico, baixa em segundo plano e avisa a
// interface quando a nova versao esta pronta para reiniciar. Exige build com
// assinatura de producao (Squirrel.Mac recusa apps ad-hoc) e um feed JSON
// hospedado; sem o feed configurado, nada acontece. O formato do feed sai de
// scripts/generate-update-feed.mjs a cada release.
const UPDATE_FEED_URL =
  process.env.EDVID_UPDATE_FEED_URL?.trim() ||
  // Bucket R2 publico da Creator Factory (scripts/publish-update.mjs publica
  // o feed.json e o ZIP de cada release nesta URL).
  'https://pub-89ee05cdaf26477c8984a36be2b373fa.r2.dev/feed.json';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let appUpdateState: AppUpdateState = { status: 'idle' };

function broadcastAppUpdateState(state: AppUpdateState): void {
  appUpdateState = state;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('update:state', state);
  }
}

function setupAutoUpdate(): void {
  if (!app.isPackaged || process.platform !== 'darwin' || !UPDATE_FEED_URL) return;
  try {
    autoUpdater.setFeedURL({ url: UPDATE_FEED_URL, serverType: 'json' });
  } catch {
    return;
  }
  autoUpdater.on('update-downloaded', (_event, _notes, releaseName) => {
    broadcastAppUpdateState({ status: 'ready', version: asText(releaseName) || undefined });
  });
  autoUpdater.on('error', () => {
    // Sem rede ou build sem assinatura de producao: seguimos em silencio e a
    // proxima checagem tenta de novo.
  });
  const check = () => {
    try {
      autoUpdater.checkForUpdates();
    } catch {
      // Checagem ja em andamento; ignora.
    }
  };
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

registerIpcHandlers();
ipcMain.handle('update:install', () => {
  if (appUpdateState.status === 'ready') autoUpdater.quitAndInstall();
});
ipcMain.handle('member:get', () => memberAuthState);
ipcMain.handle('member:login', (_event, input: { email?: string; password?: string }) =>
  memberLogin(asText(input.email).toLocaleLowerCase('pt-BR'), asText(input.password)));
ipcMain.handle('member:logout', () => memberLogout());

void app.whenReady().then(async () => {
  // Os caches precisam existir antes do Codex iniciar: eles entram como
  // writable_roots do sandbox e como HF_HOME/MPLCONFIGDIR dos runtimes.
  await prepareCacheDirectories().catch((error: unknown) => {
    console.warn('Nao foi possivel preparar os caches do Edvid:', error);
  });
  setupAutoUpdate();
  void memberBoot();
  // Servidor de mídia com suporte a Range. Sem 206/Accept-Ranges o <video>
  // não consegue posicionar a agulha em arquivos grandes: o clique na
  // timeline era ignorado ou o vídeo reiniciava do zero.
  void protocol.handle('edvid-media', async (request) => {
    const url = new URL(request.url);
    const token = url.hostname === 'local' ? url.pathname.slice(1) : '';
    const mediaPath = authorizedMedia.get(token);
    if (!mediaPath) return new Response('Midia nao autorizada.', { status: 404 });
    let size: number;
    try {
      size = (await stat(mediaPath)).size;
    } catch {
      return new Response('Midia indisponivel.', { status: 404 });
    }
    const baseHeaders: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Content-Type': mediaMimeType(path.extname(mediaPath)),
    };
    const range = resolveByteRange(request.headers.get('range'), size);
    if (range.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
      });
    }
    const start = range.kind === 'partial' ? range.start : 0;
    const end = range.kind === 'partial' ? range.end : size - 1;
    const headers: Record<string, string> = {
      ...baseHeaders,
      'Content-Length': String(end - start + 1),
      ...(range.kind === 'partial'
        ? { 'Content-Range': `bytes ${start}-${end}/${size}` }
        : null),
    };
    const status = range.kind === 'partial' ? 206 : 200;
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    const stream = Readable.toWeb(
      createReadStream(mediaPath, { start, end }),
    ) as unknown as BodyInit;
    return new Response(stream, { status, headers });
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  codexAppServer?.stop();
});
