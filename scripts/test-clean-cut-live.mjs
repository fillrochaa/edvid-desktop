// Corte limpo DE VERDADE: monta um projeto, roda WhisperX, o helper de corte e
// o FFmpeg com os runtimes empacotados, e mede o vídeo que sai.
//
// O teste de plano garante que os comandos estão certos no papel. Este garante
// que eles funcionam na máquina — que é onde o defeito aparece. Pula sozinho
// quando o pacote de runtimes não está instalado (CI, máquina limpa).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = platform() === 'darwin' ? 'darwin-arm64' : 'win32-x64';
const appData = platform() === 'darwin'
  ? path.join(homedir(), 'Library', 'Application Support', 'Edvid')
  : path.join(homedir(), 'AppData', 'Roaming', 'Edvid');
const tools = path.join(appData, 'runtime', 'tools', target);
const exe = platform() === 'win32' ? '.exe' : '';
const python = path.join(tools, 'python-whisperx', 'python', 'bin', `python3.12${exe}`);
const ffmpeg = path.join(tools, 'ffmpeg', 'bin', `ffmpeg${exe}`);
const fonte = process.env.EDVID_TEST_VIDEO;

if (!existsSync(python) || !existsSync(ffmpeg)) {
  console.log('test:clean-cut-live pulado — pacote de runtimes não instalado nesta máquina.');
  process.exit(0);
}
if (!fonte || !existsSync(fonte)) {
  console.log('test:clean-cut-live pulado — defina EDVID_TEST_VIDEO com um vídeo falado.');
  process.exit(0);
}

const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-cut-live-'));

try {
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(projectRoot, 'src', 'clean-cut.ts'),
    '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const { cleanCutArgs, cleanCutSummary, ffmpegCutArgs, parseEdl, whisperxArgs } = await import(
    pathToFileURL(path.join(outDir, 'clean-cut.js')).href
  );

  // O MESMO ambiente que o aplicativo monta: caches dentro dos dados do app e
  // rede desligada. Se faltar algo aqui, o WhisperX tenta baixar e falha.
  const env = {
    ...process.env,
    HF_HOME: path.join(appData, 'cache', 'huggingface'),
    HUGGINGFACE_HUB_CACHE: path.join(appData, 'cache', 'huggingface', 'hub'),
    TORCH_HOME: path.join(appData, 'cache', 'torch'),
    XDG_CACHE_HOME: path.join(appData, 'cache', 'xdg'),
    MPLCONFIGDIR: path.join(appData, 'cache', 'matplotlib'),
    HF_HUB_OFFLINE: '1',
    PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const rodar = (comando, args, nome) => {
    const r = spawnSync(comando, args, { env, encoding: 'utf8', timeout: 20 * 60_000 });
    assert.equal(r.status, 0, `${nome} falhou: ${(r.stderr || '').trim().split('\n').at(-1)}`);
    return r;
  };

  // Projeto de mentira com um recorte curto do vídeo real.
  const projeto = path.join(outDir, 'projeto');
  const edit = path.join(projeto, 'edit');
  const transcricoes = path.join(edit, 'transcricao_raw');
  mkdirSync(transcricoes, { recursive: true });
  const media = path.join(projeto, 'fala.mp4');
  rodar(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '3', '-t', '20', '-i', fonte,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-vf', 'scale=480:-2', '-c:a', 'aac', media], 'recorte');

  // 1. Transcrição offline, com alinhamento por palavra.
  rodar(python, whisperxArgs({ media, model: 'small', outputDirectory: transcricoes }), 'whisperx');
  const transcript = path.join(transcricoes, 'fala.json');
  assert.ok(existsSync(transcript), 'a transcrição precisa sair com o nome do vídeo');
  const palavras = JSON.parse(await readFile(transcript, 'utf8'));
  const primeiras = (palavras.segments ?? []).flatMap((s) => s.words ?? []);
  assert.ok(primeiras.length > 5, 'sem palavras alinhadas o corte não tem como ser decidido');
  assert.ok(
    primeiras.every((w) => w.start === undefined || Number.isFinite(w.start)),
    'palavra sem tempo quebra o helper',
  );

  // 2. O helper decide os cortes pelo silêncio real.
  const edlFile = path.join(edit, 'edl.json');
  const helper = rodar(python, cleanCutArgs({
    helper: path.join(projectRoot, 'resources', 'helpers', 'clean_cut.py'),
    files: [{ transcript, media, source: 'fala.mp4' }],
    output: edlFile,
  }), 'clean_cut');
  assert.ok(/blocos mantidos/u.test(helper.stdout), `resumo do helper: ${helper.stdout}`);
  const edl = parseEdl(JSON.parse(await readFile(edlFile, 'utf8')));
  assert.ok(edl, 'o EDL precisa ter blocos');
  assert.ok(edl.total_duration_s < 20, 'um corte que não remove nada NÃO é corte limpo');
  assert.ok(edl.total_duration_s > 1, 'o corte não pode comer a fala inteira');
  for (const range of edl.ranges) {
    assert.ok(range.end > range.start && range.end <= 20.5, `bloco fora da fonte: ${JSON.stringify(range)}`);
  }

  // 3. Corte e concatenação numa passagem.
  const corte = path.join(edit, 'corte_limpo.mp4');
  rodar(ffmpeg, ffmpegCutArgs({
    inputs: [media], ranges: edl.ranges, sourceIndex: { 'fala.mp4': 0 }, output: corte,
  }), 'corte');
  assert.ok(existsSync(corte), 'o corte limpo precisa existir no disco');

  // O vídeo que saiu bate com o que o EDL prometeu, e tem áudio junto.
  const ffprobe = path.join(path.dirname(ffmpeg), `ffprobe${exe}`);
  const sonda = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type', '-of', 'json', corte], { encoding: 'utf8' });
  const info = JSON.parse(sonda.stdout);
  const duracao = Number(info.format.duration);
  assert.ok(
    Math.abs(duracao - edl.total_duration_s) < 0.5,
    `o vídeo saiu com ${duracao}s e o corte prometia ${edl.total_duration_s}s`,
  );
  const tipos = info.streams.map((s) => s.codec_type).sort();
  assert.deepEqual(tipos, ['audio', 'video'], 'corte sem áudio é corte quebrado');

  const resumo = cleanCutSummary(edl, 20);
  assert.ok(/\bcorte\b/iu.test(resumo) && /\baprove\b/iu.test(resumo));
  console.log(`test:clean-cut-live ok — ${edl.ranges.length} blocos, ${duracao.toFixed(2)}s de 20s. ${resumo}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
