// Teste do MOTOR do chat no config.toml do Codex.
//
// Defeito de origem (visto em máquina real): com o Ollama escolhido, o chat
// respondia "401 Unauthorized … api.openai.com/v1/responses". O config gerado
// saía sem provedor nenhum porque trocar de motor recria o CodexAppServer e o
// motor tinha sido aplicado na instância ANTIGA, jogada fora em seguida.
// Antes disso, duas armadilhas do próprio Codex derrubavam o config inteiro:
// `wire_api = "chat"` foi descontinuado e `ollama` é id reservado de provedor
// embutido. Config inválido não degrada com aviso — é ignorado por completo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-engine-'));

try {
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(projectRoot, 'src', 'codex-app-server.ts'),
    '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });

  const { CodexAppServer } = await import(pathToFileURL(path.join(outDir, 'codex-app-server.js')).href);

  const home = mkdtempSync(path.join(tmpdir(), 'edvid-codex-home-'));
  const configPath = path.join(home, 'config.toml');
  const novoServidor = () => new CodexAppServer('/bin/echo', home, '0.0.0', () => {}, {}, ['/tmp/cache']);

  // O config é escrito no start; `/bin/echo` sai na hora e o start rejeita —
  // o que importa é o arquivo que ficou em disco.
  const escreverConfig = async (server) => {
    await server.start().catch(() => {});
    return readFileSync(configPath, 'utf8');
  };

  // --- Sem motor: o ChatGPT continua conduzindo, sem seção de provedor. ---
  const padrao = await escreverConfig(novoServidor());
  assert.ok(padrao.includes('model = "gpt-5.6-terra"'), 'sem motor, o modelo é o do ChatGPT');
  assert.ok(!padrao.includes('[model_providers'), 'sem motor, nenhum provedor é declarado');

  // --- Com motor: provedor declarado e modelo trocado. ---
  const comMotor = novoServidor();
  comMotor.setEngine({
    providerId: 'ollama',
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    model: 'gpt-oss:120b',
    envKey: 'OLLAMA_API_KEY',
  });
  const config = await escreverConfig(comMotor);

  assert.ok(config.includes('model = "gpt-oss:120b"'), 'o modelo passa a ser o do motor');
  // Id PREFIXADO: `ollama` é reservado no Codex e o config inteiro seria
  // recusado com "Built-in providers cannot be overridden".
  assert.ok(config.includes('model_provider = "edvid-ollama"'), 'o provedor precisa ir prefixado');
  assert.ok(config.includes('[model_providers.edvid-ollama]'), 'a seção do provedor precisa existir');
  assert.ok(!/model_provider = "ollama"/.test(config), 'nunca usar o id reservado');
  // `chat` foi descontinuado: com ele o Codex recusa o config e volta à OpenAI.
  assert.ok(config.includes('wire_api = "responses"'), 'wire_api precisa ser responses');
  assert.ok(!config.includes('wire_api = "chat"'), 'wire_api "chat" não é mais aceito');
  assert.ok(config.includes('base_url = "https://ollama.com/v1"'));
  assert.ok(config.includes('env_key = "OLLAMA_API_KEY"'));
  // A chave NUNCA vai para o arquivo: ela viaja pelo ambiente do processo.
  assert.ok(!/sk-|Bearer|apiKey/i.test(config), 'a chave não pode aparecer no config');

  // --- Ordem do TOML: chave de topo antes de qualquer seção. ---
  assert.ok(
    config.indexOf('model_provider =') < config.indexOf('[model_providers'),
    'chave de topo tem de vir antes das seções, senão o TOML a engole',
  );

  // --- setEngine informa se MUDOU: é o gatilho para recriar o servidor. ---
  const server = novoServidor();
  const motor = { providerId: 'ollama', label: 'O', baseUrl: 'https://ollama.com/v1', model: 'm', envKey: 'K' };
  assert.equal(server.setEngine(motor), true, 'primeira definição é mudança');
  assert.equal(server.setEngine({ ...motor }), false, 'motor igual não recria o servidor');
  assert.equal(server.setEngine(null), true, 'voltar ao padrão é mudança');

  rmSync(home, { recursive: true, force: true });
  console.log('test:codex-engine ok — provedor prefixado, wire_api responses, chave fora do arquivo e troca detectada.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
