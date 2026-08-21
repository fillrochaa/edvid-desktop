import { app, autoUpdater, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ClaudeAgent } from './claude-agent';
import { CodexAppServer } from './codex-app-server';
import { GeminiAgent } from './gemini-agent';
import { JCUT_LEAD_SECONDS, extractionArgs, mixArgs, muxArgs, planJcut } from './jcut';
import { AI_CATALOG, catalogEntry, routeCandidates, shouldFailover } from './ai-catalog';
import { mediaKind, mediaMimeType, mediaTier, pickPreviewMedia, resolveByteRange } from './media-selection';
import { resolveRuntime, runtimePackKey, type RuntimeResolution } from './runtime';
import type {
  AiProvider,
  AiRolesState,
  AppUpdateState,
  ClaudeAccountState,
  CodexApprovalDecision,
  CodexEvent,
  CodexSendMessageInput,
  ActiveModelState,
  CatalogConnection,
  CatalogState,
  GeminiAccountState,
  ImageGenState,
  JcutApplyResult,
  JcutSyncResult,
  MemberAuthState,
  OverlayClip,
  ProjectOverlays,
  Phase2RenderState,
  RuntimePackState,
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
  modelFromSourceFiles,
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

// Fixados primeiro; dentro de cada grupo, o aberto mais recentemente.
function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) =>
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt));
}

async function readRecentProjects(): Promise<ProjectSummary[]> {
  try {
    const parsed = JSON.parse(await readFile(projectsFile(), 'utf8')) as {
      projects?: unknown;
    };
    if (!Array.isArray(parsed.projects)) return [];
    return sortProjects(parsed.projects
      .filter((project): project is ProjectSummary => {
        if (!project || typeof project !== 'object') return false;
        const item = project as Partial<ProjectSummary>;
        return (
          typeof item.directory === 'string' &&
          typeof item.name === 'string' &&
          typeof item.lastOpenedAt === 'string'
        );
      })
      .slice(0, 16));
  } catch {
    return [];
  }
}

async function writeRecentProjects(projects: ProjectSummary[]): Promise<ProjectSummary[]> {
  await mkdir(path.dirname(projectsFile()), { recursive: true });
  await writeFile(projectsFile(), `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
  return sortProjects(projects);
}

async function rememberProject(directory: string, requestedName?: string): Promise<ProjectSummary> {
  const resolvedDirectory = path.resolve(directory);
  const current = await readRecentProjects();
  const existing = current.find((item) => path.resolve(item.directory) === resolvedDirectory);
  const project: ProjectSummary = {
    directory: resolvedDirectory,
    // O nome escolhido pelo usuario (na criacao ou no renomear) sobrevive a
    // reaberturas; sem ele, vale o nome da pasta.
    name: asText(requestedName) || existing?.name || path.basename(resolvedDirectory),
    lastOpenedAt: new Date().toISOString(),
    ...(existing?.pinned ? { pinned: true } : null),
  };
  await writeRecentProjects([
    project,
    ...current.filter((item) => path.resolve(item.directory) !== resolvedDirectory),
  ].slice(0, 16));
  selectedProjectDirectories.add(resolvedDirectory);
  return project;
}

async function mutateRecentProject(
  directory: string,
  mutate: (project: ProjectSummary) => ProjectSummary | null,
): Promise<ProjectSummary[]> {
  const resolvedDirectory = path.resolve(asText(directory));
  const current = await readRecentProjects();
  const next = current.flatMap((item) => {
    if (path.resolve(item.directory) !== resolvedDirectory) return [item];
    const mutated = mutate(item);
    return mutated ? [mutated] : [];
  });
  return writeRecentProjects(next);
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

function runtimeToolsRoot(): string {
  return path.join(app.getPath('userData'), 'runtime', 'tools');
}

// Contexto padrao de resolucao de runtimes: o pacote baixado sob demanda
// (userData/runtime/tools) tem prioridade; os resources cobrem o repositorio
// de desenvolvimento, que continua com as ferramentas em resources/runtimes.
function appRuntimeContext() {
  return {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    toolsRoot: runtimeToolsRoot(),
  };
}

// --- Pacote de runtimes sob demanda ----------------------------------------
// O instalador magro nao embarca as ferramentas (FFmpeg, Python/WhisperX,
// Node, Codex — 1,8 GB descomprimidos). O aplicativo baixa o pacote uma vez,
// e de novo apenas quando o manifest de versoes mudar, para
// userData/runtime/tools. Cada release do Edvid volta a pesar ~100 MB.

const RUNTIME_PACK_BASE_URL =
  'https://pub-89ee05cdaf26477c8984a36be2b373fa.r2.dev/runtimes';

let runtimePackJob: Promise<RuntimePackState> | null = null;
let runtimePackState: RuntimePackState = { status: 'unknown' };

function broadcastRuntimePackState(state: RuntimePackState): void {
  runtimePackState = state;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('runtime-pack:state', state);
  }
}

async function runtimePackIsReady(): Promise<boolean> {
  // Repositorio de desenvolvimento (e builds antigas "gordas"): as
  // ferramentas ainda estao nos resources e o pacote nao e necessario.
  const bundled = resolveRuntime('ffmpeg', {
    ...appRuntimeContext(),
    toolsRoot: null,
  });
  if (bundled.source === 'bundled') return true;
  try {
    const marker = JSON.parse(
      await readFile(path.join(runtimeToolsRoot(), 'pack.json'), 'utf8'),
    ) as { key?: unknown };
    return asText(marker.key) === runtimePackKey();
  } catch {
    return false;
  }
}

function ensureRuntimePack(): Promise<RuntimePackState> {
  if (runtimePackJob) return runtimePackJob;
  const job = (async (): Promise<RuntimePackState> => {
    broadcastRuntimePackState({ status: 'checking' });
    if (await runtimePackIsReady()) return { status: 'ready' };
    const key = runtimePackKey();
    const packName = `runtimes-${process.platform}-${process.arch}-${key}.tar.gz`;
    const packUrl = `${RUNTIME_PACK_BASE_URL}/${packName}`;

    // O sha256 publicado junto garante a integridade do download.
    let expectedDigest = '';
    try {
      const shaResponse = await net.fetch(`${packUrl}.sha256`);
      if (shaResponse.ok) expectedDigest = (await shaResponse.text()).trim().split(/\s+/)[0] ?? '';
    } catch {
      // Sem o arquivo de integridade seguimos apenas com HTTPS.
    }

    const stagingRoot = path.join(app.getPath('userData'), 'runtime');
    await mkdir(stagingRoot, { recursive: true });
    const tarballPath = path.join(stagingRoot, `${packName}.download`);
    const response = await net.fetch(packUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Pacote de ferramentas indisponível (HTTP ${response.status}).`);
    }
    const totalBytes = Number(response.headers.get('content-length')) || undefined;
    broadcastRuntimePackState({ status: 'downloading', downloadedBytes: 0, totalBytes });
    const digest = createHash('sha256');
    let downloadedBytes = 0;
    let lastBroadcast = 0;
    const reader = response.body.getReader();
    const output = createWriteStream(tarballPath);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          digest.update(value);
          downloadedBytes += value.byteLength;
          if (downloadedBytes - lastBroadcast > 8_000_000) {
            lastBroadcast = downloadedBytes;
            broadcastRuntimePackState({ status: 'downloading', downloadedBytes, totalBytes });
          }
          if (!output.write(value)) {
            await new Promise<void>((resolve) => output.once('drain', resolve));
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        output.end(() => resolve());
        output.on('error', reject);
      });
    } catch (error) {
      output.destroy();
      await rm(tarballPath, { force: true });
      throw error;
    }
    if (expectedDigest && digest.digest('hex') !== expectedDigest) {
      await rm(tarballPath, { force: true });
      throw new Error('O pacote de ferramentas chegou corrompido. Tente de novo.');
    }

    broadcastRuntimePackState({ status: 'extracting', downloadedBytes, totalBytes });
    const partial = path.join(stagingRoot, 'tools.partial');
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    // bsdtar existe no macOS e no Windows 10+; extracao em streaming, sem
    // dependencias novas.
    await runCommand('tar', ['-xzf', tarballPath, '-C', partial], stagingRoot);
    const probe = path.join(
      partial,
      `${process.platform}-${process.arch}`,
      'ffmpeg',
      'bin',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    );
    await stat(probe);
    await writeFile(path.join(partial, 'pack.json'), `${JSON.stringify({ key }, null, 2)}\n`);
    const tools = runtimeToolsRoot();
    await rm(tools, { recursive: true, force: true });
    await rename(partial, tools);
    await rm(tarballPath, { force: true });
    return { status: 'ready' };
  })()
    .catch((error): RuntimePackState => ({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }))
    .then((state) => {
      if (state.status !== 'ready' && runtimePackJob === job) runtimePackJob = null;
      broadcastRuntimePackState(state);
      return state;
    });
  runtimePackJob = job;
  return job;
}

// O PATH que passamos ao agente NAO sobrevive intacto no macOS: todo shell de
// login roda /usr/libexec/path_helper, que reconstroi o PATH com as pastas do
// sistema na frente e joga as nossas para o fim (sondado com command/exec: o
// pack caiu nas posicoes 14 e 15 e o agente achava /usr/bin/python3 — dai o
// "WhisperX nao esta disponivel no ambiente" no mac, enquanto no Windows, que
// nao tem path_helper, tudo funcionava). Duas defesas, porque o agente chama
// as ferramentas por nome E o proprio whisperx roda `ffmpeg` por subprocess:
// as instrucoes usam os caminhos absolutos EDVID_*, e este sitecustomize
// devolve as pastas do pacote para a frente do PATH dentro de qualquer
// processo Python. Fica no userData (nao no pack), entao nao muda a chave.
let pythonSiteDirectory: string | null = null;

