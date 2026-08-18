// Publica um release OTA no bucket R2: envia o ZIP da versao corrente e o
// feed.json apontando para ele. Roda depois de "npm run make:signed".
//
// Upload pelo protocolo S3 do R2 (multipart): o wrangler limita objetos a
// 300 MiB e o ZIP do Edvid passa de 800 MB. As credenciais S3 sao derivadas
// do proprio API token, como documenta o R2: o Access Key ID e o id do token
// (obtido em /user/tokens/verify) e o Secret e o SHA-256 do valor do token.
//
// Credenciais vem do ambiente (signing.env via npm run publish:update):
//   EDVID_CF_ACCOUNT_ID   conta Cloudflare
//   EDVID_CF_API_TOKEN    token com permissao R2 Edit
//   EDVID_R2_BUCKET       nome do bucket
//   EDVID_UPDATE_BASE_URL URL publica do bucket (r2.dev ou dominio proprio)
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountId = process.env.EDVID_CF_ACCOUNT_ID?.trim();
const apiToken = process.env.EDVID_CF_API_TOKEN?.trim();
const bucket = process.env.EDVID_R2_BUCKET?.trim();
const baseUrl = process.env.EDVID_UPDATE_BASE_URL?.trim()?.replace(/\/$/, '');

if (!accountId || !apiToken || !bucket || !baseUrl) {
  console.error('Preencha EDVID_CF_ACCOUNT_ID, EDVID_CF_API_TOKEN, EDVID_R2_BUCKET e EDVID_UPDATE_BASE_URL no signing.env.');
  process.exit(1);
}

// Sem argumento publica a versao do package.json; com argumento, a indicada
// (util quando o package ja avancou para a proxima release).
const version =
  process.argv[2]?.trim() ||
  JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
const zipName = `Edvid-darwin-arm64-${version}.zip`;
const zipPath = path.join(projectRoot, 'out', 'make', 'zip', 'darwin', 'arm64', zipName);
const zipInfo = await stat(zipPath).catch(() => null);
if (!zipInfo) {
  console.error(`ZIP da versao ${version} nao encontrado. Rode "npm run make:signed" antes.`);
  process.exit(1);
}

// Access Key ID = id do token (verify); Secret = SHA-256 do valor do token.
const verify = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
  headers: { Authorization: `Bearer ${apiToken}` },
});
const verifyBody = await verify.json();
const tokenId = verifyBody?.result?.id;
if (!verify.ok || !tokenId) {
  console.error('Token do Cloudflare invalido (verify falhou).');
  process.exit(1);
}
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: tokenId,
    secretAccessKey: createHash('sha256').update(apiToken).digest('hex'),
  },
});

async function putObject(key, filePath, contentType, size) {
  console.log(`Enviando ${key} (${Math.round(size / 1e6)} MB)...`);
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
    },
    partSize: 100 * 1024 * 1024,
    queueSize: 3,
  });
  let lastPct = -10;
  upload.on('httpUploadProgress', (progress) => {
    if (!progress.loaded || !size) return;
    const pct = Math.floor((progress.loaded / size) * 100);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      console.log(`  ${key}: ${pct}%`);
    }
  });
  await upload.done();
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

// O ZIP primeiro: o feed novo so pode apontar para um arquivo ja disponivel.
await putObject(zipName, zipPath, 'application/zip', zipInfo.size);
const feedInfo = await stat(feedPath);
await putObject('feed.json', feedPath, 'application/json', feedInfo.size);

console.log(`\nRelease ${version} publicado.`);
console.log(`Feed: ${baseUrl}/feed.json`);
