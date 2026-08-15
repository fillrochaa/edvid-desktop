import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  await readFile(path.join(desktopRoot, 'resources/runtime-manifest.json'), 'utf8'),
);
const runtime = manifest.runtimes['codex-app-server'];
const version = runtime.version;
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const artifact = runtime.artifacts[target];

if (!artifact) {
  throw new Error(`Target sem distribuicao Codex App Server configurada: ${target}`);
}

const releaseBaseUrl = `https://github.com/openai/codex/releases/download/rust-v${version}`;
const cacheDirectory = path.join(desktopRoot, '.runtime-cache', 'codex-app-server', version);
const archivePath = path.join(cacheDirectory, artifact.name);
const licensePath = path.join(cacheDirectory, 'LICENSE');
const destination = path.join(
  desktopRoot,
  'resources',
  'runtimes',
  target,
  'codex-app-server',
);
const executableName = target.startsWith('win32-') ? 'codex-app-server.exe' : 'codex-app-server';

await mkdir(cacheDirectory, { recursive: true });

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function download(url, output) {
  const partial = `${output}.part`;
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await rm(partial, { force: true });
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || !response.body) {
        throw new Error(`Download falhou (${response.status}): ${url}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await rename(partial, output);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`Tentativa ${attempt} falhou; repetindo download...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  await rm(partial, { force: true });
  throw lastError;
}

async function ensurePinnedDownload(url, output, expectedHash, label) {
  let actualHash = (await exists(output)) ? await sha256(output) : null;
  if (actualHash !== expectedHash) {
    await rm(output, { force: true });
    console.log(`Baixando ${label}...`);
    await download(url, output);
    actualHash = await sha256(output);
  }
  if (actualHash !== expectedHash) {
    await rm(output, { force: true });
    throw new Error(`Checksum invalido para ${label}.`);
  }
  return actualHash;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout}\n${result.stderr}` : '';
    throw new Error(`${command} terminou com codigo ${result.status}.${detail}`);
  }
  return result.stdout ?? '';
}

async function findExecutable(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const match = entries.find(
    (entry) =>
      entry.isFile() &&
      entry.name.startsWith('codex-app-server-') &&
      (target.startsWith('win32-') ? entry.name.endsWith('.exe') : !entry.name.endsWith('.exe')),
  );
  if (!match) throw new Error(`Executavel ${executableName} ausente em ${artifact.name}.`);
  return path.join(match.parentPath ?? match.path, match.name);
}

async function validateMacDependencies(executable) {
  if (!target.startsWith('darwin-')) return [];
  const output = run('otool', ['-L', executable], { capture: true });
  const dependencies = output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean);
  const invalid = dependencies.filter(
    (dependency) =>
      !dependency.startsWith('/usr/lib/') &&
      !dependency.startsWith('/System/Library/'),
  );
  if (invalid.length > 0) {
    throw new Error(`Dependencias Codex nao portaveis: ${invalid.join(', ')}`);
  }
  return dependencies;
}

const archiveHash = await ensurePinnedDownload(
  `${releaseBaseUrl}/${artifact.name}`,
  archivePath,
  artifact.sha256,
  `Codex App Server ${version} para ${target}`,
);
await ensurePinnedDownload(
  `https://raw.githubusercontent.com/openai/codex/${runtime.sourceCommit}/LICENSE`,
  licensePath,
  runtime.licenseSha256,
  'licenca do Codex',
);

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'edvid-codex-'));
try {
  run('tar', ['-xf', archivePath, '-C', temporaryDirectory]);
  const extractedExecutable = await findExecutable(temporaryDirectory);
  if (!target.startsWith('win32-')) await chmod(extractedExecutable, 0o755);

  const versionOutput = run(extractedExecutable, ['--version'], { capture: true }).trim();
  if (!versionOutput.includes(version)) {
    throw new Error(`Versao Codex inesperada: ${versionOutput || '(sem resposta)'}`);
  }
  const dynamicLibraries = await validateMacDependencies(extractedExecutable);

  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, 'bin'), { recursive: true });
  await mkdir(path.join(destination, 'licenses'), { recursive: true });
  const stagedExecutable = path.join(destination, 'bin', executableName);
  await cp(extractedExecutable, stagedExecutable);
  await cp(licensePath, path.join(destination, 'licenses', 'LICENSE'));
  if (!target.startsWith('win32-')) await chmod(stagedExecutable, 0o755);

  await writeFile(
    path.join(destination, 'build-metadata.json'),
    `${JSON.stringify(
      {
        target,
        version,
        distribution: runtime.distribution,
        sourceCommit: runtime.sourceCommit,
        artifactUrl: `${releaseBaseUrl}/${artifact.name}`,
        archiveSha256: archiveHash,
        binarySha256: await sha256(stagedExecutable),
        licenseSha256: await sha256(licensePath),
        versionOutput,
        dynamicLibraries,
        stagedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(
  `Codex App Server ${version} preparado em resources/runtimes/${target}/codex-app-server`,
);