async function writePythonSiteCustomize(): Promise<string | null> {
  const siteDirectory = path.join(app.getPath('userData'), 'runtime', 'pythonsite');
  const script = [
    '# Gerado pelo Edvid Desktop. Alteracoes manuais sao sobrescritas.',
    '# Garante que as ferramentas do Edvid venham primeiro no PATH de qualquer',
    '# processo Python do pacote (o whisperx chama "ffmpeg" por nome).',
    'import os',
    '',
    'try:',
    '    _dirs = [p for p in os.environ.get("EDVID_TOOL_DIRS", "").split(os.pathsep) if p]',
    '    if _dirs:',
    '        _rest = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p and p not in _dirs]',
    '        os.environ["PATH"] = os.pathsep.join(_dirs + _rest)',
    'except Exception:',
    '    pass',
    '',
  ].join('\n');
  try {
    await mkdir(siteDirectory, { recursive: true });
    await writeFile(path.join(siteDirectory, 'sitecustomize.py'), script);
    return siteDirectory;
  } catch {
    // Sem o sitecustomize o agente ainda funciona pelos caminhos absolutos.
    return null;
  }
}

// Os fluxos que dependem das ferramentas aguardam o pacote; quando ele ja
// esta pronto, o await resolve na hora.
async function requireRuntimePack(): Promise<void> {
  const state = await ensureRuntimePack();
  if (state.status !== 'ready') {
    throw new Error(state.error || 'As ferramentas do Edvid ainda estão sendo preparadas.');
  }
  // Escrito uma vez por sessao, antes de qualquer agente montar o ambiente.
  pythonSiteDirectory ??= await writePythonSiteCustomize();
}

async function inspectProjectMedia(directory: string): Promise<InspectedProjectMedia | null> {
  const candidates: MediaCandidate[] = [];
  await collectMedia(directory, directory, 0, candidates);
  const candidate = pickPreviewMedia(candidates);
  if (!candidate) return null;

  await requireRuntimePack().catch(() => {});
  const ffprobe = resolveRuntime('ffprobe', appRuntimeContext());
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
  const ffmpeg = resolveRuntime('ffmpeg', appRuntimeContext());
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
    const ffprobe = resolveRuntime('ffprobe', appRuntimeContext());
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

// Pasta com mais de um vídeo-fonte: antes do corte limpo existir, a timeline
// espelha TODOS os vídeos em sequência — na ordem natural dos nomes, a mesma
// em que a limpeza deve percorrê-los — e o preview mapeado toca um após o
// outro. Com um vídeo só, o espelho clássico (clipe único) continua valendo.
async function deriveSourceMirror(directory: string, fps: number): Promise<TimelineModel | null> {
  const candidates: MediaCandidate[] = [];
  await collectMedia(directory, directory, 0, candidates);
  const sourceCandidates = candidates.filter(
    (candidate) => mediaKind(candidate.relativePath, candidate.tier) === 'source',
  );
  if (sourceCandidates.length < 2) return null;
  sourceCandidates.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, 'pt-BR', { numeric: true, sensitivity: 'base' }),
  );
  const files: { id: string; label: string; duration: number }[] = [];
  for (const candidate of sourceCandidates) {
    const probe = await probeSourceFile(candidate.absolutePath);
    const duration = Number(probe?.format?.duration) || 0;
    if (duration <= 0.1) continue;
    files.push({
      // O id relativo com "/" é a mesma forma que o EDL usa para fontes; o
      // buildProjectSources resolve contra a pasta do projeto.
      id: candidate.relativePath.split(path.sep).join('/'),
      label: path.basename(candidate.relativePath),
      duration,
    });
  }
  if (files.length < 2) return null;
  return modelFromSourceFiles(files, fps);
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
    }
    if (!derived && inspectedMedia?.media.kind === 'source') {
      derived = await deriveSourceMirror(directory, fps);
    }
    if (!derived && inspectedMedia && inspectedMedia.media.duration > 0.1) {
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

async function openProject(directory: string, remember = true, name?: string): Promise<ProjectWorkspace> {
  const resolvedDirectory = path.resolve(directory);
  if (!(await isDirectory(resolvedDirectory))) {
    throw new Error('A pasta deste projeto nao esta mais disponivel.');
  }
  const project = remember
    ? await rememberProject(resolvedDirectory, name)
    : {
        directory: resolvedDirectory,
        name: path.basename(resolvedDirectory),
        lastOpenedAt: new Date().toISOString(),
      };
  selectedProjectDirectories.add(resolvedDirectory);
  const inspectedMedia = await inspectProjectMedia(resolvedDirectory);
  const [loaded, style, overlays] = await Promise.all([
    loadProjectTimeline(resolvedDirectory, inspectedMedia),
    inspectProjectStyle(resolvedDirectory),
    inspectProjectOverlays(resolvedDirectory),
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
    overlays,
  };
}

// Overlays reais da Fase 2 para a timeline: splits (tela dividida), inserts
// (cards), behind (atras do sujeito) e o fim do hook, direto do edit-data.json
// que o agente escreve em edit/remotion/public/.
async function inspectProjectOverlays(directory: string): Promise<ProjectOverlays | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(directory, 'edit', 'remotion', 'public', 'edit-data.json'), 'utf8'),
    ) as Record<string, unknown>;
    const clip = (start: unknown, end: unknown, label: string): OverlayClip | null => {
      const s = Number(start);
      const e = Number(end);
      return Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e, label } : null;
    };
    const images: OverlayClip[] = [];
    const videos: OverlayClip[] = [];
    const animations: OverlayClip[] = [];
    const list = (value: unknown): Array<Record<string, unknown>> =>
      Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
    for (const item of list(parsed.splits)) {
      const built = clip(item.start, item.end, path.basename(asText(item.src)) || 'Tela dividida');
      if (built) (item.kind === 'video' ? videos : images).push(built);
    }
    for (const item of list(parsed.inserts)) {
      const built = clip(item.start, item.end, path.basename(asText(item.src)) || 'Insert');
      if (built) images.push(built);
    }
    for (const item of list(parsed.behind)) {
      const built = clip(item.start, Number(item.start) + Number(item.dur), item.kind === 'words' ? 'Palavras' : 'Atrás do sujeito');
      if (built) animations.push(built);
    }
    // Animacoes sob medida do CustomGraphics: o agente REGISTRA as janelas em
    // edit-data.animations (o codigo nao e legivel pela timeline).
    for (const item of list(parsed.animations)) {
      const built = clip(item.start, item.end, asText(item.label).trim() || 'Animação');
      if (built) animations.push(built);
    }
    // Blindagem contra improviso de schema: agentes ja inventaram campos
    // proprios (ex.: creatorInfographics) e a animacao sumia da timeline.
    // Qualquer lista DESCONHECIDA no topo do edit-data cujos itens tenham
    // start + end (ou start + dur) vira chip de animacao, seja qual for o
    // nome — a timeline nunca mais fica cega para janelas de tempo.
    const knownKeys = new Set([
      'width', 'height', 'fps', 'durationSec', 'camera', 'hook', 'captions',
      'inserts', 'behind', 'splits', 'animations', 'soundtrack',
    ]);
    for (const [key, value] of Object.entries(parsed)) {
      if (knownKeys.has(key) || !Array.isArray(value)) continue;
      for (const item of list(value)) {
        const end = Number.isFinite(Number(item.end))
          ? item.end
          : Number(item.start) + Number(item.dur);
        const label =
          asText(item.label).trim() ||
          asText(item.title).trim() ||
          path.basename(asText(item.src)) ||
          key;
        const built = clip(item.start, end, label);
        if (built) animations.push(built);
      }
    }
    const hook = parsed.hook as { enabled?: unknown; endSec?: unknown } | undefined;
    const hookEnd = hook?.enabled === true && Number.isFinite(Number(hook.endSec)) ? Number(hook.endSec) : null;
    if (!images.length && !videos.length && !animations.length && hookEnd === null) return null;
    return { hookEnd, images, videos, animations };
  } catch {
    return null;
  }
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
// Alinhamento em portugues: o whisperx resolve "pt" para este repo
// (DEFAULT_ALIGN_MODELS_HF em alignment.py) e o agente roda offline — sem o
// prefetch o corte morria em "modelo de alinhamento nao disponivel no cache
// local" (aconteceu no Windows; o smoke antigo mascarava com --no_align).
// Baixamos so os pesos PyTorch (~1,2 GB) — ver runModelDownload.
const WHISPERX_ALIGN_REPO = 'jonatasgrosman/wav2vec2-large-xlsr-53-portuguese';
const WHISPERX_ALIGN_MIN_BYTES = 1_000_000_000;

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

