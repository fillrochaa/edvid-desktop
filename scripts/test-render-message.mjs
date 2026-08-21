// Teste da mensagem de falha do render da Fase 2.
//
// Defeito de origem: o Edvid mostrava a ÚLTIMA linha do stderr, que quase
// sempre é quadro de pilha. O aluno recebeu literalmente "O render da edição
// estilizada falhou:     at process.processTicksAndRejections
// (node:internal/process/task_queues:104:5)" — zero informação sobre o que
// deu errado.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-render-msg-'));

try {
  // A função vive no main.ts (que importa Electron); compila-se uma cópia
  // isolada dela, mantendo o corpo idêntico ao usado em produção.
  const fonte = execFileSync('node', ['-e', `
    const fs = require('fs');
    const src = fs.readFileSync(${JSON.stringify(path.join(projectRoot, 'src', 'main.ts'))}, 'utf8');
    const start = src.indexOf('export function renderFailureMessage');
    const end = src.indexOf('function renderPhase2', start);
    process.stdout.write(src.slice(start, end));
  `], { encoding: 'utf8' });
  assert.ok(fonte.includes('renderFailureMessage'), 'a função precisa existir no main.ts');

  const arquivo = path.join(outDir, 'msg.ts');
  writeFileSync(arquivo, fonte);
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    arquivo, '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const { renderFailureMessage } = await import(pathToFileURL(path.join(outDir, 'msg.js')).href);

  // O caso real: stack puro no fim.
  const stackReal = [
    'Error: Cannot find module ./public/trilha.mp3',
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
  ].join('\n');
  const msg = renderFailureMessage(stackReal, 1);
  assert.ok(msg.includes('Cannot find module'), `precisa escolher a linha que informa: ${msg}`);
  assert.ok(!msg.includes('processTicksAndRejections'), 'quadro de pilha nunca vai para o chat');

  // Só stack: ainda assim precisa dizer alguma coisa útil.
  const soStack = '    at foo (x.js:1:1)\n    at bar (y.js:2:2)';
  assert.ok(/código/u.test(renderFailureMessage(soStack, 3)), 'sem linha útil, informa o código de saída');

  // Mensagem longa do bundler é cortada, não despejada inteira.
  const longa = `Error: ${'x'.repeat(600)}`;
  assert.ok(renderFailureMessage(longa, 1).length <= 241, 'mensagem longa precisa ser cortada');

  // Prefere a linha que nomeia o erro, mesmo com ruído depois dela.
  const comRuido = ['Error: falta o arquivo cut.mp4', 'Done in 4.2s', 'cleaning up'].join('\n');
  assert.ok(renderFailureMessage(comRuido, 1).includes('falta o arquivo'));

  // Sem stderr nenhum.
  assert.ok(renderFailureMessage('', null).length > 0, 'nunca devolve mensagem vazia');

  console.log('test:render-message ok — escolhe a linha que informa, descarta pilha e nunca sai vazia.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
