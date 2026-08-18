// Renderiza as thumbnails da aba Estilos com o PROPRIO template do Remotion:
// um still por estilo de headline (4) e de legenda (6), com o accent padrao
// #ff5200, backdrop sintetico e legendas geradas pelos helpers oficiais.
// O resultado (webp recortado) vai para src/brand/thumbs e entra no bundle.
//
// Requisitos: runtime do Remotion instalado (userData/runtime/remotion) e o
// FFmpeg staged em resources/runtimes. Roda na maquina de desenvolvimento:
//   node scripts/render-style-thumbs.mjs
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformKey = `${process.platform}-${process.arch}`;
const ffmpeg = path.join(projectRoot, 'resources', 'runtimes', platformKey, 'ffmpeg', 'bin', 'ffmpeg');
const python = path.join(projectRoot, 'resources', 'runtimes', platformKey, 'python-whisperx', 'python', 'bin', 'python3.12');
const helpers = path.join(projectRoot, 'resources', 'helpers');
const runtimeNode = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Edvid', 'runtime', 'remotion', 'node_modules',
);

const work = path.join(projectRoot, 'out', 'style-thumbs');
const stills = path.join(work, 'stills');
const thumbsOut = path.join(projectRoot, 'src', 'brand', 'thumbs');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    console.error(`Falhou: ${path.basename(command)} ${args.slice(0, 3).join(' ')}...`);
    process.exit(result.status ?? 1);
  }
}

// 1. Projeto de trabalho: template + node_modules do runtime compartilhado.
await rm(work, { recursive: true, force: true });
await mkdir(stills, { recursive: true });
const template = path.join(projectRoot, 'resources', 'remotion-template');
for (const entry of ['src', 'remotion.config.ts', 'tsconfig.json', 'package.json', 'public']) {
  await cp(path.join(template, entry), path.join(work, entry), { recursive: true });
}
await symlink(runtimeNode, path.join(work, 'node_modules'), 'dir');
// Fontes reais: o runtime guarda o fonts.css v2 (data URIs).
await cp(
  path.join(path.dirname(runtimeNode), 'fonts'),
  path.join(work, 'public', 'fonts'),
  { recursive: true, force: true },
);

// 2. Backdrop sintetico: gradiente escuro vertical, sem video de terceiros.
run(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'gradients=s=1080x1920:c0=0x232b36:c1=0x0a0d12:x0=540:y0=0:x1=540:y1=1920:d=10:r=30',
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
  '-t', '10', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', path.join(work, 'public', 'cut.mp4'),
]);

// 3. Legendas de amostra pelos MESMOS geradores oficiais da Fase 2.
const words = [
  ['É', 0.9, 1.05], ['assim', 1.05, 1.45], ['que', 1.45, 1.6], ['a', 1.6, 1.7],
  ['sua', 1.7, 2.0], ['legenda', 2.0, 2.55], ['aparece', 2.55, 3.15],
  ['no', 3.4, 3.55], ['seu', 3.55, 3.8], ['vídeo', 3.8, 4.35],
  ['com', 4.6, 4.8], ['o', 4.8, 4.9], ['estilo', 4.9, 5.4], ['escolhido', 5.4, 6.1],
];
await writeFile(
  path.join(work, 'transcript.json'),
  JSON.stringify({ words: words.map(([text, start, end]) => ({ text, start, end })) }),
);
run(python, ['-B', path.join(helpers, 'captions_for_remotion.py'), '--transcript', 'transcript.json', '-o', 'public/captions.json'], { cwd: work });
run(python, ['-B', path.join(helpers, 'caption_style.py'), '--transcript', 'transcript.json', '-o', 'public/caption-cues.json', '--lang', 'pt'], { cwd: work });

// 4. Um still por estilo. O edit-data muda entre stills, entao cada um
// re-bundla — e o preco de importar public/ estaticamente.
const base = JSON.parse(await readFile(path.join(template, 'public', 'edit-data.json'), 'utf8'));
const still = (name, frame, editData) =>
  ({ name, frame, editData: { ...base, fps: 30, durationSec: 10, camera: { ...base.camera, enabled: false }, ...editData } });

const HOOK = {
  enabled: true,
  endSec: 4,
  accent: '#ff5200',
  lines: ['Este é o seu', 'novo headline'],
  logo: null,
  sign: null,
};
const CAPTIONS = { enabled: true, fontSize: 61, maxWords: 3, safeWidth: 720, paddingBottom: 420, accent: '#ff5200' };

const jobs = [
  ...['outline', 'card', 'realce', 'misto'].map((styleName) => still(
    `headline-${styleName}`, 66,
    { hook: { ...HOOK, style: styleName }, captions: { ...CAPTIONS, enabled: false } },
  )),
  ...['karaoke', 'stacked', 'scatter', 'simples', 'serifada', 'classica'].map((styleName) => still(
    `caption-${styleName}`, 66,
    { hook: { ...HOOK, enabled: false }, captions: { ...CAPTIONS, style: styleName } },
  )),
];

for (const job of jobs) {
  console.log(`\n→ ${job.name}`);
  await writeFile(path.join(work, 'public', 'edit-data.json'), JSON.stringify(job.editData, null, 2));
  run(process.execPath, [
    path.join(runtimeNode, '@remotion', 'cli', 'remotion-cli.js'),
    'still', 'Reels', path.join(stills, `${job.name}.png`),
    '--frame', String(job.frame),
  ], { cwd: work, env: { ...process.env } });
}

// 5. Recorte + webp: headline olha o terco superior, legenda o inferior.
await mkdir(thumbsOut, { recursive: true });
// Cada estilo posiciona o texto numa altura propria do quadro 1080x1920.
const CROP_Y = { 'caption-stacked': 960, 'caption-scatter': 1120 };
for (const job of jobs) {
  const cropY = job.name.startsWith('headline-') ? 210 : (CROP_Y[job.name] ?? 1180);
  const crop = `crop=1080:560:0:${cropY}`;
  // PNG: o FFmpeg empacotado nao tem encoder webp.
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', path.join(stills, `${job.name}.png`),
    '-vf', `${crop},scale=540:280:flags=lanczos`,
    path.join(thumbsOut, `${job.name}.png`),
  ]);
}
console.log(`\nThumbnails em ${thumbsOut}`);