// Tamanho de UM arquivo do snapshot (models--<repo>/snapshots/<rev>/<nome>).
// O huggingface_hub so cria esse link quando o download TERMINA — medir o
// diretorio inteiro contaria blobs .incomplete e daria o modelo por pronto
// sem os pesos (cenario real: cache com o flax pela metade da 0.13.8).
async function cachedWeightSize(modelDirectory: string, fileName: string): Promise<number> {
  const snapshotsRoot = path.join(modelDirectory, 'snapshots');
  let revisions;
  try {
    revisions = await readdir(snapshotsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let largest = 0;
  for (const revision of revisions) {
    if (!revision.isDirectory()) continue;
    try {
      // stat segue o symlink: mede o blob de verdade, nao o link.
      const info = await stat(path.join(snapshotsRoot, revision.name, fileName));
      if (info.isFile()) largest = Math.max(largest, info.size);
    } catch {
      // Revisao sem esse arquivo; segue.
    }
  }
  return largest;
}

function runModelDownload(python: string, hubCache: string): Promise<void> {
  const script = [
    'from huggingface_hub import snapshot_download',
    `snapshot_download(${JSON.stringify(WHISPERX_MODEL_REPO)})`,
    // O repo de alinhamento tem 3,5 GB, mas o WhisperX carrega so o
    // pytorch_model.bin (1,2 GB) via Wav2Vec2Processor + Wav2Vec2ForCTC: o
    // flax_model.msgpack (1,2 GB) e o language_model/ (1,1 GB, usado apenas
    // pelo Wav2Vec2ProcessorWithLM) sao peso morto. Baixar tudo triplicava a
    // espera do aluno na primeira abertura. Filtros validados com download
    // em cache limpo + alinhamento offline de verdade.
    `snapshot_download(${JSON.stringify(WHISPERX_ALIGN_REPO)},`,
    `    allow_patterns=['*.json', '*.txt', 'pytorch_model.bin', 'preprocessor_config.json'],`,
    `    ignore_patterns=['language_model/*'])`,
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
  const ffmpeg = resolveRuntime('ffmpeg', appRuntimeContext());
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
  // Ondas sao decorativas: sem as ferramentas prontas, simplesmente nao ha
  // onda ainda — os clipes redesenham quando o pacote concluir.
  try {
    await requireRuntimePack();
  } catch {
    return null;
  }
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
    // O npm/node vem do pacote de ferramentas; sem ele nao ha o que instalar.
    await requireRuntimePack();

    const runtimeContext = appRuntimeContext();
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

  // O CustomGraphics.tsx e o UNICO arquivo de src/ que o agente escreve — e
  // era apagado aqui a cada render, porque src/ inteiro vinha com force:true.
  // O agente escrevia a animacao sob medida, o app restaurava o template
  // logo antes de renderizar e o video saia sem ela; o arquivo terminava
  // identico ao template, o que fazia parecer que o agente nao tinha feito
  // nada. Defeito de origem das animacoes que "nunca apareciam".
  // O carimbo guarda o sha do TEMPLATE aplicado por ultimo: se o arquivo do
  // projeto ainda bate com ele, ninguem editou e vale atualizar para o
  // template novo; se difere, e trabalho do agente e fica de pe.
  const editableRelative = path.join('src', 'CustomGraphics.tsx');
  const projectEditable = path.join(destination, editableRelative);
  const stampFile = path.join(destination, '.edvid-scaffold.json');
  const templateEditableSource = await readFile(path.join(template, editableRelative), 'utf8')
    .catch(() => null);
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  let preservedEditable: string | null = null;
  const currentEditable = await readFile(projectEditable, 'utf8').catch(() => null);
  if (currentEditable !== null && templateEditableSource !== null) {
    let appliedSha: string | null = null;
    try {
      const stamp = JSON.parse(await readFile(stampFile, 'utf8')) as { customGraphicsSha?: unknown };
      appliedSha = asText(stamp.customGraphicsSha) || null;
    } catch {
      // Projeto montado antes do carimbo existir: compara com o template.
    }
    const untouched = appliedSha
      ? sha(currentEditable) === appliedSha
      : currentEditable === templateEditableSource;
    if (!untouched) preservedEditable = currentEditable;
  }

  for (const entry of ['src', 'remotion.config.ts', 'tsconfig.json', 'package.json']) {
    await cp(path.join(template, entry), path.join(destination, entry), {
      recursive: true,
      force: true,
    });
  }

  if (preservedEditable !== null) {
    // Devolve o trabalho do agente por cima da copia do template. O carimbo
    // NAO e atualizado: o arquivo segue diferente do template aplicado, entao
    // continuara preservado nos proximos renders.
    await writeFile(projectEditable, preservedEditable);
  } else if (templateEditableSource !== null) {
    await writeFile(
      stampFile,
      `${JSON.stringify({ customGraphicsSha: sha(templateEditableSource) }, null, 2)}\n`,
    ).catch(() => {});
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
  // O CustomGraphics e CODIGO que o agente edita (animacoes sob medida);
  // sem ele na impressao digital, uma animacao nova nao disparava render
  // nenhum — o unico arquivo-fonte editavel precisa contar como dado.
  const inputs: Array<[string, string]> = [
    ...PHASE2_INPUTS.map((name): [string, string] => [name, path.join(publicDirectory, name)]),
    ['CustomGraphics.tsx', path.join(publicDirectory, '..', 'src', 'CustomGraphics.tsx')],
  ];
  for (const [name, filePath] of inputs) {
    try {
      if (name === 'cut.mp4') {
        // Video de centenas de MB: tamanho + data bastam, e ninguem o
        // reescreve com o mesmo conteudo (o J-Cut muda os dois).
        const info = await stat(filePath);
        parts.push(`${name}:${info.size}:${Math.floor(info.mtimeMs)}`);
        continue;
      }
      // CONTEUDO, nao data. O app reescreve estes arquivos por conta propria
      // (o scaffold reaplica o CustomGraphics.tsx, a normalizacao regrava o
      // edit-data.json), e com mtime a impressao digital nunca batia com a
      // gravada: bastava abrir o aplicativo ou trocar de projeto para um
      // render inteiro comecar do nada. Pelo conteudo, reescrever igual e
      // invisivel e so mudanca de verdade dispara render.
      parts.push(`${name}:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`);
    } catch {
      parts.push(`${name}:ausente`);
    }
  }
  return parts.join('|');
}

// Animacao registrada SEM `kind` sai muda do render: o template so desenha o
// que tem tipo. Aconteceu duas vezes em maquina real — na segunda o agente ja
// tinha escrito kind nos flashes e esqueceu no infografico. Em vez de confiar
// no agente, o app resolve o tipo antes de renderizar: infere pelo rotulo e,
// sem pista nenhuma, usa o cartao de texto com o proprio rotulo — uma
// animacao registrada NUNCA fica invisivel.
const ANIMATION_KIND_HINTS: Array<[RegExp, string]> = [
  [/\bflash|estouro|clar(ao|ão)|transi(ca|çã)o\b/iu, 'flash'],
  [/\blinha do tempo|timeline|cronolog|etapas|passo a passo\b/iu, 'timeline'],
  [/\bformas|shapes|geom|bolha|elementos gr(a|á)ficos\b/iu, 'shapes'],
  [/\broteiro|script|texto|frase|t(o|ó)pico|bullet|lista|infogr(a|á)fico|card|cartao|cartão\b/iu, 'script'],
];

function inferAnimationKind(label: string): string {
  for (const [pattern, kind] of ANIMATION_KIND_HINTS) {
    if (pattern.test(label)) return kind;
  }
  return 'script';
}

// O agente escreveu animacao SOB MEDIDA no CustomGraphics.tsx? Entao o desenho
// vem do codigo dele e o registro sem `kind` esta CORRETO — injetar um preset
// ali desenharia um cartao generico por cima do trabalho dele (o aluno pediu
// tela cheia com grid e glassmorphism e recebeu o cartao "ROTEIRO"). A unica
// pergunta que precisa ser respondida e: este arquivo ainda e o do template?
async function customGraphicsUntouched(publicDirectory: string): Promise<boolean> {
  const projectFile = path.join(publicDirectory, '..', 'src', 'CustomGraphics.tsx');
  const templateFile = path.join(remotionTemplateDirectory(), 'src', 'CustomGraphics.tsx');
  try {
    const projectSource = await readFile(projectFile, 'utf8');
    // Mesma referencia que o scaffold usa: o sha do template aplicado. Sem o
    // carimbo (projeto antigo), compara com o template atual.
    try {
      const stamp = JSON.parse(
        await readFile(path.join(publicDirectory, '..', '.edvid-scaffold.json'), 'utf8'),
      ) as { customGraphicsSha?: unknown };
      const appliedSha = asText(stamp.customGraphicsSha);
      if (appliedSha) {
        return createHash('sha256').update(projectSource).digest('hex') === appliedSha;
      }
    } catch {
      // Sem carimbo: cai na comparacao direta.
    }
    return projectSource === (await readFile(templateFile, 'utf8'));
  } catch {
    // Sem conseguir comparar, o mais seguro e nao mexer no registro.
    return false;
  }
}

// Promessa nao cumprida: o agente marcou a animacao como "custom" (o desenho
// viria do codigo dele) e o CustomGraphics.tsx continua igual ao do template —
// nenhuma linha escrita. O template respeita o "custom" e nao desenha nada,
// entao a animacao sai muda. Aconteceu em maquina real logo depois de a
// instrucao do "custom" existir: o agente aprendeu a marcar e esqueceu de
// escrever. Devolve os rotulos pendentes para o app cobrar o turno seguinte.
async function pendingCustomAnimations(projectDirectory: string): Promise<string[]> {
  const publicDirectory = path.join(projectDirectory, 'edit', 'remotion', 'public');
  if (!(await customGraphicsUntouched(publicDirectory))) return [];
  try {
    const document = JSON.parse(
      await readFile(path.join(publicDirectory, 'edit-data.json'), 'utf8'),
    ) as { animations?: unknown };
    if (!Array.isArray(document.animations)) return [];
    return document.animations
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .filter((animation) => asText(animation.kind) === 'custom')
      .map((animation) => asText(animation.label) || 'animação sob medida');
  } catch {
    return [];
  }
}

async function normalizeAnimations(publicDirectory: string): Promise<number> {
  // Rede de seguranca so vale para quem NAO escreveu codigo proprio.
  if (!(await customGraphicsUntouched(publicDirectory))) return 0;
  const file = path.join(publicDirectory, 'edit-data.json');
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return 0;
  }
  const animations = document.animations;
  if (!Array.isArray(animations) || animations.length === 0) return 0;
  let fixed = 0;
  const normalized = animations.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const animation = entry as Record<string, unknown>;
    const declared = asText(animation.kind);
    // "custom" aqui é promessa vazia: chegamos neste ponto com o
    // CustomGraphics.tsx intacto, então não existe código para desenhar. O app
    // já cobrou o agente uma vez; se ainda assim não veio, vale mais um efeito
    // padrão do que uma animação invisível.
    if (declared && declared !== 'custom') return animation;
    const label = asText(animation.label);
    const kind = inferAnimationKind(label);
    fixed += 1;
    return {
      ...animation,
      kind,
      // O cartao precisa de texto: sem `lines`, mostra o proprio rotulo.
      ...(kind === 'script' && !Array.isArray(animation.lines) && label
        ? { lines: [label] }
        : {}),
    };
  });
  if (fixed === 0) return 0;
  document.animations = normalized;
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  return fixed;
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
    // Antes da impressao digital: corrigir o edit-data muda o arquivo e, com
    // ele, o fingerprint — assim a correcao entra neste render, nao no proximo.
    await normalizeAnimations(publicDirectory).catch(() => 0);
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
    // O node do render vem do pacote de ferramentas.
    await requireRuntimePack();
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
    const node = resolveRuntime('node', appRuntimeContext());
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

// O WhisperX pode estar "instalado" e mesmo assim nao abrir nesta maquina
// (dylib/DLL ausente, pacote corrompido no download). Provar uma vez por
// chave de pack que `python -m whisperx --help` executa transforma o defeito
// invisivel do agente ("o WhisperX nao esta disponivel no ambiente") num
// erro exato no banner, com o "Tentar de novo". As importacoes pesam ~10 s,
// entao o resultado bom fica marcado e as sessoes seguintes nao repetem.
async function verifyWhisperxCli(
  python: string,
): Promise<{ ok: boolean; error: string }> {
  const caches = cachePaths();
  const marker = path.join(caches.root, `whisperx-ok-${runtimePackKey()}.json`);
  try {
    await stat(marker);
    return { ok: true, error: '' };
  } catch {
    // Sem marcador: verifica de verdade.
  }
  const outcome = await new Promise<{ ok: boolean; error: string }>((resolve) => {
    const child = spawn(python, ['-B', '-m', 'whisperx', '--help'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        HF_HOME: caches.huggingface,
        HUGGINGFACE_HUB_CACHE: path.join(caches.huggingface, 'hub'),
        TORCH_HOME: caches.torch,
        XDG_CACHE_HOME: caches.xdg,
        MPLCONFIGDIR: caches.matplotlib,
        HF_HUB_OFFLINE: '1',
      },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: 'a verificação demorou mais de 3 minutos' });
    }, 180_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, error: '' });
      else resolve({ ok: false, error: stderr.trim().split(/\r?\n/).at(-1) || `saiu com código ${code}` });
    });
  });
  if (outcome.ok) {
    await writeFile(marker, `${JSON.stringify({ checkedAt: new Date().toISOString() })}\n`).catch(() => {});
  }
  return outcome;
}

