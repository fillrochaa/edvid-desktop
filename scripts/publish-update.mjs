// Publica um release OTA no bucket R2: envia o ZIP da versao corrente e o
// feed.json apontando para ele. Roda depois de "npm run make:signed".
//
// Credenciais vem do ambiente (signing.env via make/publish:signed):
//   EDVID_CF_ACCOUNT_ID   conta Cloudflare
//   EDVID_CF_API_TOKEN    token com permissao R2 Edit
//   EDVID_R2_BUCKET       nome do bucket
//   EDVID_UPDATE_BASE_URL URL publica do bucket (r2.dev ou dominio proprio)
//
// O upload usa o wrangler oficial via npx (autentica pelo CLOUDFLARE_API_TOKEN).
// O feed final fica em <EDVID_UPDATE_BASE_URL>/feed.json — a mesma URL gravada
// em UPDATE_FEED_URL no src/main.ts.
import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountId = process.env.EDVID_CF_ACCOUNT_ID?.trim();
const apiToken = process.env.EDVID_CF_API_TOKEN?.trim();
const bucket = process.env.EDVID_R2_BUCKET?.trim();
const baseUrl = process.env.EDVID_UPDATE_BASE_URL?.trim()?.replace(/\/$/, '');

if (!accountId || !apiToken || !bucket || !baseUrl) {
  console.error('Preencha EDVID_CF_ACCOUNT_ID, EDVID_CF_API_TOKEN, EDVID_R2_BUCKET e EDVID_UPDATE_BASE_URL no signing.env.');
  process.exit(1);
}

const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const zipName = `Edvid-darwin-arm64-${version}.zip`;
const zipPath = path.join(projectRoot, 'out', 'make', 'zip', 'darwin', 'arm64', zipName);
const zipInfo = await stat(zipPath).catch(() => null);
if (!zipInfo) {
  console.error(`ZIP da versao ${version} nao encontrado. Rode "npm run make:signed" antes.`);
  process.exit(1);
}

const feed = {
  currentRelease: version,
  releases: [
    {
      version,
      updateTo: {
        version,
        name: version,
        url: `${baseUrl}/${zipName}`,
        pub_date: new Date().toISOString(),
      },
    },
  ],
};
const feedPath = path.join(projectRoot, 'out', 'make', 'zip', 'darwin', 'arm64', 'feed.json');
await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);

function put(key, file, contentType) {
  console.log(`Enviando ${key} (${Math.round((zipInfo?.size ?? 0) / 1e6)} MB no total do release)...`);
  const result = spawnSync(
    'npx',
    [
      '--yes', 'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`,
      '--file', file,
      '--content-type', contentType,
      '--remote',
    ],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken },
    },
  );
  if (result.status !== 0) {
    console.error(`Falha ao enviar ${key}.`);
    process.exit(result.status ?? 1);
  }
}

// O ZIP primeiro: o feed novo so pode apontar para um arquivo ja disponivel.
put(zipName, zipPath, 'application/zip');
put('feed.json', feedPath, 'application/json');

console.log(`\nRelease ${version} publicado.`);
console.log(`Feed: ${baseUrl}/feed.json`);
