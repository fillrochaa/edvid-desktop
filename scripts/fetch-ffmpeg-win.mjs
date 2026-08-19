// FFmpeg principal do Windows: no macOS o Edvid compila da fonte (GPL +
// libx264 estatico); no Windows usamos o autobuild BtbN equivalente (mesma
// configuracao GPL + libx264, estatico), pinado por TAG DATADA e sha256 do
// checksums.sha256 oficial do release — o mesmo padrao de pin do
// codex-app-server. A tag "latest" muda todo dia; a datada e imutavel.
//
// Saida (identica ao build darwin): resources/runtimes/win32-x64/ffmpeg/
//   bin/ffmpeg.exe + bin/ffprobe.exe, licenses/ e build-metadata.json.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const ffmpegVersion = manifest.runtimes.ffmpeg.version;
const target = 'win32-x64';

// Pin imutavel do autobuild BtbN (branch n8.1, versao base 8.1.2 = manifest).
const BTBN_TAG = 'autobuild-2026-08-18-15-03';
const BTBN_ASSET = 'ffmpeg-n8.1.2-44-g7c533d0f86-win64-gpl-8.1.zip';
const BTBN_SHA256 = '66e3797adad33063ae3f55c7eacb9f1bff604322a4e50225039626230fd0c0d1';
const BTBN_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}/${BTBN_ASSET}`;

if (!BTBN_ASSET.includes(`n${ffmpegVersion}`)) {
  throw new Error(
    `O pin BtbN (${BTBN_ASSET}) nao corresponde a versao ${ffmpegVersion} do manifest. Atualize o pin junto com o manifest.`,
  );
}

const runtimeDestination = path.join(desktopRoot, 'resources', 'runtimes', target, 'ffmpeg');
const metadataPath = path.join(runtimeDestination, 'build-metadata.json');

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

if (await exists(metadataPath)) {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (metadata.archiveSha256 === BTBN_SHA256 && (await exists(path.join(runtimeDestination, 'bin', 'ffmpeg.exe')))) {
      console.log(`FFmpeg ${ffmpegVersion} (BtbN) ja esta preparado para ${target}.`);
      process.exit(0);
    }
  } catch {
    // Refaz o stage.
  }
}

const workDirectory = await mkdtemp(path.join(tmpdir(), 'edvid-ffmpeg-win-'));
try {
  const archivePath = path.join(workDirectory, BTBN_ASSET);
  console.log(`Baixando ${BTBN_ASSET}...`);
  const response = await fetch(BTBN_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Download do FFmpeg BtbN falhou (HTTP ${response.status}).`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath));

  const digest = await sha256(archivePath);
  if (digest !== BTBN_SHA256) {
    throw new Error(`sha256 divergente do pin BtbN: ${digest}`);
  }

  // bsdtar (macOS e Windows 10+) extrai zip.
  const extracted = path.join(workDirectory, 'extracted');
  await mkdir(extracted, { recursive: true });
  const result = spawnSync('tar', ['-xf', archivePath, '-C', extracted], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Extracao do FFmpeg BtbN falhou (${result.status}).`);

  const [rootEntry] = await readdir(extracted);
  const archiveRoot = path.join(extracted, rootEntry);
  const builtFfmpeg = path.join(archiveRoot, 'bin', 'ffmpeg.exe');
  const builtFfprobe = path.join(archiveRoot, 'bin', 'ffprobe.exe');
  if (!(await exists(builtFfmpeg)) || !(await exists(builtFfprobe))) {
    throw new Error('ffmpeg.exe/ffprobe.exe ausentes no zip BtbN.');
  }

  await rm(runtimeDestination, { recursive: true, force: true });
  await mkdir(path.join(runtimeDestination, 'bin'), { recursive: true });
  await cp(builtFfmpeg, path.join(runtimeDestination, 'bin', 'ffmpeg.exe'));
  await cp(builtFfprobe, path.join(runtimeDestination, 'bin', 'ffprobe.exe'));

  const licenseDestination = path.join(runtimeDestination, 'licenses');
  await mkdir(licenseDestination, { recursive: true });
  const licenseSource = path.join(archiveRoot, 'LICENSE.txt');
  if (await exists(licenseSource)) {
    await cp(licenseSource, path.join(licenseDestination, 'LICENSE.txt'));
  }

  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        target,
        version: ffmpegVersion,
        distribution: 'btbn-autobuild-win64-gpl-pinned-sha256',
        license: 'GPL-2.0-or-later (build com libx264)',
        archiveTag: BTBN_TAG,
        archiveName: BTBN_ASSET,
        archiveUrl: BTBN_URL,
        archiveSha256: BTBN_SHA256,
        ffmpegExeSha256: await sha256(path.join(runtimeDestination, 'bin', 'ffmpeg.exe')),
        ffprobeExeSha256: await sha256(path.join(runtimeDestination, 'bin', 'ffprobe.exe')),
        stagedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`FFmpeg ${ffmpegVersion} (BtbN win64-gpl) preparado em resources/runtimes/${target}/ffmpeg.`);
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
