// Prova do defeito que apagava as animações: o scaffold roda ANTES de cada
// render e copiava src/ inteiro com force:true, levando junto o
// CustomGraphics.tsx — o único arquivo que o agente escreve. A animação sumia
// no caminho e o arquivo terminava idêntico ao template.
//
// Aqui: réplica fiel do scaffold (antes e depois da correção) sobre um projeto
// com animação sob medida escrita.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(projectRoot, 'resources', 'remotion-template');
const work = mkdtempSync(path.join(tmpdir(), 'edvid-scaffold-'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const MARCA = '// ANIMAÇÃO SOB MEDIDA DO AGENTE: grid escuro + #ff5200';

// --- versão ANTIGA (com o defeito) ---
async function scaffoldAntigo(destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of ['src', 'remotion.config.ts', 'tsconfig.json', 'package.json']) {
    await cp(path.join(template, entry), path.join(destination, entry), { recursive: true, force: true });
  }
}

// --- versão NOVA (preserva o arquivo do agente) ---
async function scaffoldNovo(destination) {
  await mkdir(destination, { recursive: true });
  const editableRelative = path.join('src', 'CustomGraphics.tsx');
  const projectEditable = path.join(destination, editableRelative);
  const stampFile = path.join(destination, '.edvid-scaffold.json');
  const templateEditableSource = await readFile(path.join(template, editableRelative), 'utf8').catch(() => null);
  let preserved = null;
  const current = await readFile(projectEditable, 'utf8').catch(() => null);
  if (current !== null && templateEditableSource !== null) {
    let appliedSha = null;
    try {
      appliedSha = JSON.parse(await readFile(stampFile, 'utf8')).customGraphicsSha ?? null;
    } catch {}
    const untouched = appliedSha ? sha(current) === appliedSha : current === templateEditableSource;
    if (!untouched) preserved = current;
  }
  for (const entry of ['src', 'remotion.config.ts', 'tsconfig.json', 'package.json']) {
    await cp(path.join(template, entry), path.join(destination, entry), { recursive: true, force: true });
  }
  if (preserved !== null) {
    await writeFile(projectEditable, preserved);
  } else if (templateEditableSource !== null) {
    await writeFile(stampFile, `${JSON.stringify({ customGraphicsSha: sha(templateEditableSource) }, null, 2)}\n`);
  }
}

async function montarProjetoComAnimacao(destination) {
  await scaffoldNovo(destination); // primeira montagem: grava o carimbo
  const arquivo = path.join(destination, 'src', 'CustomGraphics.tsx');
  await writeFile(arquivo, `${await readFile(arquivo, 'utf8')}\n${MARCA}\n`);
}

try {
  // 1) Comportamento ANTIGO: o trabalho do agente é apagado.
  const antigo = path.join(work, 'antigo');
  await montarProjetoComAnimacao(antigo);
  await scaffoldAntigo(antigo);
  const depoisAntigo = await readFile(path.join(antigo, 'src', 'CustomGraphics.tsx'), 'utf8');
  assert.equal(depoisAntigo.includes(MARCA), false, 'o defeito precisa ser reproduzido: arquivo volta ao template');

  // 2) Comportamento NOVO: sobrevive, inclusive a vários renders seguidos.
  const novo = path.join(work, 'novo');
  await montarProjetoComAnimacao(novo);
  for (let render = 0; render < 3; render += 1) await scaffoldNovo(novo);
  const depoisNovo = await readFile(path.join(novo, 'src', 'CustomGraphics.tsx'), 'utf8');
  assert.equal(depoisNovo.includes(MARCA), true, 'a animação do agente tem de sobreviver a cada render');

  // 3) Projeto NÃO editado continua recebendo atualização do template.
  const limpo = path.join(work, 'limpo');
  await scaffoldNovo(limpo);
  const arquivoLimpo = path.join(limpo, 'src', 'CustomGraphics.tsx');
  await writeFile(arquivoLimpo, '// versão velha do template\n');
  // Simula "template antigo aplicado": carimbo aponta para o conteúdo atual.
  await writeFile(path.join(limpo, '.edvid-scaffold.json'), JSON.stringify({ customGraphicsSha: sha('// versão velha do template\n') }));
  await scaffoldNovo(limpo);
  const atualizado = await readFile(arquivoLimpo, 'utf8');
  assert.equal(
    atualizado,
    await readFile(path.join(template, 'src', 'CustomGraphics.tsx'), 'utf8'),
    'sem edição do agente, o template novo precisa chegar ao projeto',
  );

  console.log('test:scaffold ok — animação sob medida sobrevive aos renders; projeto intocado ainda recebe o template novo.');
} finally {
  await rm(work, { recursive: true, force: true });
}
