// O pedido de trilha, derivado do que o vídeo DIZ.
//
// O primeiro pedido era fixo: "instrumental leve e moderno, sem vocal". Serve
// para qualquer vídeo, ou seja, não serve para nenhum. Aqui o clima sai da
// própria transcrição — assunto pelas palavras, energia pelo ritmo da fala,
// estrutura pela duração. Módulo puro, sem rede: o mesmo vídeo sempre gera o
// mesmo pedido.

// Volume da trilha por baixo da voz, em amplitude.
//
// Era 0,0445 — que é -27 dB, e não os -15 que a conversa supunha. O pedido foi
// subir 5 dB, então 0,0445 x 10^(5/20) = 0,079, ou -22 dB. Um -10 dB absoluto
// seria 0,316: sete vezes mais alto que hoje e disputando com a fala.
export const SOUNDTRACK_VOLUME = 0.079;

type Theme = {
  id: string;
  // Palavras que denunciam o assunto. Sem acento e em minúscula: a comparação
  // é feita sobre o texto normalizado.
  words: string[];
  brief: string;
};

// A ordem importa: o primeiro tema com mais acertos vence, e empate fica com
// quem está mais acima.
const THEMES: Theme[] = [
  {
    id: 'tecnologia',
    words: ['iphone', 'android', 'celular', 'smartphone', 'app', 'aplicativo', 'tecnologia',
      'processador', 'camera', 'tela', 'bateria', 'inteligencia', 'artificial', 'ia', 'chip',
      'lancamento', 'apple', 'samsung', 'google', 'software', 'atualizacao', 'gadget'],
    brief: 'modern electronic bed with clean synth pads and a steady programmed pulse, polished and tech-forward',
  },
  {
    id: 'negocios',
    words: ['preco', 'precos', 'dolar', 'real', 'imposto', 'caro', 'barato', 'venda', 'vender',
      'cliente', 'clientes', 'negocio', 'empresa', 'mercado', 'investimento', 'dinheiro',
      'lucro', 'custo', 'aumento'],
    brief: 'confident corporate bed with muted piano and soft percussion, forward-moving but never busy',
  },
  {
    id: 'ensino',
    words: ['aprender', 'aprenda', 'ensinar', 'passo', 'tutorial', 'curso', 'aula', 'dica',
      'dicas', 'explicar', 'entender', 'exemplo', 'metodo', 'tecnica'],
    brief: 'light instructional bed with warm keys and gentle plucks, curious and unhurried',
  },
  {
    id: 'historia',
    words: ['eu', 'senti', 'sentimento', 'medo', 'sonho', 'familia', 'vida', 'historia',
      'aconteceu', 'lembro', 'dificil', 'consegui', 'mudou'],
    brief: 'intimate cinematic bed with sparse piano and soft strings, reflective and warm',
  },
];

const FALLBACK_BRIEF = 'clean modern instrumental bed, light and unobtrusive';

export function normalize(text: string): string[] {
  const lowered = text.toLocaleLowerCase('pt-BR').normalize('NFD');
  const stripped = [...lowered].filter((char) => !/\p{Mn}/u.test(char)).join('');
  return stripped.match(/[a-z0-9]+/gu) ?? [];
}

export function detectTheme(words: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  let best: Theme | null = null;
  let bestScore = 0;
  for (const theme of THEMES) {
    const score = theme.words.reduce((total, word) => total + (counts.get(word) ?? 0), 0);
    if (score > bestScore) {
      best = theme;
      bestScore = score;
    }
  }
  // Duas ocorrências é o mínimo para não classificar por acaso: um "eu" solto
  // não faz o vídeo virar história pessoal.
  return best && bestScore >= 2 ? best.id : '';
}

// Palavras por minuto da fala: fala rápida pede batida mais viva, fala pausada
// pede espaço. É medida do próprio vídeo, não gosto.
export function energyFor(wordCount: number, durationSec: number): string {
  if (durationSec <= 0 || wordCount === 0) return 'medium tempo around 100 BPM';
  const perMinute = (wordCount / durationSec) * 60;
  if (perMinute >= 165) return 'brisk tempo around 120 BPM to match fast delivery';
  if (perMinute <= 115) return 'calm tempo around 85 BPM with room to breathe';
  return 'medium tempo around 100 BPM';
}

export function musicBrief(transcript: string, durationSec: number): string {
  const words = normalize(transcript);
  const theme = detectTheme(words);
  const brief = THEMES.find((item) => item.id === theme)?.brief ?? FALLBACK_BRIEF;
  return [
    `Instrumental background music for a ${Math.round(durationSec)} second vertical talking-head video.`,
    `Style: ${brief}.`,
    energyFor(words.length, durationSec) + '.',
    // Sem isto o modelo devolve música de primeiro plano e a fala some.
    'No vocals, no lyrics, no sudden drops or risers. It must sit under a speaking voice the whole time, with a consistent level and no long silences.',
  ].join(' ');
}
