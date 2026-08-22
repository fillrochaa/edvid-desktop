// Arrumacao da pasta do projeto em disco. Sem Electron de proposito: e o
// codigo que MOVE e APAGA arquivo do aluno, e precisa poder ser rodado contra
// uma pasta de verdade num teste antes de chegar perto da pasta dele.
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EDIT_DIR,
  LEGACY_MOVES,
  RENDER_DIR,
  finalVideoName,
  rendersToDelete,
} from './project-layout';

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

// Remove a pasta SO se ela estiver vazia. Sobra de sistema (.DS_Store, o par
// "._" do macOS, Thumbs.db) nao conta como conteudo: ninguem quer manter uma
// pasta viva por causa de metadado do Finder. Qualquer arquivo de verdade
// dentro dela e motivo para deixar tudo como esta — apagar trabalho do aluno
// por engano seria muito pior do que uma pasta sobrando.
const SYSTEM_LEFTOVER = /^(\.DS_Store|\._.*|Thumbs\.db|desktop\.ini)$/u;

async function removeIfEmpty(directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  if (entries.some((name) => !SYSTEM_LEFTOVER.test(name))) return;
  for (const name of entries) await rm(path.join(directory, name), { force: true }).catch(() => {});
  await rmdir(directory).catch(() => {});
}

function stampFileOf(projectDirectory: string): string {
  return path.join(projectDirectory, EDIT_DIR, 'remotion', 'out', 'render-stamp.json');
}

// O video final na raiz do projeto, com o nome do projeto. E uma COPIA do
// render, nao um atalho: o aluno arrasta esse arquivo para onde quiser e ele
// continua valendo mesmo depois de a pasta de trabalho ser limpa.
export async function publishFinalVideo(projectDirectory: string, rendered: string): Promise<string | null> {
  const name = finalVideoName(path.basename(projectDirectory));
  try {
    await copyFile(rendered, path.join(projectDirectory, name));
    return name;
  } catch {
    // Disco cheio ou pasta somente leitura: o render em si esta salvo, entao
    // isto nunca pode derrubar a edicao.
    return null;
  }
}

// Guarda o render atual e tres anteriores; o resto sai.
//
// Nao e faxina por gosto: um projeto real chegou a 26 arquivos e 543 MB de
// versoes intermediarias, e nenhuma delas tinha valor depois da quarta. O
// arquivo protegido (o recem-criado, ou o que o carimbo aponta) nunca entra
// na conta.
export async function pruneRenders(directory: string, keepName = ''): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of rendersToDelete(files, undefined, keepName)) {
    try {
      await rm(path.join(directory, name), { force: true });
      removed.push(name);
    } catch {
      // Arquivo em uso ou sem permissao: fica onde esta.
    }
  }
  return removed;
}

// Projetos criados antes da unificacao tem "edicao/fase_2" e
// "transcricao_raw" soltos na raiz. Migrar e MOVER, nunca apagar: se o destino
// ja existir com o mesmo nome, o arquivo antigo fica onde esta e quem decide e
// o aluno.
async function migrateLegacyLayout(projectDirectory: string): Promise<void> {
  for (const move of LEGACY_MOVES) {
    const from = path.join(projectDirectory, ...move.from);
    const to = path.join(projectDirectory, ...move.to);
    if (!(await isDirectory(from))) continue;
    try {
      await mkdir(path.dirname(to), { recursive: true });
      if (await isDirectory(to)) {
        for (const name of await readdir(from)) {
          const target = path.join(to, name);
          if (!(await exists(target))) await rename(path.join(from, name), target);
        }
        await removeIfEmpty(from);
      } else {
        await rename(from, to);
      }
    } catch {
      // Volume somente leitura ou arquivo em uso: o projeto continua abrindo
      // com o formato antigo, que o app ainda entende.
    }
  }
  await removeIfEmpty(path.join(projectDirectory, 'edicao'));
}

// O carimbo do render aponta para o caminho ANTIGO depois da migracao. Sem
// corrigir, o app nao acha o resultado e dispara um render sozinho na primeira
// abertura — o mesmo comportamento que ja foi corrigido uma vez e que o aluno
// reclamou ("todas as vezes que abro, o chat comeca a renderizar").
async function repointRenderStamp(projectDirectory: string): Promise<string | null> {
  const file = stampFileOf(projectDirectory);
  let stamp: Record<string, unknown>;
  try {
    stamp = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const output = typeof stamp.output === 'string' ? stamp.output : '';
  if (!output) return null;
  const parts = output.split(/[\\/]/u).filter(Boolean);
  if (parts[0] !== 'edicao' && parts[0] !== 'edição') return path.basename(output);
  const corrected = path.join(EDIT_DIR, RENDER_DIR, path.basename(output));
  try {
    await writeFile(file, `${JSON.stringify({ ...stamp, output: corrected }, null, 2)}\n`);
  } catch {
    return path.basename(output);
  }
  return path.basename(corrected);
}

// Uma pasta so, e sem versao velha ocupando disco. Idempotente: roda a cada
// abertura e conserta tambem os projetos criados antes desta versao.
export async function consolidateProjectFolder(projectDirectory: string): Promise<{
  removed: string[];
  finalVideo: string | null;
}> {
  await migrateLegacyLayout(projectDirectory);
  const keepName = await repointRenderStamp(projectDirectory);
  const renderDirectory = path.join(projectDirectory, EDIT_DIR, RENDER_DIR);
  const removed = await pruneRenders(renderDirectory, keepName ?? '');
  // O projeto pode ter renderizado antes de o video final existir: se o
  // carimbo aponta um render vivo e a raiz nao tem o final, publica agora.
  let finalVideo: string | null = null;
  if (keepName) {
    const rendered = path.join(renderDirectory, keepName);
    const target = path.join(projectDirectory, finalVideoName(path.basename(projectDirectory)));
    if ((await exists(rendered)) && !(await exists(target))) {
      finalVideo = await publishFinalVideo(projectDirectory, rendered);
    }
  }
  return { removed, finalVideo };
}
