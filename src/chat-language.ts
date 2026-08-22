// A conversa do chat SEMPRE em portugues do Brasil e sem termo tecnico.
//
// A regra ja esta escrita nas instrucoes do agente (regra 1 e regra 2), mas
// instrucao nao e garantia: um modelo pequeno responde em ingles e lista
// arquivo por arquivo. Caso real visto pelo aluno, palavra por palavra:
//   "Could you clarify what "trilha" you'd like to continue generating?"
//   "- Increased the volume of `edit/musica/trilha.mp3` by 5 dB using ffmpeg."
// Entao quem garante e o aplicativo, aqui: mede a lingua da resposta, limpa o
// que e tecnico e devolve o texto que o aluno pode ler. Modulo puro, sem
// Electron nem rede, para o teste medir o comportamento de verdade.

// Grudado em CADA mensagem do aluno, e nao so nas instrucoes iniciais: um
// modelo pequeno esquece o topo do contexto, mas nunca a ultima linha que
// leu. Curto de proposito — lembrete, nao briefing.
export const PT_BR_TURN_REMINDER =
  '\n\n[Responda em portugues do Brasil, como um editor de video falando com o aluno. Nada de ingles, caminho de arquivo, nome de campo, comando ou nome de ferramenta na resposta.]';

// Pedido de reescrita, usado quando a resposta veio em ingles mesmo assim.
export function rewritePrompt(text: string): string {
  return [
    'Reescreva a mensagem abaixo em portugues do Brasil, mantendo EXATAMENTE o mesmo conteudo e a mesma intencao (se for uma pergunta, continue sendo a mesma pergunta).',
    'Fale como um editor de video conversando com o aluno. Nao use caminho de arquivo, nome de campo, comando, codigo nem nome de ferramenta.',
    'Responda somente com o texto reescrito, sem aspas e sem comentarios.',
    '',
    text,
  ].join('\n');
}

// Palavras-funcao. So entram as que NAO existem na outra lingua: "a", "e" e
// "no" aparecem nas duas e envenenariam a contagem.
const EN_MARKERS = /\b(the|and|of|to|is|are|was|were|with|for|you|your|this|that|it|its|file|files|please|could|would|should|using|used|have|has|been|will|can|what|which|there|from|they|then|here|about|need|make|made|let|know|generate|generated|volume|original|replaced|version|instead)\b/giu;
const PT_MARKERS = /\b(que|nao|não|para|com|uma|uns|umas|voce|você|seu|sua|ja|já|foi|esta|está|estao|estão|do|da|dos|das|ao|aos|pelo|pela|sem|mais|isso|aqui|agora|entao|então|video|vídeo|edicao|edição|trilha|corte|legenda|imagem|animacao|animação|pronto|feito|apliquei|coloquei|deixei|tirei)\b/giu;

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

// A resposta esta em ingles? Conservador de proposito: na duvida diz que NAO,
// porque uma reescrita desnecessaria custa uma ida ao modelo e uma resposta
// em portugues marcada como inglesa seria substituida a toa.
export function looksEnglish(text: string): boolean {
  const clean = text.replace(/```[\s\S]*?```/gu, ' ').trim();
  if (clean.length < 12) return false;
  const en = count(clean, EN_MARKERS);
  const pt = count(clean, PT_MARKERS);
  if (en === 0) return false;
  if (pt === 0) return en >= 2;
  return en >= 3 && en > pt * 2;
}

// --- Limpeza do que e tecnico ----------------------------------------------

const TOOL_PLAIN: Record<string, string> = {
  ffmpeg: 'o Edvid',
  ffprobe: 'o Edvid',
  whisperx: 'a transcrição',
  remotion: 'o motor de edição',
  npm: 'as ferramentas do Edvid',
  node: 'as ferramentas do Edvid',
  python: 'as ferramentas do Edvid',
  python3: 'as ferramentas do Edvid',
  uv: 'as ferramentas do Edvid',
  'yt-dlp': 'as ferramentas do Edvid',
  tsc: 'as ferramentas do Edvid',
  chromium: 'o motor de edição',
};

// Nome de arquivo vira o que ele E para o aluno. "trilha.mp3" nao diz nada;
// "a trilha sonora" diz.
function plainForFile(filePath: string): string {
  const lower = filePath.toLocaleLowerCase('pt-BR');
  const base = lower.split(/[\\/]/u).at(-1) ?? lower;
  const extension = base.includes('.') ? base.split('.').at(-1) ?? '' : '';
  if (/(^|[\\/])musica([\\/]|$)/u.test(lower) || base.startsWith('trilha')) return 'a trilha sonora';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(extension)) return 'o áudio';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(extension)) return 'o vídeo';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'a imagem';
  if (extension === 'json') return 'os dados da edição';
  if (['tsx', 'ts', 'js', 'jsx'].includes(extension)) return 'o código da animação';
  if (extension === 'py') return 'as ferramentas do Edvid';
  return 'o arquivo';
}

