// Gera o feed de atualizacao OTA (formato JSON do Squirrel.Mac) a partir do
// ZIP produzido pelo `npm run make`. Publicar os dois arquivos no bucket:
//
//   out/make/zip/darwin/arm64/Edvid-darwin-arm64-<versao>.zip
//   out/make/zip/darwin/arm64/feed.json
//
// Uso: node scripts/generate-update-feed.mjs <URL base publica do bucket>
// Ex.:  node scripts/generate-update-feed.mjs https://updates.exemplo.com/edvid
//
// O aplicativo le a URL do feed em EDVID_UPDATE_FEED_URL (ou na constante
// UPDATE_FEED_URL em src/main.ts quando a URL definitiva existir). O OTA so
// funciona em builds com assinatura de producao: o Squirrel.Mac recusa
// aplicativos com assinatura ad-hoc.
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.argv[2]?.replace(/\/$/, '');
if (!baseUrl || !/^https:\/\//u.test(baseUrl)) {
  console.error('uso: node scripts/generate-update-feed.mjs <URL base https do bucket>');
  process.exit(1);
}

const { version } = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
);
const zipDirectory = path.join(projectRoot, 'out', 'make', 'zip', 'darwin', 'arm64');
const zipName = `Edvid-darwin-arm64-${version}.zip`;
const zipPath = path.join(zipDirectory, zipName);
const zipInfo = await stat(zipPath).catch(() => null);
if (!zipInfo) {
  console.error(`ZIP da versao ${version} nao encontrado. Rode "npm run make" antes.`);
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

const feedPath = path.join(zipDirectory, 'feed.json');
await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`feed.json gerado para a versao ${version} (${Math.round(zipInfo.size / 1e6)} MB).`);
console.log(`Publique no bucket:\n  ${zipPath}\n  ${feedPath}`);
console.log(`URL do feed para o aplicativo: ${baseUrl}/feed.json`);
