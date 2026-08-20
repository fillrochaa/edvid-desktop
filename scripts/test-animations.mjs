// Teste da rede de segurança das animações.
//
// Defeito de origem, visto duas vezes em máquina real: uma animação registrada
// SEM `kind` sai muda do render — o template só desenha o que tem tipo. Na
// segunda vez o agente já tinha escrito kind nos flashes e esqueceu no
// infográfico ("Infográfico tela cheia — edição com IA"), então a timeline
// mostrava a faixa e o vídeo saía sem nada. O app passou a resolver o tipo
// antes de renderizar; estes casos travam a regra.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'edvid-anim-'));

// A normalização vive no main.ts (processo principal do Electron). Para testar
// sem subir o app, compila só as duas funções puras com o tsc do projeto.
const fonte = `
const ANIMATION_KIND_HINTS: Array<[RegExp, string]> = [
  [/\\bflash|estouro|clar(ao|ão)|transi(ca|çã)o\\b/iu, 'flash'],
  [/\\blinha do tempo|timeline|cronolog|etapas|passo a passo\\b/iu, 'timeline'],
  [/\\bformas|shapes|geom|bolha|elementos gr(a|á)ficos\\b/iu, 'shapes'],
  [/\\broteiro|script|texto|frase|t(o|ó)pico|bullet|lista|infogr(a|á)fico|card|cartao|cartão\\b/iu, 'script'],
];

export function inferAnimationKind(label: string): string {
  for (const [pattern, kind] of ANIMATION_KIND_HINTS) {
    if (pattern.test(label)) return kind;
  }
  return 'script';
}
`;
const srcFile = path.join(work, 'anim.ts');
writeFileSync(srcFile, fonte);
execFileSync(process.execPath, [
  path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  srcFile, '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
  '--skipLibCheck', '--outDir', work,
], { stdio: 'inherit' });

const { inferAnimationKind } = await import(path.join(work, 'anim.js'));

try {
  // O caso real que saiu mudo do render.
  assert.equal(inferAnimationKind('Infográfico tela cheia — edição com IA'), 'script');
  // Os rótulos que o agente usou para os flashes, com e sem acento.
  assert.equal(inferAnimationKind('Flash de transição'), 'flash');
  assert.equal(inferAnimationKind('flashCut'), 'flash');
  assert.equal(inferAnimationKind('Clarão no corte'), 'flash');
  // Outros tipos reconhecíveis pelo rótulo em português.
  assert.equal(inferAnimationKind('Linha do tempo do processo'), 'timeline');
  assert.equal(inferAnimationKind('Etapas da edição'), 'timeline');
  assert.equal(inferAnimationKind('Formas coloridas'), 'shapes');
  assert.equal(inferAnimationKind('Tópicos principais'), 'script');
  // Rótulo sem pista alguma: cai no cartão de texto, NUNCA em nada.
  assert.equal(inferAnimationKind('Momento marcante'), 'script');
  assert.equal(inferAnimationKind(''), 'script');

  console.log('test:animations ok — todo rótulo resolve para um tipo desenhável; nenhuma animação fica muda.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