function ensureWhisperModel(): Promise<WhisperModelState> {
  if (modelPrefetch) return modelPrefetch;
  modelPrefetch = (async (): Promise<WhisperModelState> => {
    // O download dos modelos roda no Python do pacote de ferramentas.
    await requireRuntimePack();
    const caches = cachePaths();
    const hubCache = path.join(caches.huggingface, 'hub');
    const modelDirectory = path.join(
      hubCache,
      `models--${WHISPERX_MODEL_REPO.replace('/', '--')}`,
    );
    const alignDirectory = path.join(
      hubCache,
      `models--${WHISPERX_ALIGN_REPO.replace('/', '--')}`,
    );
    await prepareCacheDirectories();
    const python = resolveRuntime('python', appRuntimeContext());
    if (!python.command) {
      return {
        status: 'error',
        model: WHISPERX_MODEL_NAME,
        error: 'Python interno nao esta disponivel nesta plataforma.',
      };
    }
    // Pronto = os DOIS arquivos de peso existem completos no cache: model.bin
    // do faster-whisper-small (~464 MB) e pytorch_model.bin do alinhamento
    // (~1,2 GB). Medir arquivo, e nao diretorio, ignora downloads parciais.
    const cached =
      (await cachedWeightSize(modelDirectory, 'model.bin')) > 100_000_000 &&
      (await cachedWeightSize(alignDirectory, 'pytorch_model.bin')) > WHISPERX_ALIGN_MIN_BYTES;
    if (!cached) {
      broadcastModelState({ status: 'downloading', model: WHISPERX_MODEL_NAME, downloadedBytes: 0 });
      const ticker = setInterval(() => {
        void Promise.all([directorySize(modelDirectory), directorySize(alignDirectory)])
          .then(([modelBytes, alignBytes]) => {
            if (modelState.status === 'downloading') {
              broadcastModelState({
                status: 'downloading',
                model: WHISPERX_MODEL_NAME,
                downloadedBytes: modelBytes + alignBytes,
              });
            }
          });
      }, 700);
      try {
        await runModelDownload(python.command, hubCache);
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
    }
    const health = await verifyWhisperxCli(python.command);
    if (!health.ok) {
      modelPrefetch = null; // "Tentar de novo" repete a verificação.
      return {
        status: 'error',
        model: WHISPERX_MODEL_NAME,
        error: `o WhisperX não abre neste computador (${health.error})`,
      };
    }
    return { status: 'ready', model: WHISPERX_MODEL_NAME };
  })().then((state) => {
    broadcastModelState(state);
    return state;
  });
  return modelPrefetch;
}

// Ambiente de ferramentas dos agentes de IA (Codex e Claude): PATH das
// ferramentas empacotadas, variaveis EDVID_* e caches fora do sandbox.
function agentToolsEnvironment(): NodeJS.ProcessEnv {
  const runtimeContext = appRuntimeContext();
  const localRuntimes = ['node', 'ffmpeg', 'ffprobe', 'uv', 'yt-dlp', 'python']
    .map((name) => resolveRuntime(name as RuntimeName, runtimeContext));
  const toolDirectories = [
    ...new Set(localRuntimes.flatMap((runtime) => runtime.command ? [path.dirname(runtime.command)] : [])),
  ];
  const runtimePath = [...toolDirectories, process.env.PATH]
    .filter((entry): entry is string => Boolean(entry)).join(path.delimiter);
  const runtimeCommand = (name: RuntimeName) => (
    localRuntimes.find((runtime) => runtime.name === name)?.command ?? ''
  );
  const caches = cachePaths();
  return {
    PATH: runtimePath,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    // Lidos pelo sitecustomize acima para restaurar a ordem do PATH dentro do
    // Python, mesmo quando o shell de login do macOS reordenou tudo.
    EDVID_TOOL_DIRS: toolDirectories.join(path.delimiter),
    ...(pythonSiteDirectory ? { PYTHONPATH: pythonSiteDirectory } : {}),
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
  };
}

// O Codex (e o PATH de ferramentas que ele recebe) so pode ser construido
// depois do pacote de runtimes: a resolucao acontece uma unica vez.
async function codexServer(): Promise<CodexAppServer> {
  await requireRuntimePack();
  return getCodexAppServer();
}

function getCodexAppServer(): CodexAppServer {
  if (codexAppServer) return codexAppServer;
  const resolution = resolveRuntime('codex-app-server', appRuntimeContext());
  if (!resolution.command) {
    throw new Error('Codex App Server interno nao foi empacotado para esta plataforma.');
  }
  codexAppServer = new CodexAppServer(
    resolution.command,
    path.join(app.getPath('userData'), 'codex'),
    app.getVersion(),
    broadcastCodexEvent,
    agentToolsEnvironment(),
    [cachePaths().root],
  );
  return codexAppServer;
}

// --- Papeis de IA e agente Claude ------------------------------------------
// O aluno conecta as proprias contas e cada PAPEL tem um provedor: "chat"
// conduz a conversa, "image" gera as imagens pedidas pela edicao. As regras
// automaticas moram no renderer (que enxerga todas as contas); o main guarda,
// persiste e roteia. Os eventos de conversa dos tres agentes saem pelo MESMO
// canal (codex:event) e o chat nao sabe a diferenca.

const AI_PROVIDERS = new Set(['chatgpt', 'claude', 'gemini']);
let aiRoles: AiRolesState = { chat: 'chatgpt', image: null, chatPinned: false, imagePinned: false };
let claudeAgent: ClaudeAgent | null = null;

function appSettingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadAppSettings(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(appSettingsFile(), 'utf8')) as Record<string, unknown>;
    // "aiProvider" e o nome antigo (0.9.x-0.10.x), quando so havia o chat.
    const chat = parsed.chatProvider ?? parsed.aiProvider;
    if (typeof chat === 'string' && AI_PROVIDERS.has(chat)) aiRoles.chat = chat as AiProvider;
    if (typeof parsed.imageProvider === 'string' && AI_PROVIDERS.has(parsed.imageProvider)) {
      aiRoles.image = parsed.imageProvider as AiProvider;
    }
    aiRoles.chatPinned = parsed.chatPinned === true;
    aiRoles.imagePinned = parsed.imagePinned === true;
  } catch {
    // Sem settings ainda: ficam os padroes.
  }
}

function broadcastAiRoles(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('ai:roles', aiRoles);
  }
}

async function setAiRole(
  role: 'chat' | 'image',
  provider: AiProvider | null,
  pinned: boolean,
): Promise<AiRolesState> {
  if (role === 'chat') {
    if (provider) aiRoles = { ...aiRoles, chat: provider, chatPinned: pinned };
  } else {
    aiRoles = { ...aiRoles, image: provider, imagePinned: provider ? pinned : false };
  }
  await writeFile(
    appSettingsFile(),
    `${JSON.stringify(
      {
        chatProvider: aiRoles.chat,
        imageProvider: aiRoles.image,
        chatPinned: aiRoles.chatPinned,
        imagePinned: aiRoles.imagePinned,
      },
      null,
      2,
    )}\n`,
  ).catch(() => {});
  broadcastAiRoles();
  return aiRoles;
}

function broadcastClaudeAccount(state: ClaudeAccountState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('claude:account', state);
  }
}

function getClaudeAgent(): ClaudeAgent {
  if (claudeAgent) return claudeAgent;
  claudeAgent = new ClaudeAgent({
    runtimeDirectory: path.join(app.getPath('userData'), 'runtime', 'claude'),
    configDirectory: path.join(app.getPath('userData'), 'claude'),
    authFile: path.join(app.getPath('userData'), 'claude-auth.json'),
    toolsEnvironment: agentToolsEnvironment,
    sandboxWritableRoots: [cachePaths().root],
    resolveNpm: () => {
      const npm = resolveRuntime('npm', appRuntimeContext());
      return { command: npm.command, argsPrefix: npm.argsPrefix };
    },
    emitEvent: broadcastCodexEvent,
    emitAccount: broadcastClaudeAccount,
    fetchImpl: net.fetch.bind(net),
  });
  return claudeAgent;
}

