// Teste da impressão digital da Fase 2.
//
// Defeito de origem: a digital usava tamanho+data, e o app reescreve arquivos
// por conta própria (o scaffold reaplica o CustomGraphics.tsx a cada render, a
// normalização regrava o edit-data.json). A data mudava sem o conteúdo mudar,
// a digital nunca batia com a gravada e bastava ABRIR o aplicativo ou trocar
// de projeto para um render completo começar sozinho — relatado em uso real.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile, utimes } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PHASE2_INPUTS = ['edit-data.json', 'captions.json', 'caption-cues.json', 'segments.json', 'track.json', 'cut.mp4'];

// Réplica fiel da função do main.ts.
async function phase2Fingerprint(publicDirectory) {
  try {
    await stat(path.join(publicDirectory, 'edit-data.json'));
    await stat(path.join(publicDirectory, 'cut.mp4'));
  } catch {
    return null;
  }
  const parts = [];
  const inputs = [
    ...PHASE2_INPUTS.map((name) => [name, path.join(publicDirectory, name)]),
    ['CustomGraphics.tsx', path.join(publicDirectory, '..', 'src', 'CustomGraphics.tsx')],
  ];
  for (const [name, filePath] of inputs) {
    try {
      if (name === 'cut.mp4') {
        const info = await stat(filePath);
        parts.push(`${name}:${info.size}:${Math.floor(info.mtimeMs)}`);
        continue;
      }
      parts.push(`${name}:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`);
    } catch {
      parts.push(`${name}:ausente`);
    }
  }
  return parts.join('|');
}

const work = mkdtempSync(path.join(tmpdir(), 'edvid-fp-'));
try {
  const publicDirectory = path.join(work, 'remotion', 'public');
  await mkdir(publicDirectory, { recursive: true });
  await mkdir(path.join(work, 'remotion', 'src'), { recursive: true });
  const custom = path.join(work, 'remotion', 'src', 'CustomGraphics.tsx');
  const editData = path.join(publicDirectory, 'edit-data.json');
  await writeFile(editData, JSON.stringify({ animations: [{ start: 1, end: 2, kind: 'custom' }] }));
  await writeFile(path.join(publicDirectory, 'cut.mp4'), 'video');
  await writeFile(custom, 'export const CustomGraphics = () => null;\n');

  const inicial = await phase2Fingerprint(publicDirectory);
  assert.ok(inicial, 'projeto completo tem digital');

  // 1) O scaffold reescreve o MESMO conteúdo com data nova (é o que acontece
  //    a cada render). A digital não pode mudar — senão renderiza de novo.
  const mesmoConteudo = await readFile(custom, 'utf8');
  await writeFile(custom, mesmoConteudo);
  const futuro = new Date(Date.now() + 60_000);
  await utimes(custom, futuro, futuro);
  assert.equal(await phase2Fingerprint(publicDirectory), inicial, 'reescrever igual não pode disparar render');

  // 2) A normalização regrava o edit-data.json idêntico: idem.
  await writeFile(editData, await readFile(editData, 'utf8'));
  await utimes(editData, futuro, futuro);
  assert.equal(await phase2Fingerprint(publicDirectory), inicial, 'regravar o mesmo JSON não pode disparar render');

  // 3) Mudança de verdade no código da animação AINDA dispara.
  await writeFile(custom, `${mesmoConteudo}// animação nova\n`);
  const comAnimacao = await phase2Fingerprint(publicDirectory);
  assert.notEqual(comAnimacao, inicial, 'animação nova precisa disparar render');

  // 4) Mudança de verdade nos dados também.
  await writeFile(editData, JSON.stringify({ animations: [{ start: 1, end: 3, kind: 'custom' }] }));
  assert.notEqual(await phase2Fingerprint(publicDirectory), comAnimacao, 'dados novos precisam disparar render');

  // 5) Projeto sem o corte não tem digital (nada a renderizar).
  const vazio = path.join(work, 'vazio', 'public');
  await mkdir(vazio, { recursive: true });
  assert.equal(await phase2Fingerprint(vazio), null);

  console.log('test:fingerprint ok — reescrita idêntica não renderiza; mudança real ainda renderiza.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
