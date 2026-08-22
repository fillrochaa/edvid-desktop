// Teste das decisões do login do aluno.
//
// Defeito de origem: a primeira tentativa de login dava erro e a segunda
// entrava. Duas causas moram aqui — um tropeço de rede custava a tentativa
// inteira (não havia repetição) e QUALQUER resposta que não fosse 5xx virava
// "sua matrícula não está ativa", que é uma acusação e não um diagnóstico.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-member-'));

try {
  const source = path.join(outDir, 'member-auth-policy.ts');
  writeFileSync(source, readFileSync(path.join(projectRoot, 'src', 'member-auth-policy.ts'), 'utf8'));
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    source, '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const {
    RETRY_DELAYS_MS,
    enrollmentGrantsAccess,
    entitlementFrom,
    transientStatus,
  } = await import(pathToFileURL(path.join(outDir, 'member-auth-policy.js')).href);

  // --- 1. O que vale repetir --------------------------------------------
  assert.equal(transientStatus(429), true, 'servidor pedindo calma: repete');
  assert.equal(transientStatus(500), true);
  assert.equal(transientStatus(503), true);
  // Senha errada NAO pode repetir: o aluno esperaria três vezes para ler o
  // mesmo "e-mail ou senha incorretos".
  assert.equal(transientStatus(400), false);
  assert.equal(transientStatus(401), false);
  assert.equal(transientStatus(403), false);
  assert.equal(transientStatus(200), false);

  // Três tentativas no total, e a espera somada fica abaixo de 2s: repetir
  // não pode virar "o aplicativo travou ao entrar".
  assert.equal(RETRY_DELAYS_MS.length, 2, 'três tentativas no total');
  assert.ok(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) < 2_000, 'espera somada curta');
  assert.ok(RETRY_DELAYS_MS.every((delay, i) => i === 0 || delay > RETRY_DELAYS_MS[i - 1]), 'espera crescente');

  // --- 2. Quando dá para dizer que a matrícula não está ativa ------------
  // ESTE é o ponto que barrava aluno pagante. Só uma resposta VÁLIDA sem
  // matrícula produz a acusação; o resto é tropeço.
  assert.equal(entitlementFrom(true, true), 'active');
  assert.equal(entitlementFrom(true, false), 'inactive');
  assert.equal(entitlementFrom(false, false), 'network', 'resposta inválida nunca acusa o aluno');
  assert.equal(entitlementFrom(false, true), 'network');

  // --- 3. Qual matrícula dá direito ao Edvid ------------------------------
  const agora = Date.parse('2026-08-22T12:00:00Z');
  const slugs = new Set(['ia-edit-pro-thpgfw']);
  const titulo = 'ia edit pro';
  const vale = (row) => enrollmentGrantsAccess(row, agora, slugs, titulo);

  assert.equal(vale({ status: 'active', course: { slug: 'ia-edit-pro-thpgfw' } }), true);
  // Curso recriado com slug novo: o título salva o acesso.
  assert.equal(vale({ status: 'active', course: { slug: 'outro-slug', title: 'IA Edit Pro' } }), true);
  assert.equal(vale({ status: 'active', course: { slug: 'outro-curso', title: 'Outro' } }), false);
  assert.equal(vale({ status: 'canceled', course: { slug: 'ia-edit-pro-thpgfw' } }), false);
  // Validade: vencida não vale, futura vale, e sem validade vale (vitalícia).
  assert.equal(vale({ status: 'active', expires_at: '2026-08-21T00:00:00Z', course: { slug: 'ia-edit-pro-thpgfw' } }), false);
  assert.equal(vale({ status: 'active', expires_at: '2027-01-01T00:00:00Z', course: { slug: 'ia-edit-pro-thpgfw' } }), true);
  assert.equal(vale({ status: 'active', expires_at: null, course: { slug: 'ia-edit-pro-thpgfw' } }), true);
  // Linha malformada não derruba nem libera.
  assert.equal(vale({}), false);
  assert.equal(vale({ status: 'active' }), false);

  console.log('test:member-auth ok — tropeço se repete, credencial errada não, e matrícula só é negada com resposta válida.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
