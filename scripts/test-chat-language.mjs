// Teste da conversa em portugues e sem termo tecnico.
//
// As duas mensagens medidas aqui sao as que o aluno recebeu de verdade no chat
// (print de 22/08), com o Ollama conduzindo a conversa. Elas sao o criterio:
// se voltarem a passar, o defeito voltou.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'edvid-chat-lang-'));

try {
  const source = path.join(outDir, 'chat-language.ts');
  writeFileSync(source, readFileSync(path.join(projectRoot, 'src', 'chat-language.ts'), 'utf8'));
  execFileSync(process.execPath, [
    path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    source, '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
    '--skipLibCheck', '--outDir', outDir,
  ], { stdio: 'inherit' });
  const {
    LANGUAGE_FALLBACK,
    PT_BR_TURN_REMINDER,
    looksEnglish,
    rewritePrompt,
    sanitizeAssistantText,
    stripTechnical,
  } = await import(pathToFileURL(path.join(outDir, 'chat-language.js')).href);

  // --- 1. As duas mensagens reais do print sao reprovadas -------------------
  const perguntaReal = 'Could you clarify what "trilha" you\'d like to continue generating? For example, is it a log file, a data-processing trace, or something else? Let me know the relevant file or command so I can resume the generation for you.';
  const resumoReal = '- Increased the volume of `edit/musica/trilha.mp3` by 5 dB using **ffmpeg**.\n- The original file was replaced with the louder version (`trilha.mp3`).';
  assert.ok(looksEnglish(perguntaReal), 'a pergunta em ingles do print precisa ser detectada');
  assert.ok(looksEnglish(resumoReal), 'o resumo em ingles do print precisa ser detectado');
  assert.ok(sanitizeAssistantText(perguntaReal).english);
  assert.ok(sanitizeAssistantText(resumoReal).english);

  // --- 2. Portugues de verdade NUNCA e marcado como ingles ------------------
  const boas = [
    'Pronto! Aumentei o volume da trilha sonora em 5 dB.',
    'Tirei a headline da primeira cena e deixei a legenda mais embaixo.',
    'Você quer que eu use a mesma cor de destaque no restante do vídeo?',
    'Fiz o corte limpo: sobraram 12 blocos e saíram 48 segundos de pausa.',
    'Feito.',
    'Ok!',
    'A animação já está na linha do tempo, entre 4s e 7s.',
  ];
  for (const texto of boas) {
    assert.equal(looksEnglish(texto), false, `falso positivo de ingles: ${texto}`);
    assert.equal(sanitizeAssistantText(texto).english, false, `falso positivo apos limpeza: ${texto}`);
  }

  // --- 3. Termo tecnico sai do texto ---------------------------------------
  const comCaminho = 'Aumentei o volume de `edit/musica/trilha.mp3` em 5 dB usando **ffmpeg**.';
  const limpo = stripTechnical(comCaminho);
  assert.ok(!/trilha\.mp3/u.test(limpo), `caminho ficou: ${limpo}`);
  assert.ok(!/ffmpeg/iu.test(limpo), `nome de ferramenta ficou: ${limpo}`);
  assert.ok(!limpo.includes('`'), 'crase nunca vai para o chat');
  assert.ok(/trilha sonora/u.test(limpo), `perdeu o assunto: ${limpo}`);
  assert.ok(!/\bde a\b|\bde o\b/u.test(limpo), `contracao quebrada: ${limpo}`);

  assert.ok(!stripTechnical('Escrevi o campo "soundtrack": true no edit-data.json.').includes('"soundtrack"'));
  assert.ok(!stripTechnical('Rodei com --min-pause 0.45 e --keep 0.12.').includes('--min-pause'));
  assert.ok(!stripTechnical('Chamei "$EDVID_PYTHON" para transcrever.').includes('EDVID_PYTHON'));
  assert.equal(stripTechnical('Feito.\n```json\n{"hook": {"enabled": false}}\n```').trim(), 'Feito.');
  assert.ok(!stripTechnical('Falhou:\n    at process.processTicksAndRejections (node:internal/x.js:1:1)').includes('processTicks'));
  assert.ok(!stripTechnical('Copiei para edit/remotion/public/imagens/ o arquivo.').includes('remotion'));

  // Texto limpo nao pode ser mexido a toa. A limpeza mexe em hifen, aspas e
  // pontuacao, entao aqui entram as formas que o agente usa todo dia.
  const intocaveis = [
    'Coloquei a tela dividida entre 4s e 9s, com a ilustração em cima.',
    '- Tirei a headline\n- Deixei a legenda mais embaixo\n- Subi a trilha 5 dB',
    'Fiz o corte limpo - sobraram 12 blocos.',
    'Mandei o e-mail de pós-produção com o resultado.',
    'Deixei o vídeo em 9:16 e a cor de destaque em #ff5200.',
  ];
  for (const texto of intocaveis) {
    assert.equal(stripTechnical(texto), texto, `mexeu em texto limpo: ${texto}`);
  }

  // --- 4. A limpeza nao pode ESCONDER o ingles ------------------------------
  // Se limpar o caminho apagasse os marcadores, o resumo em ingles passaria
  // batido — exatamente o jeito de o defeito voltar sem ninguem ver.
  assert.ok(sanitizeAssistantText(resumoReal).english, 'ingles nao pode sumir na limpeza');

  // --- 5. Lembrete e pedido de reescrita -----------------------------------
  assert.ok(/portugu[eê]s/iu.test(PT_BR_TURN_REMINDER));
  assert.ok(PT_BR_TURN_REMINDER.length < 300, 'lembrete curto: modelo pequeno ignora paragrafo');
  assert.ok(rewritePrompt(perguntaReal).includes(perguntaReal), 'a reescrita precisa levar o texto original');
  assert.ok(/mesma pergunta/iu.test(rewritePrompt('x')), 'pergunta precisa continuar pergunta');
  // O recurso nunca AFIRMA que a edicao terminou (seria mentira: a resposta
  // descartada podia ser uma pergunta) e sempre manda o aluno conferir.
  assert.ok(!/^\s*(pronto|feito|conclu)/iu.test(LANGUAGE_FALLBACK), 'nao pode abrir afirmando que terminou');
  assert.ok(/confir|confer/iu.test(LANGUAGE_FALLBACK), 'precisa mandar o aluno conferir o resultado');
  assert.ok(/portugu[eê]s/iu.test(LANGUAGE_FALLBACK), 'precisa explicar o que houve');

  console.log('test:chat-language ok — inglês detectado, termo técnico fora e português intacto.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
