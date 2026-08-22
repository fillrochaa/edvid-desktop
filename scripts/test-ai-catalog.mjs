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

  const { AI_CATALOG, catalogEntry, keyProbe, routeCandidates, routeFor, shouldFailover } =
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

  // --- Verificação de chave: cada provedor no SEU endereço ------------------
  // O defeito real: o teste tinha caso para Cloudflare, Treblo e Ollama, e
  // tudo o mais caía num fallback apontando para o openrouter.ai. A chave boa
  // do Gemini era enviada para o OpenRouter, voltava 401 e o aluno lia
  // "Chave recusada pelo provedor".
  const gemini = keyProbe('gemini', { apiKey: 'abc' });
  assert.ok(gemini.url.includes('generativelanguage.googleapis.com'), `Gemini no endereço errado: ${gemini.url}`);
  assert.ok(!gemini.url.includes('openrouter'), 'NUNCA testar Gemini no OpenRouter');
  // A chave do Gemini vai na URL, não em cabeçalho — e precisa ir escapada.
  assert.ok(gemini.url.includes('key=abc'));
  assert.deepEqual(gemini.headers, {});
  // E o Google recusa com 400, não 401: medido no endpoint real.
  assert.ok(gemini.refusedStatus.includes(400), '400 é como o Google diz "chave inválida"');

  const chatgpt = keyProbe('chatgpt', { apiKey: 'sk-x' });
  assert.ok(chatgpt.url.includes('api.openai.com'));
  assert.equal(chatgpt.headers.Authorization, 'Bearer sk-x');
  const claude = keyProbe('claude', { apiKey: 'sk-ant-x' });
  assert.ok(claude.url.includes('api.anthropic.com'));
  assert.equal(claude.headers['x-api-key'], 'sk-ant-x', 'a Anthropic não usa Bearer');
  assert.ok(claude.headers['anthropic-version'], 'sem a versão a Anthropic recusa o pedido');
  assert.ok(keyProbe('ollama', { apiKey: 'x' }).url.includes('ollama.com'));
  assert.ok(keyProbe('openrouter', { apiKey: 'x' }).url.includes('openrouter.ai'));

  // Cloudflare precisa do Account ID; sem ele não há endereço.
  assert.ok(keyProbe('cloudflare', { apiKey: 'x', accountId: 'conta' }).url.includes('conta'));
  assert.equal(keyProbe('cloudflare', { apiKey: 'x' }), null);
  // Provedor sem verificação não pode virar teste contra o serviço errado.
  assert.equal(keyProbe('inventado', { apiKey: 'x' }), null);
  assert.equal(keyProbe('treblo', { apiKey: 'x' }), null, 'o Treblo tem verificação própria');

  // Toda IA do catálogo que aceita chave precisa saber ser verificada — ou
  // ter caso próprio. Sem isto, o próximo provedor repete o defeito.
  for (const entry of AI_CATALOG) {
    if (!entry.auth.includes('apikey')) continue;
    const probe = keyProbe(entry.id, { apiKey: 'x', accountId: 'y' });
    assert.ok(probe !== null || entry.id === 'treblo', `${entry.id} não sabe verificar a própria chave`);
  }

  console.log('test:ai-catalog ok — rota gratuita primeiro, failover só no que adianta e cada chave testada no seu provedor.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
