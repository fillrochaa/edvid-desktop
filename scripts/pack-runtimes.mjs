// Gera o runtime pack sob demanda: um tar.gz de resources/runtimes/<plat>
// nomeado pela chave do manifest (sha256 de manifest.runtimes, 12 hex) e o
// arquivo .sha256 de integridade. A MESMA chave e computada pelo aplicativo
// em src/runtime.ts (runtimePackKey) — mudou la, mude aqui.
//
// Saida: out/runtime-packs/runtimes-<plat>-<arch>-<chave>.tar.gz (+ .sha256)
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformKey = `${process.platform}-${process.arch}`;
const runtimesDirectory = path.join(projectRoot, 'resources', 'runtimes', platformKey);
if (!(await stat(runtimesDirectory).catch(() => null))) {
  console.error(`resources/runtimes/${platformKey} nao existe. Rode os stage:* antes (npm run make ja faz).`);
  process.exit(1);
}

const manifest = JSON.parse(
  await readFile(path.join(projectRoot, 'resources', 'runtime-manifest.json'), 'utf8'),
);
const key = createHash('sha256')
  .update(JSON.stringify(manifest.runtimes))
  .digest('hex')
  .slice(0, 12);

const outDirectory = path.join(projectRoot, 'out', 'runtime-packs');
await mkdir(outDirectory, { recursive: true });
const packName = `runtimes-${platformKey}-${key}.tar.gz`;
const packPath = path.join(outDirectory, packName);

console.log(`Empacotando ${platformKey} (chave ${key})...`);
// O tar leva o diretorio da plataforma com o proprio nome na raiz do
// arquivo: extrair em userData/runtime/tools reproduz o layout dos resources.
const result = spawnSync(
  'tar',
  ['-czf', packPath, '-C', path.join(projectRoot, 'resources', 'runtimes'), platformKey],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const digest = createHash('sha256');
await new Promise((resolve, reject) => {
  const stream = createReadStream(packPath);
  stream.on('data', (chunk) => digest.update(chunk));
  stream.on('end', resolve);
  stream.on('error', reject);
});
const sha = digest.digest('hex');
await writeFile(`${packPath}.sha256`, `${sha}  ${packName}\n`);

const info = await stat(packPath);
console.log(`ok: ${packName} (${Math.round(info.size / 1e6)} MB)`);
console.log(`sha256: ${sha}`);
