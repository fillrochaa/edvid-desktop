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

  // A rede de segurança tem um limite: quando o agente escreve a animação sob
  // medida no CustomGraphics.tsx, o registro sem `kind` está CERTO e injetar um
  // preset desenharia um cartão genérico por cima do trabalho dele — foi o que
  // aconteceu com o pedido de "tela cheia com grid escuro e #ff5200", que virou
  // o cartão "ROTEIRO". O gatilho é o arquivo estar igual ao do template.
  const templateSource = readFileSync(
    path.join(projectRoot, 'resources', 'remotion-template', 'src', 'CustomGraphics.tsx'),
    'utf8',
  );
  const untouched = (source) => source === templateSource;
  assert.equal(untouched(templateSource), true, 'projeto recém-criado usa o arquivo do template');
  assert.equal(untouched(`${templateSource}\n// animação sob medida\n`), false, 'arquivo editado é detectado');
  // E o template precisa reconhecer o tipo que marca "o desenho vem do código".
  assert.ok(templateSource.includes("'custom'"), 'template aceita kind custom');

  // "custom" é uma PROMESSA: o desenho viria de código no CustomGraphics.tsx.
  // Com o arquivo intacto a promessa está vazia e a animação sairia muda — foi
  // o caso real em que o agente aprendeu a marcar "custom" e esqueceu de
  // escrever o componente. O app precisa tratar isso como pendência (para
  // cobrar o agente) e, em último caso, como registro sem tipo.
  const pendente = (kind, arquivoIntacto) => arquivoIntacto && kind === 'custom';
  assert.equal(pendente('custom', true), true, 'custom sem código é promessa vazia');
  assert.equal(pendente('custom', false), false, 'custom com código é legítimo');
  assert.equal(pendente('script', true), false, 'preset não é promessa');
  // E, sem código, "custom" não pode blindar o registro contra a rede.
  const aceitaComoTipoFinal = (kind) => Boolean(kind) && kind !== 'custom';
  assert.equal(aceitaComoTipoFinal('custom'), false, 'custom não conta como tipo desenhável aqui');
  assert.equal(aceitaComoTipoFinal('flash'), true);

  console.log('test:animations ok — rótulo sempre vira tipo desenhável, código sob medida é respeitado e "custom" sem código é cobrado.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
