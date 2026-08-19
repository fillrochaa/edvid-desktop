import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  await readFile(path.join(desktopRoot, 'resources/runtime-manifest.json'), 'utf8'),
);
const version = manifest.runtimes.whisperx.sharedFfmpegVersion;
const target = `${process.platform}-${process.arch}`;
const supportedTarget = 'darwin-arm64';
const deploymentTarget = '12.0';
const jobs = String(Math.min(8, availableParallelism()));
const cacheRoot = path.join(
  desktopRoot,
  '.runtime-cache',
  'ffmpeg-torchcodec',
  version,
);
const source = path.join(cacheRoot, 'source');
const sourceMetadataPath = path.join(cacheRoot, 'source-metadata.json');
const buildRoot = path.join(cacheRoot, 'build', target);
const buildDirectory = path.join(buildRoot, 'ffmpeg');
const prefix = path.join(buildRoot, 'install');
const metadataPath = path.join(prefix, 'build-metadata.json');

// darwin-arm64 compila abaixo; win32-x64 compila via MSYS2 mais adiante
// (depois das funcoes utilitarias). Outros targets nao tem implementacao.
if (target !== supportedTarget && target !== 'win32-x64') {
  throw new Error(
    `O FFmpeg compartilhado do TorchCodec esta implementado para ${supportedTarget} e win32-x64; atual: ${target}.`,
  );
}

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

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout}\n${result.stderr}` : '';
    throw new Error(`${command} terminou com codigo ${result.status}.${detail}`);
  }
  return result.stdout ?? '';
}

const expectedLibraries = [
  'libavcodec.61.dylib',
  'libavdevice.61.dylib',
  'libavfilter.10.dylib',
  'libavformat.61.dylib',
  'libavutil.59.dylib',
  'libswresample.5.dylib',
  'libswscale.8.dylib',
];

async function validateLibraries(libraryDirectory) {
  const result = {};
  for (const libraryName of expectedLibraries) {
    const libraryPath = path.join(libraryDirectory, libraryName);
    if (!(await exists(libraryPath))) {
      throw new Error(`Biblioteca FFmpeg para TorchCodec ausente: ${libraryName}`);
    }
    const output = run('otool', ['-L', libraryPath], { capture: true });
    const linkedEntries = output
      .split(/\r?\n/u)
      .slice(1)
      .map((line) => line.trim().split(/\s+/u)[0])
      .filter(Boolean);
    const installId = linkedEntries[0];
    if (installId !== `@rpath/${libraryName}`) {
      throw new Error(`Install ID nao portavel em ${libraryName}: ${installId}`);
    }
    const dependencies = linkedEntries.slice(1);
    const invalid = dependencies.filter(
      (dependency) =>
        dependency.startsWith('/opt/homebrew/') ||
        dependency.startsWith('/usr/local/'),
    );
    if (invalid.length > 0) {
      throw new Error(`Dependencias nao portaveis em ${libraryName}: ${invalid.join(', ')}`);
    }
    result[libraryName] = {
      sha256: await sha256(libraryPath),
      dependencies,
    };
  }
  return result;
}

if (!(await exists(path.join(source, 'configure')))) {
  throw new Error('Fonte FFmpeg 7 ausente. Execute `npm run build:ffmpeg:torchcodec`.');
}
const sourceMetadata = JSON.parse(await readFile(sourceMetadataPath, 'utf8'));
if (!sourceMetadata.signatureVerified || sourceMetadata.version !== version) {
  throw new Error('O fonte FFmpeg 7 nao possui a assinatura GPG esperada.');
}

// --- Windows: compila as DLLs da MESMA fonte verificada, via MSYS2 ---------
// O runner windows-latest do GitHub ja traz o MSYS2 em C:\msys64; localmente
// instale MSYS2 e rode: pacman -S --noconfirm mingw-w64-x86_64-toolchain make
// (EDVID_MSYS2_BASH aponta para outro bash se preciso). O mingw poe as DLLs
// em bin/ (avcodec-61.dll...) e os import libs em lib/.
if (target === 'win32-x64') {
  const expectedDlls = [
    'avcodec-61.dll',
    'avdevice-61.dll',
    'avfilter-10.dll',
    'avformat-61.dll',
    'avutil-59.dll',
    'swresample-5.dll',
    'swscale-8.dll',
  ];
  const dllDirectory = path.join(prefix, 'bin');
  // Sobe quando o modo de build muda (flags, runtime dlls): o .runtime-cache
  // e cacheado no CI e sem isso um build antigo nunca seria refeito.
  const winBuildRevision = 2;

  const dllsPresent = async () => {
    for (const name of expectedDlls) {
      if (!(await exists(path.join(dllDirectory, name)))) return false;
    }
    return true;
  };

  if (await exists(metadataPath)) {
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (
        metadata.target === target &&
        metadata.version === version &&
        metadata.winBuildRevision === winBuildRevision &&
        (await dllsPresent())
      ) {
        console.log(`FFmpeg compartilhado ${version} ja esta preparado para o TorchCodec (win32).`);
        process.exit(0);
      }
    } catch {
      // Refaz o build.
    }
  }

  const bash = process.env.EDVID_MSYS2_BASH || 'C:\\msys64\\usr\\bin\\bash.exe';
  if (!(await exists(bash))) {
    throw new Error(
      `MSYS2 nao encontrado (${bash}). Instale o MSYS2 com mingw-w64-x86_64-toolchain e make, ou defina EDVID_MSYS2_BASH.`,
    );
  }
  const msysEnvironment = {
    ...process.env,
    MSYSTEM: 'MINGW64',
    CHERE_INVOKING: '1',
    MSYS2_PATH_TYPE: 'inherit',
  };
  const posix = (value) => value.replaceAll('\\', '/');
  const runBash = (script, cwd) =>
    run(bash, ['-lc', script], { cwd, env: msysEnvironment });

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildDirectory, { recursive: true });

  const winConfigureFlags = [
    `--prefix=${posix(prefix)}`,
    '--arch=x86_64',
    '--target-os=mingw32',
    '--disable-autodetect',
    '--disable-debug',
    '--disable-doc',
    '--disable-programs',
    '--disable-static',
    '--enable-shared',
    '--disable-postproc',
    '--disable-network',
    // Sem isso as DLLs dependem de libgcc_s_seh-1.dll do mingw e o
    // libtorchcodec nao consegue carrega-las fora do MSYS2.
    '--extra-ldflags=-static-libgcc',
  ];
  runBash(
    `"${posix(source)}/configure" ${winConfigureFlags.map((flag) => `"${flag}"`).join(' ')}`,
    buildDirectory,
  );
  runBash(`make -j${jobs}`, buildDirectory);
  runBash('make install', buildDirectory);

  // Runtime do mingw de que as DLLs dependem (pthreads). Copiado para o
  // MESMO diretorio: o stage-python leva todos os .dll de bin/ juntos.
  const mingwRuntime = path.dirname(bash).replace(/usr[\\/]bin$/u, path.join('mingw64', 'bin'));
  for (const runtimeDll of ['libwinpthread-1.dll', 'libgcc_s_seh-1.dll']) {
    const sourceDll = path.join(mingwRuntime, runtimeDll);
    if (await exists(sourceDll)) {
      await cp(sourceDll, path.join(dllDirectory, runtimeDll));
    }
  }

  const libraries = {};
  for (const name of expectedDlls) {
    const dllPath = path.join(dllDirectory, name);
    if (!(await exists(dllPath))) {
      throw new Error(`Biblioteca FFmpeg para TorchCodec ausente: ${name}`);
    }
    libraries[name] = { sha256: await sha256(dllPath) };
  }

  const licenseDirectory = path.join(prefix, 'licenses');
  await mkdir(licenseDirectory, { recursive: true });
  for (const license of ['LICENSE.md', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3']) {
    await cp(path.join(source, license), path.join(licenseDirectory, license));
  }

  const installedFiles = (await readdir(dllDirectory))
    .filter((name) => name.endsWith('.dll'))
    .sort();
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        target,
        version,
        winBuildRevision,
        purpose: 'TorchCodec shared-library ABI compatibility',
        license: 'LGPL-2.1-or-later',
        sourceUrl: sourceMetadata.archiveUrl,
        sourceSha256: sourceMetadata.sha256,
        signatureFingerprint: sourceMetadata.signingFingerprint,
        configureFlags: winConfigureFlags,
        installedFiles,
        libraries,
        toolchain: run(bash, ['-lc', 'gcc --version'], {
          capture: true,
          env: msysEnvironment,
        }).split(/\r?\n/u)[0],
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`FFmpeg compartilhado ${version} (win32, MSYS2) preparado em ${prefix}.`);
  process.exit(0);
}

if (await exists(metadataPath)) {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (metadata.target === target && metadata.version === version) {
      await validateLibraries(path.join(prefix, 'lib'));
      console.log(`FFmpeg compartilhado ${version} ja esta preparado para o TorchCodec.`);
      process.exit(0);
    }
  } catch (error) {
    console.warn(`Build compartilhado existente sera refeito: ${error.message}`);
  }
}

await rm(buildRoot, { recursive: true, force: true });
await mkdir(buildDirectory, { recursive: true });

const buildEnvironment = {
  ...process.env,
  CC: '/usr/bin/clang',
  MACOSX_DEPLOYMENT_TARGET: deploymentTarget,
};
const configureFlags = [
  `--prefix=${prefix}`,
  '--cc=/usr/bin/clang',
  '--arch=arm64',
  '--target-os=darwin',
  '--disable-autodetect',
  '--disable-debug',
  '--disable-doc',
  '--disable-programs',
  '--disable-static',
  '--enable-shared',
  '--enable-pic',
  '--enable-pthreads',
  '--enable-zlib',
  '--enable-iconv',
  '--extra-libs=-liconv',
  '--disable-postproc',
  '--disable-network',
  '--install-name-dir=@rpath',
  `--extra-cflags=-mmacosx-version-min=${deploymentTarget}`,
  `--extra-ldflags=-mmacosx-version-min=${deploymentTarget}`,
];

run(path.join(source, 'configure'), configureFlags, {
  cwd: buildDirectory,
  env: buildEnvironment,
});
run('make', [`-j${jobs}`], { cwd: buildDirectory, env: buildEnvironment });
run('make', ['install'], { cwd: buildDirectory, env: buildEnvironment });

const libraries = await validateLibraries(path.join(prefix, 'lib'));
const licenseDirectory = path.join(prefix, 'licenses');
await mkdir(licenseDirectory, { recursive: true });
for (const license of ['LICENSE.md', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3']) {
  await cp(path.join(source, license), path.join(licenseDirectory, license));
}

const installedFiles = (await readdir(path.join(prefix, 'lib')))
  .filter((name) => name.endsWith('.dylib'))
  .sort();
await writeFile(
  metadataPath,
  `${JSON.stringify(
    {
      target,
      version,
      purpose: 'TorchCodec shared-library ABI compatibility',
      license: 'LGPL-2.1-or-later',
      sourceUrl: sourceMetadata.archiveUrl,
      sourceSha256: sourceMetadata.sha256,
      signatureFingerprint: sourceMetadata.signingFingerprint,
      configureFlags,
      installedFiles,
      libraries,
      toolchain: run('/usr/bin/clang', ['--version'], { capture: true })
        .split(/\r?\n/u)[0],
      macosDeploymentTarget: deploymentTarget,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`FFmpeg compartilhado ${version} preparado em ${prefix}.`);
