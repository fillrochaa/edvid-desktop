// Formato das imagens geradas por IA. Modulo puro: quem chama so passa o USO
// da imagem na edicao e recebe o tamanho a pedir para o provedor.
//
// Por que USO e nao proporcao: quando o vocabulario era "4:3", "9:16", "1:1",
// o agente escolhia o numero e errava — imagem 9:16 numa faixa larga entrava
// cortadissima, foi o defeito visto em uso real. Nomeando o uso, quem decide
// pixel e o Edvid, que sabe onde a imagem vai cair no quadro.

// A MESMA divisa do template (Main.tsx exporta SPLIT_DIVIDER). Os dois
// projetos nao compartilham codigo — o template e um pacote separado, montado
// dentro do projeto do aluno —, entao a constante vive duas vezes e o teste
// scripts/test-split-layout.mjs falha se elas se separarem.
export const SPLIT_DIVIDER = 0.39;

export type ImageUse =
  | 'tela-cheia'
  | 'tela-dividida'
  | 'tela-dividida-base'
  | 'paisagem'
  | 'quadrada';

// Nomes antigos aceitos: projetos e pedidos.json de sessoes anteriores usam a
// proporcao crua. "4:3" nasceu justamente como o apelido da tela dividida.
const ALIASES: Record<string, ImageUse> = {
  '9:16': 'tela-cheia',
  '16:9': 'paisagem',
  '1:1': 'quadrada',
  '4:3': 'tela-dividida',
  'tela-cheia': 'tela-cheia',
  'tela-dividida': 'tela-dividida',
  'tela-dividida-base': 'tela-dividida-base',
  paisagem: 'paisagem',
  quadrada: 'quadrada',
};

export function imageUse(raw: string | null | undefined): ImageUse | null {
  const key = String(raw ?? '').trim().toLocaleLowerCase('pt-BR');
  return ALIASES[key] ?? null;
}

// Proporcao (largura / altura) da FAIXA que a imagem vai ocupar num 9:16.
// Com a divisa em 0,39: a faixa de cima e 1080x749 (1,44) e a de baixo e
// 1080x1171 (0,92). Sao formatos diferentes — pedir os dois iguais era o que
// deixava a imagem invertida esticada.
export function bandAspect(use: ImageUse, divider = SPLIT_DIVIDER): number {
  if (use === 'tela-dividida') return 1 / divider * (9 / 16);
  if (use === 'tela-dividida-base') return 1 / (1 - divider) * (9 / 16);
  if (use === 'paisagem') return 16 / 9;
  if (use === 'quadrada') return 1;
  return 9 / 16;
}

// Tamanhos que a API de imagens da OpenAI aceita. Nao ha formato livre: cada
// uso cai no vizinho mais proximo, e o template enquadra por cover.
const OPENAI_SIZES: Record<ImageUse, string> = {
  'tela-cheia': '1024x1536',
  paisagem: '1536x1024',
  quadrada: '1024x1024',
  // 1,44 -> 3:2 (1,5) e o paisagem mais proximo.
  'tela-dividida': '1536x1024',
  // 0,92 -> o quadrado e o vizinho; um 9:16 aqui entra cortado nas laterais.
  'tela-dividida-base': '1024x1024',
};

export function openAiSize(use: ImageUse | null): string {
  return OPENAI_SIZES[use ?? 'quadrada'] ?? '1024x1024';
}

// O Gemini so aceita uma lista fechada de proporcoes no imageConfig; e a
// mesma logica do vizinho mais proximo.
const GEMINI_ASPECTS: Record<ImageUse, string> = {
  'tela-cheia': '9:16',
  paisagem: '16:9',
  quadrada: '1:1',
  'tela-dividida': '3:2',
  'tela-dividida-base': '1:1',
};

export function geminiAspect(use: ImageUse | null): string | null {
  return use ? GEMINI_ASPECTS[use] ?? null : null;
}

// Provedores que aceitam largura e altura livres (Cloudflare Workers AI).
// Multiplos de 8 e teto de 1536 no maior lado — o suficiente para uma faixa
// de 1080 de largura sem estourar o tempo de geracao gratuita.
export function pixelSize(use: ImageUse | null): { width: number; height: number } {
  const aspect = bandAspect(use ?? 'quadrada');
  const round8 = (v: number): number => Math.max(256, Math.min(1536, Math.round(v / 8) * 8));
  return aspect >= 1
    ? { width: round8(1280), height: round8(1280 / aspect) }
    : { width: round8(1024 * aspect), height: round8(1024) };
}

// Frase acrescentada ao prompt. Modelo de imagem obedece muito mais a uma
// instrucao de enquadramento em texto do que ao tamanho pedido: sem isso o
// assunto vinha centralizado e a faixa cortava a cabeca dele.
export function framingHint(use: ImageUse | null): string {
  if (use === 'tela-dividida') {
    return 'Wide horizontal banner composition, roughly 3:2. The subject must fit entirely inside a short, wide strip — keep important elements away from the top and bottom edges.';
  }
  if (use === 'tela-dividida-base') {
    return 'Nearly square composition, slightly taller than wide. The subject must fit entirely inside the frame — keep important elements away from the edges.';
  }
  if (use === 'tela-cheia') {
    return 'Vertical 9:16 full-screen composition for a mobile video.';
  }
  return '';
}

export function promptWithFraming(prompt: string, use: ImageUse | null): string {
  const hint = framingHint(use);
  return hint ? `${prompt.trim()}\n\n${hint}` : prompt.trim();
}
