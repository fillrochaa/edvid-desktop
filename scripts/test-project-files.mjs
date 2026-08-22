// Teste da arrumação da pasta EM DISCO — o código que move e apaga arquivo do
// aluno. Monta um projeto no formato antigo, roda a consolidação de verdade e
// confere o resultado no sistema de arquivos.
//
// A estrutura montada aqui é a do projeto real "teste11": três pastas na raiz
// (edit, edicao, transcricao_raw) e 26 renders em edicao/fase_2, que somavam
// 543 MB de versões que ninguém ia rever.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-files-'));

const escrever = (file, conteudo = 'x') => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, conteudo);
};

try {
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(projectRoot, 'src', 'project-files.ts'),
    '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  // O tsc emite `from './project-layout'` sem extensão (resolução de bundler);
  // o Node em ESM exige o .js. Só o carregamento muda — o código é o mesmo.
  const emitido = path.join(outDir, 'project-files.js');
  writeFileSync(emitido, readFileSync(emitido, 'utf8').replace("'./project-layout'", "'./project-layout.js'"));
  const { consolidateProjectFolder, publishFinalVideo, pruneRenders } = await import(
    pathToFileURL(path.join(outDir, 'project-files.js')).href
  );

  // --- Projeto no formato antigo, igual ao teste11 -------------------------
  const projeto = path.join(outDir, 'teste11');
  escrever(path.join(projeto, 'teste11.MOV'), 'fonte do aluno');
  escrever(path.join(projeto, 'edit', 'corte_limpo.mp4'));
  escrever(path.join(projeto, 'edit', 'remotion', 'public', 'cut.mp4'));
  for (let v = 1; v <= 26; v += 1) {
    escrever(path.join(projeto, 'edicao', 'fase_2', `fase_2_v${v}.mp4`), `render ${v}`);
  }
  escrever(path.join(projeto, 'edicao', 'fase_2', 'briefing.json'), '{}');
  for (const ext of ['json', 'vtt', 'txt', 'tsv', 'srt']) {
    escrever(path.join(projeto, 'transcricao_raw', `teste11.${ext}`));
  }
  escrever(
    path.join(projeto, 'edit', 'remotion', 'out', 'render-stamp.json'),
    JSON.stringify({ fingerprint: 'abc', output: 'edicao/fase_2/fase_2_v26.mp4' }),
  );

  const resultado = await consolidateProjectFolder(projeto);

  // 1. Sobrou UMA pasta de trabalho na raiz, mais o vídeo do aluno.
  assert.ok(!existsSync(path.join(projeto, 'edicao')), 'edicao tinha de sumir da raiz');
  assert.ok(!existsSync(path.join(projeto, 'transcricao_raw')), 'transcricao_raw tinha de sumir da raiz');
  assert.ok(existsSync(path.join(projeto, 'edit')), 'edit continua');
  assert.equal(
    readFileSync(path.join(projeto, 'teste11.MOV'), 'utf8'),
    'fonte do aluno',
    'o material do aluno NUNCA é tocado',
  );

  // 2. O conteúdo foi movido, não perdido.
  assert.ok(existsSync(path.join(projeto, 'edit', 'transcricao_raw', 'teste11.srt')));
  assert.ok(existsSync(path.join(projeto, 'edit', 'fase_2', 'briefing.json')), 'briefing não é render, fica');

  // 3. Sobraram 4 renders: o atual e três anteriores.
  const sobrando = ['v23', 'v24', 'v25', 'v26'];
  for (const v of sobrando) {
    assert.ok(existsSync(path.join(projeto, 'edit', 'fase_2', `fase_2_${v}.mp4`)), `${v} tinha de ficar`);
  }
  assert.ok(!existsSync(path.join(projeto, 'edit', 'fase_2', 'fase_2_v22.mp4')), 'v22 tinha de sair');
  assert.ok(!existsSync(path.join(projeto, 'edit', 'fase_2', 'fase_2_v1.mp4')), 'v1 tinha de sair');
  assert.equal(resultado.removed.length, 22);

  // 4. O carimbo aponta para o lugar novo — senão o app renderiza sozinho na
  //    primeira abertura, que foi um defeito real e chato.
  const carimbo = JSON.parse(readFileSync(path.join(projeto, 'edit', 'remotion', 'out', 'render-stamp.json'), 'utf8'));
  assert.equal(carimbo.output, path.join('edit', 'fase_2', 'fase_2_v26.mp4'));
  assert.equal(carimbo.fingerprint, 'abc', 'o resto do carimbo fica intacto');
  assert.ok(existsSync(path.join(projeto, carimbo.output)), 'o carimbo aponta um arquivo que existe');

  // 5. O vídeo final apareceu na raiz, com o nome do projeto e o conteúdo do
  //    render mais recente.
  assert.equal(resultado.finalVideo, 'teste11_final.mp4');
  assert.equal(readFileSync(path.join(projeto, 'teste11_final.mp4'), 'utf8'), 'render 26');

  // --- Rodar de novo não pode mudar nada nem apagar mais nada -------------
  const segunda = await consolidateProjectFolder(projeto);
  assert.deepEqual(segunda.removed, [], 'a segunda passagem não apaga nada');
  assert.equal(segunda.finalVideo, null, 'o final já existia, não republica');
  assert.ok(existsSync(path.join(projeto, 'edit', 'fase_2', 'fase_2_v26.mp4')));

  // --- Conflito de nome: o arquivo antigo NÃO é sobrescrito ---------------
  const conflito = path.join(outDir, 'conflito');
  escrever(path.join(conflito, 'edit', 'transcricao_raw', 'a.json'), 'novo');
  escrever(path.join(conflito, 'transcricao_raw', 'a.json'), 'antigo');
  escrever(path.join(conflito, 'transcricao_raw', 'b.json'), 'so no antigo');
  await consolidateProjectFolder(conflito);
  assert.equal(
    readFileSync(path.join(conflito, 'edit', 'transcricao_raw', 'a.json'), 'utf8'),
    'novo',
    'o que já estava em edit/ manda',
  );
  assert.equal(readFileSync(path.join(conflito, 'edit', 'transcricao_raw', 'b.json'), 'utf8'), 'so no antigo');
  assert.ok(
    existsSync(path.join(conflito, 'transcricao_raw', 'a.json')),
    'o arquivo que não coube fica onde está, para o aluno decidir',
  );

  // --- Projeto já novo: consolidar não pode inventar nada -----------------
  const novo = path.join(outDir, 'novo');
  escrever(path.join(novo, 'fonte.mov'));
  escrever(path.join(novo, 'edit', 'fase_2', 'fase_2_v1.mp4'), 'unico');
  const semNada = await consolidateProjectFolder(novo);
  assert.deepEqual(semNada.removed, []);
  assert.ok(!existsSync(path.join(novo, 'edicao')));
  assert.ok(!existsSync(path.join(novo, 'novo_final.mp4')), 'sem carimbo, não publica final');

  // --- publishFinalVideo sozinho, e o que ele faz quando falha ------------
  assert.equal(await publishFinalVideo(novo, path.join(novo, 'edit', 'fase_2', 'fase_2_v1.mp4')), 'novo_final.mp4');
  assert.equal(readFileSync(path.join(novo, 'novo_final.mp4'), 'utf8'), 'unico');
  assert.equal(await publishFinalVideo(novo, path.join(novo, 'nao-existe.mp4')), null, 'falha não estoura');

  // --- Pasta que não existe: poda devolve vazio, sem estourar -------------
  assert.deepEqual(await pruneRenders(path.join(outDir, 'inexistente')), []);

  console.log('test:project-files ok — uma pasta só, 22 versões apagadas, carimbo corrigido e o vídeo do aluno intacto.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
