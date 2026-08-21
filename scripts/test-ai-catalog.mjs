// Teste do catálogo de IAs e da escolha de provedor por papel.
//
// A regra que importa para o aluno: nunca gastar dinheiro dele sem precisar,
// nunca parar a edição porque UM provedor bateu no limite, e respeitar o
// "apenas modelos gratuitos" mesmo quando isso significa não ter ninguém.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-catalog-'));

try {
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(projectRoot, 'src', 'ai-catalog.ts'),
    '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });

  const { AI_CATALOG, catalogEntry, routeCandidates, routeFor, shouldFailover } =
    await import(pathToFileURL(path.join(outDir, 'ai-catalog.js')).href);

  const AGORA = 1_000_000;
  const rota = (connected, freeOnly = false, capability = 'imagem') =>
    routeFor({ capability, connected, freeOnly, now: AGORA });

  // --- Catálogo bem formado: sem isso a interface mostra badge errado. ---
  const ids = AI_CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids não podem repetir');
  for (const entry of AI_CATALOG) {
    assert.ok(entry.capabilities.length > 0, `${entry.id} precisa de ao menos um badge`);
    assert.ok(/^https:\/\//u.test(entry.keyUrl), `${entry.id} precisa de link https para criar a chave`);
    assert.ok(entry.credentials.some((field) => field.secret), `${entry.id} precisa de um campo secreto`);
    for (const model of entry.models) {
      assert.ok(entry.capabilities.includes(model.capability),
        `${entry.id}: modelo ${model.id} declara capacidade fora dos badges`);
    }
    // Provedor anunciado como gratuito não pode ter só modelo pago.
    if (entry.pricing === 'free') {
      assert.ok(entry.models.every((m) => m.free), `${entry.id} é marcado como gratuito`);
    }
  }

  // --- Preferência: o gratuito vem antes do pago, sempre. ---
  const ambos = [{ id: 'openrouter' }, { id: 'cloudflare' }];
  const escolha = rota(ambos);
  assert.equal(escolha.providerId, 'cloudflare', 'com os dois conectados, o gratuito atende');
  assert.equal(escolha.free, true);

  // --- Só o pago conectado: atende (o aluno escolheu conectar). ---
  assert.equal(rota([{ id: 'openrouter' }]).providerId, 'openrouter');

  // --- "Apenas gratuitos" com só o pago conectado: ninguém atende. ---
  assert.equal(rota([{ id: 'openrouter' }], true), null, 'filtro de gratuitos precisa valer');

  // --- Limite atingido: o provedor sai de cena até o descanso passar. ---
  const emDescanso = [{ id: 'cloudflare', cooldownUntil: AGORA + 60_000 }, { id: 'openrouter' }];
  assert.equal(rota(emDescanso).providerId, 'openrouter', 'quem bateu no limite cede a vez');
  const descansoVencido = [{ id: 'cloudflare', cooldownUntil: AGORA - 1 }, { id: 'openrouter' }];
  assert.equal(rota(descansoVencido).providerId, 'cloudflare', 'passado o descanso, o gratuito volta');

  // --- Nada conectado, ou papel que ninguém cobre. ---
  assert.equal(rota([]), null);
  assert.equal(rota(ambos, false, 'musica'), null, 'papel sem provedor no catálogo devolve nada');

  // --- Provedor desconhecido (catálogo mudou entre versões) é ignorado. ---
  assert.equal(rota([{ id: 'provedor-que-nao-existe' }]), null);
  assert.equal(catalogEntry('provedor-que-nao-existe'), null);

  // --- A lista completa alimenta o fallback em cadeia. ---
  const cadeia = routeCandidates({ capability: 'imagem', connected: ambos, freeOnly: false, now: AGORA });
  assert.ok(cadeia.length >= 2, 'precisa haver para quem cair');
  assert.equal(cadeia[0].free, true, 'a cadeia começa no gratuito');

  // --- Quando vale a pena tentar outro provedor. ---
  assert.equal(shouldFailover(429, 'Too Many Requests'), true);
  assert.equal(shouldFailover(503, 'unavailable'), true);
  assert.equal(shouldFailover(null, 'daily limit exceeded'), true);
  assert.equal(shouldFailover(400, 'prompt rejeitado pela política de conteúdo'), false,
    'prompt recusado é o mesmo em qualquer provedor — trocar só queima cota');
  assert.equal(shouldFailover(401, 'invalid api key'), false, 'chave errada não melhora trocando');

  console.log('test:ai-catalog ok — gratuito primeiro, limite cede a vez, filtro respeitado e failover só no que adianta.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
