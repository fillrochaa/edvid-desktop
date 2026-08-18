// Publica o runtime pack no bucket R2, em runtimes/<packname>(.sha256).
// So precisa rodar quando alguma versao do runtime-manifest.json mudar —
// se o pacote da chave corrente ja existir no bucket, nada e reenviado.
// Credenciais: as mesmas EDVID_CF_*/EDVID_R2_* do signing.env.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
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

const platformKey = `${process.platform}-${process.arch}`;
const manifest = JSON.parse(
  await readFile(path.join(projectRoot, 'resources', 'runtime-manifest.json'), 'utf8'),
);
const key = createHash('sha256')
  .update(JSON.stringify(manifest.runtimes))
  .digest('hex')
  .slice(0, 12);
const packName = `runtimes-${platformKey}-${key}.tar.gz`;
const packPath = path.join(projectRoot, 'out', 'runtime-packs', packName);
const packInfo = await stat(packPath).catch(() => null);
if (!packInfo) {
  console.error(`${packName} nao encontrado. Rode "node scripts/pack-runtimes.mjs" antes.`);
  process.exit(1);
}

const verify = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
  headers: { Authorization: `Bearer ${apiToken}` },
});
const tokenId = (await verify.json())?.result?.id;
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

const remoteKey = `runtimes/${packName}`;
const exists = await s3
  .send(new HeadObjectCommand({ Bucket: bucket, Key: remoteKey }))
  .then(() => true)
  .catch(() => false);
if (exists) {
  console.log(`Pacote ${packName} ja esta no bucket — nada a enviar.`);
  process.exit(0);
}

async function putObject(key, filePath, contentType, size) {
  console.log(`Enviando ${key} (${Math.round(size / 1e6)} MB)...`);
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: createReadStream(filePath), ContentType: contentType },
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

await putObject(remoteKey, packPath, 'application/gzip', packInfo.size);
const shaPath = `${packPath}.sha256`;
const shaInfo = await stat(shaPath);
await putObject(`${remoteKey}.sha256`, shaPath, 'text/plain', shaInfo.size);
console.log(`\nRuntime pack publicado: ${baseUrl}/${remoteKey}`);