// O motor (SDK) so e necessario para conversar; conta e login funcionam sem
// o pacote de runtimes, entao apenas as mensagens passam por este gate.
async function claudeAgentReady(): Promise<ClaudeAgent> {
  await requireRuntimePack();
  return getClaudeAgent();
}

let geminiAgent: GeminiAgent | null = null;

function broadcastGeminiAccount(state: GeminiAccountState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('gemini:account', state);
  }
}

function getGeminiAgent(): GeminiAgent {
  if (geminiAgent) return geminiAgent;
  geminiAgent = new GeminiAgent({
    runtimeDirectory: path.join(app.getPath('userData'), 'runtime', 'gemini'),
    authFile: path.join(app.getPath('userData'), 'gemini-auth.json'),
    systemSettingsFile: path.join(app.getPath('userData'), 'gemini-system-settings.json'),
    toolsEnvironment: agentToolsEnvironment,
    resolveNode: () => resolveRuntime('node', appRuntimeContext()).command,
    resolveNpm: () => {
      const npm = resolveRuntime('npm', appRuntimeContext());
      return { command: npm.command, argsPrefix: npm.argsPrefix };
    },
    emitEvent: broadcastCodexEvent,
    emitAccount: broadcastGeminiAccount,
    fetchImpl: net.fetch.bind(net),
  });
  return geminiAgent;
}

async function geminiAgentReady(): Promise<GeminiAgent> {
  await requireRuntimePack();
  return getGeminiAgent();
}

// --- J-Cut deterministico aplicado pelo aplicativo -------------------------
// O video do corte NUNCA e tocado (c:v copy); so o audio e remontado com a
// antecipacao e o crossfade calculados em src/jcut.ts a partir do proprio
// EDL. O agente nao participa: era o improviso dele que dessincronizava o
// video. edit/jcut.json marca o estado aplicado; quando o agente re-renderiza
// o corte (timeline, correcoes), o pos-turno reaplica sozinho.

const JCUT_MARKER_VERSION = 1;

type JcutMarker = {
  version: number;
  lead: number;
  cuts: number;
  appliedAt: string;
  files: Array<{ path: string; size: number; mtimeMs: number }>;
};

let jcutJob: { directory: string; promise: Promise<JcutApplyResult> } | null = null;

function jcutMarkerPath(projectDirectory: string): string {
  return path.join(projectDirectory, 'edit', 'jcut.json');
}

function runFfmpeg(command: string, argsPrefix: string[], args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argsPrefix, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 262_144) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split(/\r?\n/u).at(-1) || `FFmpeg falhou (${code}).`));
    });
  });
}

// Resolve o arquivo-fonte de um range do EDL (id do mapa sources, nome de
// arquivo direto ou a fonte unica do documento), sempre dentro do projeto.
function resolveJcutSource(
  projectDirectory: string,
  document: EdlDocument,
  sourceId: string,
): string | null {
  const sources = document.sources ?? {};
  const fallback = Object.values(sources).map((value) => asText(value)).find(Boolean) ?? asText(document.source);
  const mapped = asText(sources[sourceId]) || asText(sourceId) || fallback;
  if (!mapped) return null;
  const absolutePath = path.isAbsolute(mapped) ? path.resolve(mapped) : path.resolve(projectDirectory, mapped);
  const relative = path.relative(projectDirectory, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolutePath;
}

// O alvo primario e o corte limpo mais recente FORA de edit/remotion/public
// (o arquivo que o preview da Fase 1 exibe); o espelho e o public/cut.mp4 que
// alimenta a Fase 2, quando ja existir.
async function findJcutTargets(projectDirectory: string): Promise<{ primary: string | null; mirror: string | null }> {
  const candidates: MediaCandidate[] = [];
  await collectMedia(projectDirectory, projectDirectory, 0, candidates);
  const cleanCuts = candidates
    .filter((candidate) => candidate.tier === 3
      && mediaKind(candidate.relativePath, candidate.tier) === 'clean-cut'
      && !/(^|\/)remotion\/public\//u.test(candidate.relativePath.replaceAll('\\', '/')))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const mirrorPath = path.join(projectDirectory, 'edit', 'remotion', 'public', 'cut.mp4');
  const mirror = await stat(mirrorPath).then((info) => (info.isFile() ? mirrorPath : null), () => null);
  return { primary: cleanCuts[0]?.absolutePath ?? null, mirror };
}

async function statOf(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(filePath);
    return { size: info.size, mtimeMs: Math.round(info.mtimeMs) };
  } catch {
    return null;
  }
}

function applyJcutToProject(projectDirectory: string): Promise<JcutApplyResult> {
  if (jcutJob?.directory === projectDirectory) return jcutJob.promise;
  const job = (async (): Promise<JcutApplyResult> => {
    await requireRuntimePack();
    const ffmpeg = resolveRuntime('ffmpeg', appRuntimeContext());
    const ffprobe = resolveRuntime('ffprobe', appRuntimeContext());
    if (!ffmpeg.command || !ffprobe.command) {
      return { applied: false, cuts: 0, error: 'As ferramentas de vídeo do Edvid não estão disponíveis.' };
    }
    const edl = await readEdlDocument(projectDirectory);
    const ranges = Array.isArray(edl?.document.ranges) ? edl.document.ranges : [];
    if (!edl || ranges.length < 2) {
      return { applied: false, cuts: 0, error: 'Ainda não há um corte com transições no EDL para aplicar o J-Cut.' };
    }
    const plan = planJcut(ranges);
    if (!plan) {
      return { applied: false, cuts: 0, error: 'As transições deste corte são curtas demais para antecipar o áudio.' };
    }
    const targets = await findJcutTargets(projectDirectory);
    const primary = targets.primary ?? targets.mirror;
    if (!primary) {
      return { applied: false, cuts: 0, error: 'Não encontrei o vídeo do corte limpo em edit/ para aplicar o J-Cut.' };
    }
    const sourcePaths: string[] = [];
    for (const segment of plan.segments) {
      const resolved = resolveJcutSource(projectDirectory, edl.document, segment.sourceId);
      if (!resolved || !(await statOf(resolved))) {
        return { applied: false, cuts: 0, error: `O arquivo-fonte "${segment.sourceId || 'principal'}" do EDL não está na pasta do projeto.` };
      }
      sourcePaths.push(resolved);
    }

    const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'edvid-jcut-'));
    try {
      const pieces: string[] = [];
      for (const [index, segment] of plan.segments.entries()) {
        const wav = path.join(workDirectory, `piece-${index}.wav`);
        await runFfmpeg(ffmpeg.command, ffmpeg.argsPrefix, extractionArgs(segment, sourcePaths[index], wav), 120_000);
        pieces.push(wav);
      }
      const mixed = path.join(workDirectory, 'mixed.wav');
      await runFfmpeg(ffmpeg.command, ffmpeg.argsPrefix, mixArgs(plan, pieces, mixed), 120_000);

      const extension = path.extname(primary) || '.mp4';
      const rendered = path.join(workDirectory, `saida${extension}`);
      await runFfmpeg(ffmpeg.command, ffmpeg.argsPrefix, muxArgs(primary, mixed, rendered), 300_000);

      // Verificacao antes de substituir: duracoes de video e audio fechadas
      // entre si e com o corte original. Qualquer divergencia aborta.
      const probeOut = await inspectVideo(ffprobe.command, ffprobe.argsPrefix, rendered);
      const probeOriginal = await inspectVideo(ffprobe.command, ffprobe.argsPrefix, primary);
      const outDuration = Number(probeOut.format?.duration);
      const originalDuration = Number(probeOriginal.format?.duration);
      if (!Number.isFinite(outDuration) || !Number.isFinite(originalDuration) || Math.abs(outDuration - originalDuration) > 0.1) {
        throw new Error('A verificação de duração do J-Cut falhou; o corte original foi mantido.');
      }

      // Backup com marca de intermediario (o preview ignora "-tmp") e troca
      // atomica no mesmo diretorio.
      const applyTo = async (target: string): Promise<void> => {
        const directory = path.dirname(target);
        const base = path.basename(target, path.extname(target));
        const backup = path.join(directory, `${base}-sem-jcut-tmp${path.extname(target)}`);
        await copyFile(target, backup);
        const staged = path.join(directory, `${base}-jcut-staging-tmp${path.extname(target)}`);
        await copyFile(rendered, staged);
        await rename(staged, target);
      };
      await applyTo(primary);
      if (targets.mirror && targets.mirror !== primary) await applyTo(targets.mirror);

      // O jcut_timeline oficial passa a ser escrito pelo aplicativo.
      const document = JSON.parse(await readFile(edl.path, 'utf8')) as EdlDocument;
      document.jcut_timeline = plan.timeline;
      await writeFile(edl.path, `${JSON.stringify(document, null, 2)}\n`);

      const files: JcutMarker['files'] = [];
      for (const target of [primary, targets.mirror].filter((value): value is string => Boolean(value))) {
        const info = await statOf(target);
        if (info) files.push({ path: path.relative(projectDirectory, target), ...info });
      }
      const marker: JcutMarker = {
        version: JCUT_MARKER_VERSION,
        lead: JCUT_LEAD_SECONDS,
        cuts: plan.leadsApplied,
        appliedAt: new Date().toISOString(),
        files,
      };
      await mkdir(path.dirname(jcutMarkerPath(projectDirectory)), { recursive: true });
      await writeFile(jcutMarkerPath(projectDirectory), `${JSON.stringify(marker, null, 2)}\n`);
      return { applied: true, cuts: plan.leadsApplied, error: null };
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  })().catch((error: unknown) => ({
    applied: false,
    cuts: 0,
    error: error instanceof Error ? error.message : String(error),
  }));
  jcutJob = { directory: projectDirectory, promise: job };
  void job.finally(() => {
    if (jcutJob?.promise === job) jcutJob = null;
  });
  return job;
}

