import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexAppServer } from './codex-app-server';
import { resolveRuntime, type RuntimeResolution } from './runtime';
import type {
  CodexApprovalDecision,
  CodexEvent,
  CodexSendMessageInput,
  ProjectMedia,
  ProjectSource,
  ProjectSummary,
  ProjectStyleState,
  ProjectTimeline,
  ProjectWorkspace,
  RuntimeCheck,
  RuntimeName,
  TimelineModel,
} from './shared';
import {
  PREVIEW_SOURCE_ID,
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
  score: number;
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

function scoreMedia(relativePath: string, modifiedAt: number): number {
  const normalized = relativePath.toLocaleLowerCase('pt-BR').replaceAll('\\', '/');
  const base = path.basename(normalized, path.extname(normalized));
  let score = 0;
  if (/^(final|resultado|render)/u.test(base)) score += 500;
  if (/corte[_ -]?limpo|clean[_ -]?cut|^cut(?:[_ -]|$)/u.test(base)) score += 400;
  if (normalized.includes('/edicao/') || normalized.includes('/edit/')) score += 160;
  if (normalized.includes('/assets/')) score -= 160;
  if (!normalized.includes('/')) score += 80;
  if (['.mp4', '.m4v', '.webm'].includes(path.extname(normalized))) score += 40;
  return score + modifiedAt / 1e12;
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
        score: scoreMedia(relativePath, fileStat.mtimeMs),
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
  const candidate = candidates.sort((a, b) => b.score - a.score)[0];
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
  const normalized = candidate.relativePath.toLocaleLowerCase('pt-BR');
  const base = path.basename(normalized, path.extname(normalized));
  const kind: ProjectMedia['kind'] = /^(final|resultado|render)/u.test(base)
    ? 'final'
    : /corte[_ -]?limpo|clean[_ -]?cut|^cut(?:[_ -]|$)/u.test(base)
      ? 'clean-cut'
      : 'source';
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
      label: segment.beat?.trim() || `Take ${String(index + 1).padStart(2, '0')}`,
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
    const mappedPath = typeof edlSources[sourceId] === 'string' ? edlSources[sourceId].trim() : '';
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

async function inspectProjectStyle(directory: string): Promise<ProjectStyleState | null> {
  const candidatePaths = [
    path.join(directory, 'edit', 'state.json'),
    path.join(directory, 'edicao', 'state.json'),
    path.join(directory, 'state.json'),
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
      };
      const style = state.style;
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
    },
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
    const requestedDirectory = path.resolve(input.directory?.trim() ?? '');
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
      const requestedDirectory = path.resolve(input.directory?.trim() ?? '');
      if (!selectedProjectDirectories.has(requestedDirectory)) {
        throw new Error('Abra o projeto antes de atualizar a edicao.');
      }
      return openProject(requestedDirectory, false);
    },
  );

  ipcMain.handle(
    'timeline:save',
    async (_event, input: { directory?: string; model?: unknown; loadStamp?: unknown }) => {
      const requestedDirectory = path.resolve(input.directory?.trim() ?? '');
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
    const projectDirectory = input.projectDirectory?.trim();
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

registerIpcHandlers();

void app.whenReady().then(() => {
  void protocol.handle('edvid-media', (request) => {
    const url = new URL(request.url);
    const token = url.hostname === 'local' ? url.pathname.slice(1) : '';
    const mediaPath = authorizedMedia.get(token);
    if (!mediaPath) return new Response('Midia nao autorizada.', { status: 404 });
    return net.fetch(pathToFileURL(mediaPath).toString(), {
      method: request.method,
      headers: request.headers,
    });
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