// Caminho (com barra) ou nome de arquivo solto com extensao conhecida.
const FILE_PATTERN =
  /(?:[A-Za-z]:\\|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.(?:mp3|wav|m4a|aac|ogg|mp4|mov|webm|mkv|png|jpe?g|webp|gif|json|tsx?|jsx?|py|toml|txt|log|md|ass|srt)\b/giu;

// Preposicao + artigo colados, para a frase nao sair "de a trilha sonora".
function fixContractions(text: string): string {
  return text
    .replace(/\bde a\b/giu, 'da')
    .replace(/\bde o\b/giu, 'do')
    .replace(/\bde as\b/giu, 'das')
    .replace(/\bde os\b/giu, 'dos')
    .replace(/\bem a\b/giu, 'na')
    .replace(/\bem o\b/giu, 'no')
    .replace(/\bem as\b/giu, 'nas')
    .replace(/\bem os\b/giu, 'nos')
    .replace(/\bpara a a\b/giu, 'para a')
    .replace(/\ba a\b/giu, 'à');
}

export function stripTechnical(input: string): string {
  let text = input;
  // Bloco de codigo inteiro: nunca tem lugar na conversa.
  text = text.replace(/```[\s\S]*?```/gu, ' ');
  // Quadro de pilha e linha de comando colada.
  text = text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*at\s+\S+.*\(?.*:\d+:\d+\)?\s*$/u.test(line))
    .filter((line) => !/^\s*[$>#]\s*\S/u.test(line))
    .join('\n');
  // Variavel de ambiente das ferramentas e opcao de linha de comando.
  text = text.replace(/\$(?:env:)?EDVID_[A-Z_]+/gu, 'as ferramentas do Edvid');
  text = text.replace(/(?:^|\s)--?[a-z][\w-]*(?:=\S+)?/giu, ' ');
  // Objeto JSON solto no meio da frase e par "campo": valor.
  text = text.replace(/\{[^{}]*"[^"]+"\s*:[^{}]*\}/gu, ' ');
  text = text.replace(/"[\w.-]+"\s*:\s*/gu, '');
  // Crase: o conteudo pode ficar, a marcacao nao.
  text = text.replace(/`{1,2}([^`]*)`{1,2}/gu, '$1');
  // Caminho e nome de arquivo viram o que eles sao.
  text = text.replace(FILE_PATTERN, (match) => plainForFile(match));
  // Pasta sem extensao (edit/remotion/public/) tambem some.
  text = text.replace(/\b(?:edit|edicao|edição|public|remotion|src|imagens|musica)(?:[\\/][\w.-]+)+[\\/]?/giu, 'a pasta do projeto');
  // "usando ffmpeg", "with remotion": a ferramenta sai junto com a clausula.
  text = text.replace(
    /[,;]?\s*(?:usando|utilizando|com o|com a|via|through|using|with)\s+\*{0,2}(ffmpeg|ffprobe|whisperx|remotion|npm|node|python3?|uv|yt-dlp|tsc|chromium)\*{0,2}/giu,
    '',
  );
  // Mencao solta da ferramenta vira linguagem de gente.
  text = text.replace(
    /\*{0,2}\b(ffmpeg|ffprobe|whisperx|remotion|npm|node|python3?|uv|yt-dlp|tsc|chromium)\b\*{0,2}/giu,
    (_match, tool: string) => TOOL_PLAIN[tool.toLocaleLowerCase('pt-BR')] ?? 'as ferramentas do Edvid',
  );
  text = fixContractions(text);
  // Sobras da limpeza: espaco duplo, bullet vazio, pontuacao solta.
  text = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/[ \t]{2,}/gu, ' ').replace(/\s+([.,;:!?])/gu, '$1').trimEnd())
    .filter((line) => !/^\s*[-*•]\s*[.,;:]?\s*$/u.test(line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return text;
}

// Ultimo recurso: a resposta veio em ingles e a reescrita nao resolveu (ou nao
// havia como pedir). Nunca inventa que a edicao foi feita — dizer "pronto"
// sem saber seria mentir para o aluno.
export const LANGUAGE_FALLBACK =
  'Não consegui escrever esta resposta em português. O que você pediu pode ter sido feito mesmo assim — confira o vídeo e a linha do tempo. Se preferir, troque a IA do chat no seletor abaixo do campo de texto.';

export type SanitizedMessage = {
  text: string;
  // true quando o texto continua em ingles depois da limpeza: quem chama
  // decide se pede reescrita ao modelo ou usa o LANGUAGE_FALLBACK.
  english: boolean;
};

export function sanitizeAssistantText(input: string): SanitizedMessage {
  const text = stripTechnical(input);
  return { text, english: looksEnglish(text) };
}