// Pos-turno: se o J-Cut ja foi aplicado neste projeto e o agente re-renderizou
// o corte (arquivos mudaram), reaplica em silencio com o EDL atual.
async function syncJcutForProject(projectDirectory: string): Promise<JcutSyncResult> {
  let marker: JcutMarker | null = null;
  try {
    const parsed = JSON.parse(await readFile(jcutMarkerPath(projectDirectory), 'utf8')) as JcutMarker;
    if (parsed?.version === JCUT_MARKER_VERSION && Array.isArray(parsed.files)) marker = parsed;
  } catch {
    marker = null;
  }
  if (!marker) return { changed: false };
  let stale = false;
  for (const file of marker.files) {
    const info = await statOf(path.resolve(projectDirectory, file.path));
    if (!info || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
      stale = true;
      break;
    }
  }
  if (!stale) return { changed: false };
  const result = await applyJcutToProject(projectDirectory);
  return { changed: result.applied };
}

// --- Catalogo de IAs conectadas ---------------------------------------------
// As credenciais ficam em userData/ai-catalog.json (0600), no mesmo padrao das
// outras contas. O arquivo guarda a chave; a interface so recebe a mascara.

type StoredCatalogEntry = { fields: Record<string, string>; cooldownUntil?: number | null };
type StoredCatalog = { freeOnly?: boolean; providers?: Record<string, StoredCatalogEntry> };

function catalogFile(): string {
  return path.join(app.getPath('userData'), 'ai-catalog.json');
}

async function readStoredCatalog(): Promise<StoredCatalog> {
  try {
    return JSON.parse(await readFile(catalogFile(), 'utf8')) as StoredCatalog;
  } catch {
    return {};
  }
}

async function writeStoredCatalog(stored: StoredCatalog): Promise<void> {
  await writeFile(catalogFile(), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}

function maskKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 4 ? '••••' : `••••${trimmed.slice(-4)}`;
}

function catalogStateFrom(stored: StoredCatalog): CatalogState {
  const providers = stored.providers ?? {};
  const connections: CatalogConnection[] = AI_CATALOG.map((entry) => {
    const saved = providers[entry.id];
    const fields: Record<string, string> = {};
    let maskedKey: string | null = null;
    for (const field of entry.credentials) {
      const value = asText(saved?.fields?.[field.key]);
      if (!value) continue;
      if (field.secret) maskedKey = maskKey(value);
      else fields[field.key] = value;
    }
    return {
      id: entry.id,
      connected: Boolean(saved && entry.credentials.every((f) => asText(saved.fields?.[f.key]))),
      maskedKey,
      fields,
      cooldownUntil: saved?.cooldownUntil ?? null,
    };
  });
  return { connections, freeOnly: stored.freeOnly ?? false };
}

function broadcastCatalog(state: CatalogState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('ai-catalog:state', state);
  }
}

function broadcastActiveModel(state: ActiveModelState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('ai-catalog:active-model', state);
  }
}

// Provedor bateu no limite: descansa 30 min. E o que faz o Edvid seguir para o
// proximo em vez de encerrar a geracao.
const CATALOG_COOLDOWN_MS = 30 * 60_000;

async function markCatalogCooldown(providerId: string): Promise<void> {
  const stored = await readStoredCatalog();
  const providers = stored.providers ?? {};
  const saved = providers[providerId];
  if (!saved) return;
  providers[providerId] = { ...saved, cooldownUntil: Date.now() + CATALOG_COOLDOWN_MS };
  await writeStoredCatalog({ ...stored, providers });
  broadcastCatalog(catalogStateFrom({ ...stored, providers }));
}

// Uma imagem, num provedor do catalogo. Cada formato tem seu jeito de pedir e
// de devolver os bytes; o resto do aplicativo so ve Buffer ou erro.
async function generateCatalogImage(
  choice: { providerId: string; modelId: string },
  credentials: Record<string, string>,
  prompt: string,
): Promise<Buffer> {
  if (choice.providerId === 'cloudflare') {
    const accountId = asText(credentials.accountId);
    const response = await net.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${choice.modelId}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, steps: 4 }),
      },
    );
    const payload = (await response.json().catch(() => null)) as
      | { result?: { image?: string }; errors?: { message?: string }[] }
      | null;
    if (!response.ok || !payload?.result?.image) {
      const detail = payload?.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new OpenRouterLikeError(detail, response.status);
    }
    return Buffer.from(payload.result.image, 'base64');
  }

  if (choice.providerId === 'openrouter') {
    const response = await net.fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: choice.modelId, prompt }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { b64_json?: string }[]; error?: { message?: string } }
      | null;
    const base64 = payload?.data?.[0]?.b64_json;
    if (!response.ok || !base64) {
      const detail = payload?.error?.message ?? `HTTP ${response.status}`;
      throw new OpenRouterLikeError(detail, response.status);
    }
    return Buffer.from(base64, 'base64');
  }

  throw new OpenRouterLikeError(`Provedor ${choice.providerId} não sabe gerar imagem.`, null);
}

class OpenRouterLikeError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

// Gera passando pela CADEIA do catalogo: o primeiro que responder entrega. Quem
// bater no limite entra em descanso e a vez passa adiante, com aviso no chat.
async function generateImageFromCatalog(prompt: string): Promise<Buffer | null> {
  const stored = await readStoredCatalog();
  const state = catalogStateFrom(stored);
  const connected = state.connections
    .filter((connection) => connection.connected)
    .map((connection) => ({ id: connection.id, cooldownUntil: connection.cooldownUntil }));
  if (connected.length === 0) return null;
  const candidates = routeCandidates({
    capability: 'imagem',
    connected,
    freeOnly: state.freeOnly,
    now: Date.now(),
  });
  let lastError: Error | null = null;
  for (const [index, choice] of candidates.entries()) {
    const credentials = stored.providers?.[choice.providerId]?.fields ?? {};
    broadcastActiveModel({
      role: 'image',
      providerId: choice.providerId,
      providerName: choice.providerName,
      modelLabel: choice.modelLabel,
      free: choice.free,
    });
    try {
      return await generateCatalogImage(choice, credentials, prompt);
    } catch (error) {
      const status = error instanceof OpenRouterLikeError ? error.status : null;
      const message = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(message);
      if (!shouldFailover(status, message) || index === candidates.length - 1) break;
      await markCatalogCooldown(choice.providerId);
      const next = candidates[index + 1];
      broadcastCodexEvent({
        type: 'error',
        message: `${choice.providerName} atingiu o limite. Continuando com ${next.providerName}.`,
      });
    }
  }
  if (lastError) throw lastError;
  return null;
}

// Procura um arquivo pelo NOME dentro do projeto (profundidade curta): rede de
// seguranca para quando a IA salva a imagem fora da pasta combinada.
async function findFileInProject(
  root: string,
  fileName: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 3) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === fileName) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const found = await findFileInProject(path.join(root, entry.name), fileName, depth + 1);
    if (found) return found;
  }
  return null;
}

// --- Geracao de imagens pedidas pelo agente --------------------------------
// O agente de chat escreve edit/imagens/pedidos.json; depois do turno o
// aplicativo gera cada imagem fora do sandbox com a IA de imagem do aluno
// (ChatGPT por assinatura via ferramenta do Codex, ou Gemini por chave) e
// salva em edit/imagens/. Mesmo padrao do render da Fase 2.

// "4:3" existe para a TELA DIVIDIDA: cada metade de um 9:16 e uma faixa larga
// (1080x960), entao uma imagem vertical 9:16 entra cortadissima — o aluno viu
// isso em uso real. A API de imagem nao tem 4:3 exato; 3:2 (1536x1024) e o
// vizinho mais proximo e o template ja enquadra por cover.
const IMAGE_ASPECTS = new Set(['9:16', '1:1', '16:9', '4:3']);
let imageGenJob: { directory: string; promise: Promise<ImageGenState> } | null = null;
let imageGenState: ImageGenState = { status: 'idle' };

function broadcastImageGenState(state: ImageGenState): void {
  imageGenState = state;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('image-gen:state', state);
  }
}

type ImageRequestEntry = { arquivo: string; prompt: string; proporcao: string | null };

// ChatGPT conectado por CHAVE tambem gera imagem — pela API de imagens da
// OpenAI (gpt-image-2, pago por imagem), chamada direta do app. A chave vive
// no auth.json que o proprio app-server guarda no CODEX_HOME do Edvid.
async function readCodexStoredApiKey(): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(app.getPath('userData'), 'codex', 'auth.json'), 'utf8'),
    ) as { OPENAI_API_KEY?: unknown };
    return typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY ? parsed.OPENAI_API_KEY : null;
  } catch {
    return null;
  }
}

const OPENAI_IMAGE_SIZES: Record<string, string> = {
  '9:16': '1024x1536',
  '16:9': '1536x1024',
  '1:1': '1024x1024',
  // Sem 4:3 nativo na API: 3:2 e o tamanho paisagem mais proximo.
  '4:3': '1536x1024',
};

async function generateOpenAiImage(
  apiKey: string,
  prompt: string,
  proporcao: string | null,
): Promise<Buffer> {
  const call = (size: string): Promise<Response> =>
    net.fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-image-2', prompt, size, quality: 'medium' }),
    });
  let response: Response;
  try {
    response = await call(OPENAI_IMAGE_SIZES[proporcao ?? '1:1'] ?? '1024x1024');
    // Formato de tamanho recusado (modelo mudou?): tenta o automatico.
    if (response.status === 400) response = await call('auto');
  } catch {
    throw new Error('Sem conexão para gerar a imagem na OpenAI.');
  }
  const payload = (await response.json().catch(() => ({}))) as {
    data?: Array<{ b64_json?: string }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `A OpenAI recusou a geração (HTTP ${response.status}).`);
  }
  const data = payload.data?.[0]?.b64_json;
  if (!data) throw new Error('A OpenAI respondeu sem imagem. Tente reformular o pedido.');
  return Buffer.from(data, 'base64');
}

async function readImageRequests(projectDirectory: string): Promise<ImageRequestEntry[]> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(projectDirectory, 'edit', 'imagens', 'pedidos.json'), 'utf8'),
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const item = entry as { arquivo?: unknown; prompt?: unknown; proporcao?: unknown };
      const prompt = asText(item.prompt).trim();
      // Nome sempre achatado para dentro de edit/imagens (nada de ../).
      let arquivo = path.basename(asText(item.arquivo).trim());
      if (!prompt || !arquivo || arquivo.startsWith('.')) return [];
      if (!/\.(png|jpg|jpeg|webp)$/iu.test(arquivo)) arquivo = `${arquivo}.png`;
      const proporcao = asText(item.proporcao).trim();
      return [{ arquivo, prompt, proporcao: IMAGE_ASPECTS.has(proporcao) ? proporcao : null }];
    });
  } catch {
    return [];
  }
}

function fulfillImageRequests(projectDirectory: string): Promise<ImageGenState> {
  if (imageGenJob?.directory === projectDirectory) return imageGenJob.promise;
  const job = (async (): Promise<ImageGenState> => {
    const imagesDirectory = path.join(projectDirectory, 'edit', 'imagens');
    const requestsFile = path.join(imagesDirectory, 'pedidos.json');
    const requests = await readImageRequests(projectDirectory);
    if (!requests.length) return imageGenState.status === 'generating' ? imageGenState : { status: 'idle' };

    const pending = [] as ImageRequestEntry[];
    for (const request of requests) {
      try {
        await stat(path.join(imagesDirectory, request.arquivo));
      } catch {
        pending.push(request);
      }
    }
    if (!pending.length) {
      await rm(requestsFile, { force: true });
      return { status: 'idle' };
    }

    const provider = aiRoles.image;
    // O catalogo tem prioridade sobre as contas fixas: e onde estao as opcoes
    // de camada gratuita, e a cadeia dele ja troca de provedor sozinha.
    const catalogState = catalogStateFrom(await readStoredCatalog());
    const catalogHasImage = catalogState.connections.some(
      (connection) => connection.connected
        && (catalogEntry(connection.id)?.capabilities.includes('imagem') ?? false),
    );
    if (!provider && !catalogHasImage) {
      broadcastCodexEvent({
        type: 'error',
        message: `A edição pediu ${pending.length === 1 ? 'uma imagem' : `${pending.length} imagens`}, mas nenhuma IA de imagem está conectada. Conecte uma IA em Configurações → Conexões (há opções com camada gratuita).`,
      });
      return { status: 'error', error: 'Nenhuma IA de imagem conectada.' };
    }

    const failures: string[] = [];
    let done = 0;
    broadcastImageGenState({ status: 'generating', total: pending.length, done });
    for (const request of pending) {
      const target = path.join(imagesDirectory, request.arquivo);
      try {
        const fromCatalog = catalogHasImage ? await generateImageFromCatalog(request.prompt) : null;
        if (fromCatalog) {
          await mkdir(imagesDirectory, { recursive: true });
          await writeFile(target, fromCatalog);
        } else if (provider === 'gemini') {
          const image = await (await geminiAgentReady()).generateImage(request.prompt, request.proporcao);
          await mkdir(imagesDirectory, { recursive: true });
          await writeFile(target, image);
        } else {
          // ChatGPT: assinatura usa a ferramenta do Codex (cota do plano);
          // chave de API usa a API de imagens direto (pago por imagem).
          const chatgptApiKey = await readCodexStoredApiKey();
          const codexAccount = await (await codexServer()).readAccount();
          if (codexAccount.account?.type === 'apiKey' && chatgptApiKey) {
            const image = await generateOpenAiImage(chatgptApiKey, request.prompt, request.proporcao);
            await mkdir(imagesDirectory, { recursive: true });
            await writeFile(target, image);
          } else {
            // A pasta e criada AQUI, fora do sandbox: no Windows criar
            // diretorio dentro do turno virava pedido de aprovacao — que a
            // thread utilitaria recusa sozinha — e a imagem nunca aparecia.
            await mkdir(imagesDirectory, { recursive: true });
            await (await codexServer()).runUtilityTurn(
              projectDirectory,
              [
                'Use a ferramenta de geração de imagens (skill imagegen) para gerar exatamente esta imagem:',
                request.prompt,
                request.proporcao ? `Proporção: ${request.proporcao}.` : '',
                // Caminho ABSOLUTO: relativo dependia do diretorio em que o
                // comando rodou, e no Windows (OneDrive, acento em "Área de
                // Trabalho") a imagem acabava fora do lugar esperado.
                `Salve o resultado EXATAMENTE neste caminho: ${target}`,
                'Não crie nem modifique nenhum outro arquivo.',
                'Responda com uma única frase curta.',
              ].filter(Boolean).join('\n'),
            );
            // O agente pode ter salvo com o nome certo em outro lugar do
            // projeto; procurar e trazer para cá custa nada e evita perder uma
            // imagem que JA foi paga na cota do aluno.
            try {
              await stat(target);
            } catch {
              const recovered = await findFileInProject(projectDirectory, request.arquivo);
              if (!recovered) throw new Error(`a IA não salvou ${request.arquivo} na pasta do projeto`);
              await copyFile(recovered, target);
            }
          }
        }
        done += 1;
        broadcastImageGenState({ status: 'generating', total: pending.length, done });
      } catch (error) {
        failures.push(`${request.arquivo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Pedidos atendidos saem da fila; os que falharam ficam para a proxima.
    const remaining = requests.filter((request) => failures.some((failure) => failure.startsWith(`${request.arquivo}:`)));
    if (remaining.length) {
      await writeFile(requestsFile, `${JSON.stringify(remaining, null, 2)}\n`).catch(() => {});
    } else {
      await rm(requestsFile, { force: true });
    }

    if (failures.length) {
      broadcastCodexEvent({
        type: 'error',
        message: `Não consegui gerar ${failures.length === 1 ? 'uma imagem' : `${failures.length} imagens`}: ${failures[0]}`,
      });
      return { status: 'error', total: pending.length, done, error: failures[0] };
    }
    return { status: 'ready', total: pending.length, done };
  })();
  const tracked = job.then((state) => {
    broadcastImageGenState(state);
    return state;
  }).finally(() => {
    if (imageGenJob?.promise === tracked) imageGenJob = null;
  });
  imageGenJob = { directory: projectDirectory, promise: tracked };
  return tracked;
}

// Valida a chave da OpenAI antes de entregar ao Codex: o app-server aceita
// qualquer texto sem checar, e o aluno so descobriria o erro no meio do turno.
async function validateOpenAiKey(apiKey: string): Promise<void> {
  let response: Response;
  try {
    response = await net.fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    throw new Error('Sem conexão para validar a chave. Tente de novo.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('Chave inválida. Confira na plataforma da OpenAI e cole de novo.');
  }
  if (!response.ok) {
    throw new Error(`A validação da chave falhou (HTTP ${response.status}). Tente de novo.`);
  }
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
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    embeddedNodeVersion: process.versions.node,
  }));

  ipcMain.handle('runtime:check', () =>
    Promise.all(runtimeCommands.map(({ name, args }) => {
      const resolution = resolveRuntime(name, appRuntimeContext());
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

  ipcMain.handle('project:select-directory', async (_event, input?: { name?: string }) => {
    const result = await dialog.showOpenDialog({
      title: 'Escolha a pasta do projeto de video',
      buttonLabel: 'Usar esta pasta',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || !result.filePaths[0]) return null;
    return openProject(result.filePaths[0], true, asText(input?.name));
  });

  ipcMain.handle('project:rename', async (_event, input: { directory?: string; name?: string }) => {
    const name = asText(input.name).slice(0, 60);
    if (!name) throw new Error('Escolha um nome para o projeto.');
    return mutateRecentProject(asText(input.directory), (project) => ({ ...project, name }));
  });

  ipcMain.handle('project:pin', (_event, input: { directory?: string; pinned?: boolean }) =>
    mutateRecentProject(asText(input.directory), (project) => ({
      ...project,
      pinned: Boolean(input.pinned),
    })));

  // Remove apenas da lista de recentes; a pasta do usuario fica intacta.
  ipcMain.handle('project:remove-recent', (_event, input: { directory?: string }) =>
    mutateRecentProject(asText(input.directory), () => null));

  ipcMain.handle('project:open-folder', async (_event, input: { directory?: string }) => {
    const requestedDirectory = path.resolve(asText(input.directory));
    const projects = await readRecentProjects();
    const known = selectedProjectDirectories.has(requestedDirectory) ||
      projects.some((project) => path.resolve(project.directory) === requestedDirectory);
    if (!known) throw new Error('Pasta desconhecida.');
    await shell.openPath(requestedDirectory);
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

  ipcMain.handle('codex:account', async () => (await codexServer()).readAccount());

  ipcMain.handle('codex:login', async () => {
    const login = await (await codexServer()).startChatGptLogin();
    const authUrl = new URL(login.authUrl);
    if (authUrl.protocol !== 'https:' || authUrl.origin !== 'https://auth.openai.com') {
      throw new Error('O Codex retornou um endereco de login inesperado.');
    }
    await shell.openExternal(login.authUrl);
    return login.state;
  });

  ipcMain.handle('codex:login-cancel', async () => (await codexServer()).cancelLogin());

  ipcMain.handle('codex:logout', async () => (await codexServer()).logout());

  ipcMain.handle('codex:message', async (_event, input: CodexSendMessageInput) => {
    const projectDirectory = asText(input.projectDirectory);
    const text = input.text?.trim();
    if (!projectDirectory) throw new Error('Escolha uma pasta de projeto.');
    const resolvedProjectDirectory = path.resolve(projectDirectory);
    if (!selectedProjectDirectories.has(resolvedProjectDirectory)) {
      throw new Error('Escolha a pasta do projeto pelo seletor do Edvid.');
    }
    if (!text) throw new Error('Escreva uma mensagem para o Edvid.');
    if (aiRoles.chat === 'claude') {
      return (await claudeAgentReady()).sendMessage(resolvedProjectDirectory, text);
    }
    if (aiRoles.chat === 'gemini') {
      return (await geminiAgentReady()).sendMessage(resolvedProjectDirectory, text);
    }
    return (await codexServer()).sendMessage(resolvedProjectDirectory, text);
  });

  ipcMain.handle(
    'codex:interrupt',
    async (_event, input: { threadId: string; turnId: string }) => {
      if (getClaudeAgent().ownsThread(asText(input.threadId))) {
        return getClaudeAgent().interrupt(input.threadId, input.turnId);
      }
      if (getGeminiAgent().ownsThread(asText(input.threadId))) {
        return getGeminiAgent().interrupt(input.threadId, input.turnId);
      }
      return (await codexServer()).interrupt(input.threadId, input.turnId);
    },
  );

  ipcMain.handle(
    'codex:approval',
    async (
      _event,
      input: { approvalId: string | number; decision: CodexApprovalDecision },
    ) => {
      if (getClaudeAgent().ownsApproval(input.approvalId)) {
        return getClaudeAgent().respondToApproval(input.approvalId, input.decision);
      }
      if (getGeminiAgent().ownsApproval(input.approvalId)) {
        return getGeminiAgent().respondToApproval(input.approvalId, input.decision);
      }
      return (await codexServer()).respondToApproval(input.approvalId, input.decision);
    },
  );

  ipcMain.handle('ai:roles-get', () => aiRoles);

  ipcMain.handle(
    'ai:role-set',
    (_event, input: { role?: unknown; provider?: unknown; pinned?: unknown }) => {
      const role = input.role === 'image' ? 'image' : 'chat';
      const provider =
        typeof input.provider === 'string' && AI_PROVIDERS.has(input.provider)
          ? (input.provider as AiProvider)
          : null;
      return setAiRole(role, provider, input.pinned === true);
    },
  );

  ipcMain.handle('image:fulfill', (_event, input: { directory?: string }) => {
    const directory = path.resolve(asText(input.directory));
    if (!selectedProjectDirectories.has(directory)) {
      throw new Error('Escolha a pasta do projeto pelo seletor do Edvid.');
    }
    return fulfillImageRequests(directory);
  });

  ipcMain.handle('jcut:apply', (_event, input: { directory?: string }) => {
    const directory = path.resolve(asText(input.directory));
    if (!selectedProjectDirectories.has(directory)) {
      throw new Error('Escolha a pasta do projeto pelo seletor do Edvid.');
    }
    return applyJcutToProject(directory);
  });

  ipcMain.handle('jcut:sync', (_event, input: { directory?: string }) => {
    const directory = path.resolve(asText(input.directory));
    if (!selectedProjectDirectories.has(directory)) {
      throw new Error('Escolha a pasta do projeto pelo seletor do Edvid.');
    }
    return syncJcutForProject(directory);
  });

  ipcMain.handle('animations:pending-custom', (_event, input: { directory?: string }) => {
    const directory = path.resolve(asText(input.directory));
    if (!selectedProjectDirectories.has(directory)) {
      throw new Error('Escolha a pasta do projeto pelo seletor do Edvid.');
    }
    return pendingCustomAnimations(directory);
  });

  ipcMain.handle('claude:account', () => getClaudeAgent().readAccount());

  ipcMain.handle('claude:login', async () => {
    const login = await getClaudeAgent().startLogin();
    const authUrl = new URL(login.authUrl);
    // claude.com/cai e o authorize atual de contas Claude.ai (CLI 2.1.x).
    if (authUrl.protocol !== 'https:' || authUrl.origin !== 'https://claude.com') {
      throw new Error('Endereço de login do Claude inesperado.');
    }
    await shell.openExternal(login.authUrl);
    return login.state;
  });

  ipcMain.handle('claude:login-code', (_event, input: { code?: string }) =>
    getClaudeAgent().submitLoginCode(asText(input.code)));

  ipcMain.handle('claude:login-cancel', () => getClaudeAgent().cancelLogin());

  ipcMain.handle('claude:logout', () => getClaudeAgent().logout());

  ipcMain.handle('claude:connect-key', (_event, input: { apiKey?: string }) =>
    getClaudeAgent().connectApiKey(asText(input.apiKey)));

  ipcMain.handle('codex:login-api-key', async (_event, input: { apiKey?: string }) => {
    const apiKey = asText(input.apiKey).trim();
    if (!apiKey) throw new Error('Cole a chave de API da OpenAI.');
    await validateOpenAiKey(apiKey);
    return (await codexServer()).startApiKeyLogin(apiKey);
  });

  ipcMain.handle('gemini:account', () => getGeminiAgent().readAccount());

  ipcMain.handle('gemini:connect-key', (_event, input: { apiKey?: string }) =>
    getGeminiAgent().connectApiKey(asText(input.apiKey)));

  ipcMain.handle('gemini:disconnect', () => getGeminiAgent().disconnect());

  ipcMain.handle('ai-catalog:read', async () => catalogStateFrom(await readStoredCatalog()));

  ipcMain.handle(
    'ai-catalog:connect',
    async (_event, input: { id?: string; fields?: Record<string, string> }) => {
      const entry = catalogEntry(asText(input.id));
      if (!entry) throw new Error('Provedor desconhecido.');
      const fields: Record<string, string> = {};
      for (const field of entry.credentials) {
        const value = asText(input.fields?.[field.key]);
        if (!value) throw new Error(`Preencha ${field.label}.`);
        fields[field.key] = value;
      }
      const stored = await readStoredCatalog();
      const providers = { ...(stored.providers ?? {}), [entry.id]: { fields, cooldownUntil: null } };
      const next = { ...stored, providers };
      await writeStoredCatalog(next);
      const state = catalogStateFrom(next);
      broadcastCatalog(state);
      return state;
    },
  );

  ipcMain.handle('ai-catalog:disconnect', async (_event, input: { id?: string }) => {
    const stored = await readStoredCatalog();
    const providers = { ...(stored.providers ?? {}) };
    delete providers[asText(input.id)];
    const next = { ...stored, providers };
    await writeStoredCatalog(next);
    const state = catalogStateFrom(next);
    broadcastCatalog(state);
    return state;
  });

  // Testa a credencial contra a API do provedor ANTES de salvar. Uma chamada
  // barata que devolve "ok" ou o motivo — melhor que o aluno descobrir que
  // colou errado só quando a edição precisar da imagem.
  ipcMain.handle(
    'ai-catalog:test',
    async (_event, input: { id?: string; fields?: Record<string, string> }) => {
      const entry = catalogEntry(asText(input.id));
      if (!entry) return { ok: false, detail: 'Provedor desconhecido.' };
      const fields = input.fields ?? {};
      const apiKey = asText(fields.apiKey);
      if (!apiKey) return { ok: false, detail: 'Informe a chave.' };
      try {
        if (entry.id === 'cloudflare') {
          const accountId = asText(fields.accountId);
          if (!accountId) return { ok: false, detail: 'Informe o Account ID.' };
          const response = await net.fetch(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?per_page=1`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
          );
          if (response.ok) return { ok: true, detail: 'Chave e Account ID válidos.' };
          return {
            ok: false,
            detail: response.status === 403 || response.status === 401
              ? 'Chave ou Account ID recusados pela Cloudflare.'
              : `A Cloudflare respondeu HTTP ${response.status}.`,
          };
        }
        const url = entry.id === 'ollama'
          ? 'https://ollama.com/api/tags'
          : 'https://openrouter.ai/api/v1/key';
        const response = await net.fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (response.ok) return { ok: true, detail: 'Chave válida.' };
        return {
          ok: false,
          detail: response.status === 401 ? 'Chave recusada pelo provedor.' : `O provedor respondeu HTTP ${response.status}.`,
        };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : 'Falha ao falar com o provedor.' };
      }
    },
  );

  ipcMain.handle('ai-catalog:free-only', async (_event, input: { freeOnly?: boolean }) => {
    const stored = await readStoredCatalog();
    const next = { ...stored, freeOnly: Boolean(input.freeOnly) };
    await writeStoredCatalog(next);
    const state = catalogStateFrom(next);
    broadcastCatalog(state);
    return state;
  });

  ipcMain.handle('runtime-pack:ensure', () => ensureRuntimePack());
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
  if (!app.isPackaged || !UPDATE_FEED_URL) return;
  try {
    if (process.platform === 'darwin') {
      autoUpdater.setFeedURL({ url: UPDATE_FEED_URL, serverType: 'json' });
    } else if (process.platform === 'win32') {
      // Squirrel.Windows espera a PASTA que contem RELEASES + os .nupkg
      // (publish-update.mjs envia tudo sob win32/ no mesmo bucket).
      autoUpdater.setFeedURL({ url: `${UPDATE_FEED_URL.replace(/\/feed\.json$/u, '')}/win32` });
    } else {
      return;
    }
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

// Procura atualizacao sob demanda (Configuracoes → Geral). O app ja checa no
// boot; este botao existe para quem quer conferir na hora. Em desenvolvimento
// o autoUpdater nao roda, entao devolve o estado atual sem tentar.
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return appUpdateState;
  try {
    autoUpdater.checkForUpdates();
    // O resultado chega pelos eventos do autoUpdater; espera curta para o
    // caso comum de "ja esta atualizado" responder na mesma interacao.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  } catch {
    // Sem rede ou canal indisponivel: o estado atual ja diz o que da.
  }
  return appUpdateState;
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
  // O download do pacote de ferramentas comeca imediatamente, antes mesmo do
  // login: no primeiro boot ele e o caminho critico de tudo.
  void ensureRuntimePack();
  // Provedor de IA escolhido e, para provedores ja conectados, o motor fica
  // pronto em segundo plano antes da primeira mensagem.
  void loadAppSettings().then(async () => {
    const [claudeAccount, geminiAccount] = await Promise.all([
      getClaudeAgent().readAccount(),
      getGeminiAgent().readAccount(),
    ]);
    if (claudeAccount.status !== 'signed-in' && geminiAccount.status !== 'signed-in') return;
    await requireRuntimePack().catch(() => {});
    if (claudeAccount.status === 'signed-in') void getClaudeAgent().ensureRuntime().catch(() => {});
    if (geminiAccount.status === 'signed-in') void getGeminiAgent().ensureRuntime().catch(() => {});
  });
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
  claudeAgent?.stop();
  geminiAgent?.stop();
});
