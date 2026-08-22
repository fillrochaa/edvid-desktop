// Catalogo de IAs conectaveis e escolha de quem atende cada papel.
//
// A ideia veio do OmniRoute: em vez de tres provedores fixos, o aluno conecta
// as contas que tiver — de preferencia as de camada gratuita — e o Edvid
// escolhe sozinho, trocando de provedor quando um bate no limite. Modulo PURO
// de proposito: a decisao de "quem gera esta imagem" precisa ser testavel sem
// rede, sem Electron e sem chave de ninguem.
//
// Levantamento que definiu o catalogo inicial (agosto/2026, medido na API de
// cada um, nao em promessa de marketing):
// - OpenRouter tem 11 modelos de imagem e NENHUM gratuito; serve por dar
//   muitos modelos com uma chave so, e o mais barato sai por fracao de centavo.
// - Gemini nao tem camada gratuita para imagem — todo modelo de imagem e pago.
// - Cloudflare Workers AI e quem realmente entrega imagem de graca: 10 mil
//   neurons por dia (~2 mil imagens FLUX.1 Schnell 512x512).

export type AiCapability = 'texto' | 'imagem' | 'video' | 'musica' | 'voz';

// Como a conta e cobrada. "mixed" e o caso do OpenRouter: a mesma chave da
// acesso a modelo gratuito e pago, e por isso existe o filtro do aluno.
export type AiPricing = 'free' | 'paid' | 'mixed';

export type AiCredentialField = {
  key: string;
  label: string;
  // Campo que nao e a chave em si (ex.: o Account ID da Cloudflare). Fica
  // visivel na interface; a chave, nunca.
  secret: boolean;
  placeholder?: string;
};

// Como o aluno entra. "login" e o fluxo pelo navegador com a conta que ele ja
// paga; "apikey" e a chave colada. Hoje so ChatGPT e Claude tem login.
export type AiAuthMode = 'login' | 'apikey';

export type AiCatalogEntry = {
  id: string;
  name: string;
  capabilities: AiCapability[];
  pricing: AiPricing;
  // Formas de conexao oferecidas no modal, na ordem em que aparecem.
  auth: AiAuthMode[];
  // Provedores que o aplicativo ja conduzia antes do catalogo (ChatGPT, Claude
  // e Gemini): a conexao deles tem fluxo proprio no main, mas o CARD e o modal
  // sao os mesmos dos demais — era isso que fazia a tela ter duas listas.
  builtIn?: 'chatgpt' | 'claude' | 'gemini';
  // Pagina onde o aluno cria a chave. O catalogo leva ele ate la.
  keyUrl: string;
  credentials: AiCredentialField[];
  // Modelos por papel, na ordem de preferencia. `free` marca o que nao gasta
  // dinheiro do aluno — e o que sobra quando ele liga "apenas gratuitos".
  models: { id: string; label: string; capability: AiCapability; free: boolean }[];
  // Endpoint no formato da OpenAI. Quem tem isto pode virar MOTOR DO CHAT: o
  // Codex aceita provedores proprios em [model_providers] e o agente inteiro
  // (sandbox, ferramentas, instrucoes) continua funcionando por cima.
  openaiBaseUrl?: string;
  // Nome da variavel de ambiente onde o Codex procura a chave desse provedor.
  envKey?: string;
  note?: string;
};

export const AI_CATALOG: AiCatalogEntry[] = [
  // Os tres primeiros ja existiam como "Conexao de IA"; entraram no catalogo
  // para a tela ter UMA lista so, com o mesmo card e o mesmo modal.
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    capabilities: ['texto', 'imagem'],
    pricing: 'mixed',
    auth: ['login', 'apikey'],
    builtIn: 'chatgpt',
    keyUrl: 'https://platform.openai.com/api-keys',
    credentials: [{ key: 'apiKey', label: 'Chave de API', secret: true }],
    models: [],
    note: 'Entrando com a assinatura, as imagens saem da cota do plano; por chave, são cobradas por imagem.',
  },
  {
    id: 'claude',
    name: 'Claude',
    capabilities: ['texto'],
    pricing: 'mixed',
    auth: ['login', 'apikey'],
    builtIn: 'claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    credentials: [{ key: 'apiKey', label: 'Chave de API', secret: true }],
    models: [],
    note: 'Conduz a conversa e a edição. Não gera imagens.',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    capabilities: ['texto', 'imagem'],
    pricing: 'mixed',
    auth: ['apikey'],
    builtIn: 'gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    credentials: [{ key: 'apiKey', label: 'Chave de API', secret: true }],
    models: [],
    note: 'Chave do Google AI Studio. MEDIDO em conta real: a chave NÃO gera imagem na camada gratuita — o Google responde que a cota acabou. Serve para texto; para imagem grátis, use a Cloudflare.',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    capabilities: ['imagem', 'texto'],
    pricing: 'free',
    auth: ['apikey'],
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    credentials: [
      { key: 'accountId', label: 'Account ID', secret: false, placeholder: 'ID da conta Cloudflare' },
      { key: 'apiKey', label: 'API Token', secret: true },
    ],
    models: [
      { id: '@cf/black-forest-labs/flux-1-schnell', label: 'FLUX.1 Schnell', capability: 'imagem', free: true },
    ],
    note: 'Camada gratuita diária generosa (cerca de 2 mil imagens por dia).',
  },
  {
    id: 'ollama',
    name: 'Ollama Cloud',
    capabilities: ['texto'],
    pricing: 'mixed',
    auth: ['apikey'],
    keyUrl: 'https://ollama.com/settings/keys',
    credentials: [{ key: 'apiKey', label: 'Chave de API', secret: true }],
    openaiBaseUrl: 'https://ollama.com/v1',
    envKey: 'OLLAMA_API_KEY',
    models: [
      // Sondado em ollama.com/api/tags. Modelos grandes de texto, sem imagem.
      { id: 'gpt-oss:120b', label: 'GPT-OSS 120B', capability: 'texto', free: true },
      { id: 'qwen3.5:397b', label: 'Qwen3.5 397B', capability: 'texto', free: true },
      { id: 'deepseek-v4-flash:preview', label: 'DeepSeek V4 Flash', capability: 'texto', free: true },
    ],
    // Fala o formato da OpenAI em https://ollama.com/v1/chat/completions
    // (verificado: responde 401 sem chave, 200 em /v1/models) — e por isso
    // pode virar motor do chat quando o papel de texto entrar no catalogo.
    note: 'Modelos grandes de texto na nuvem. Não gera imagem.',
  },
  {
    id: 'treblo',
    name: 'Treblo',
    capabilities: ['musica'],
    pricing: 'mixed',
    auth: ['apikey'],
    keyUrl: 'https://treblo.com/developers',
    credentials: [{ key: 'apiKey', label: 'Chave de API', secret: true }],
    models: [
      // Sondado: POST api.treblo.com/v1/generations/v3 com
      // "Authorization: Bearer <chave>" (a propria API diz que o header
      // precisa comecar com "Bearer ").
      { id: 'melodia-v3', label: 'Melodia v3', capability: 'musica', free: false },
    ],
    note: 'Trilha sonora sob medida. Créditos gratuitos no cadastro; depois é por assinatura.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    capabilities: ['texto', 'imagem'],
    pricing: 'mixed',
    auth: ['apikey'],
    keyUrl: 'https://openrouter.ai/keys',
    credentials: [{ key: 'apiKey', label: 'Chave de API', secret: true }],
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    models: [
      { id: 'openai/gpt-oss-120b:free', label: 'GPT-OSS 120B (grátis)', capability: 'texto', free: true },
      { id: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', capability: 'imagem', free: false },
      { id: 'openai/gpt-5-image-mini', label: 'GPT-5 Image Mini', capability: 'imagem', free: false },
    ],
    note: 'Uma chave, muitos modelos. Os modelos de imagem são pagos (frações de centavo por imagem).',
  },
];

export type ConnectedProvider = {
  id: string;
  // Provedor conectado mas em descanso ate este horario (bateu no limite).
  cooldownUntil?: number | null;
};

export type RouteRequest = {
  capability: AiCapability;
  connected: ConnectedProvider[];
  // Ligado pelo aluno: so entra modelo que nao gasta dinheiro dele.
  freeOnly: boolean;
  // Agora, em ms. Recebido de fora para o modulo continuar puro.
  now: number;
};

export type RouteChoice = {
  providerId: string;
  providerName: string;
  modelId: string;
  modelLabel: string;
  free: boolean;
};

export function catalogEntry(providerId: string): AiCatalogEntry | null {
  return AI_CATALOG.find((entry) => entry.id === providerId) ?? null;
}

// Todos os candidatos capazes de atender o papel, do melhor para o pior.
// Ordem: gratuito antes de pago (o aluno nao paga sem precisar) e, dentro do
// mesmo preco, a ordem em que o provedor aparece no catalogo.
export function routeCandidates(request: RouteRequest): RouteChoice[] {
  const candidates: RouteChoice[] = [];
  for (const connected of request.connected) {
    if (connected.cooldownUntil && connected.cooldownUntil > request.now) continue;
    const entry = catalogEntry(connected.id);
    if (!entry) continue;
    for (const model of entry.models) {
      if (model.capability !== request.capability) continue;
      if (request.freeOnly && !model.free) continue;
      candidates.push({
        providerId: entry.id,
        providerName: entry.name,
        modelId: model.id,
        modelLabel: model.label,
        free: model.free,
      });
    }
  }
  return candidates.sort((a, b) => Number(b.free) - Number(a.free));
}

export function routeFor(request: RouteRequest): RouteChoice | null {
  return routeCandidates(request)[0] ?? null;
}

// Erro que significa "tente outro provedor" em vez de "desista": limite de uso
// e indisponibilidade passam; prompt recusado ou chave errada, nao.
export function shouldFailover(status: number | null, message: string): boolean {
  if (status === 429 || (status !== null && status >= 500)) return true;
  return /limit|quota|exceeded|unavailable|sem conexão|timeout|esgotad/iu.test(message);
}

// --- VERIFICACAO DE CHAVE --------------------------------------------------
// Cada provedor tem seu endereco e seu jeito de recusar. Isto vivia como um
// if/else no main com um FALLBACK para o OpenRouter — e o fallback pegava
// todo provedor sem caso proprio: a chave do Gemini era enviada para o
// openrouter.ai, voltava 401 e o aluno lia "Chave recusada pelo provedor"
// sobre uma chave perfeitamente boa. Aqui a tabela e explicita, e provedor
// desconhecido nao vira teste contra o servico errado.
export type KeyProbe = {
  url: string;
  headers: Record<string, string>;
  // Status que significam "a chave nao presta". O Gemini responde 400 com
  // "API key not valid" — 401 nao cobre (medido no endpoint real).
  refusedStatus: number[];
};

export function keyProbe(
  providerId: string,
  credentials: Readonly<Record<string, string>>,
): KeyProbe | null {
  const apiKey = credentials.apiKey ?? '';
  switch (providerId) {
    case 'gemini':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
        headers: {},
        refusedStatus: [400, 401, 403],
      };
    case 'chatgpt':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${apiKey}` },
        refusedStatus: [401, 403],
      };
    case 'claude':
      return {
        url: 'https://api.anthropic.com/v1/models?limit=1',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        refusedStatus: [401, 403],
      };
    case 'ollama':
      return {
        url: 'https://ollama.com/api/tags',
        headers: { Authorization: `Bearer ${apiKey}` },
        refusedStatus: [401, 403],
      };
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/key',
        headers: { Authorization: `Bearer ${apiKey}` },
        refusedStatus: [401, 403],
      };
    case 'cloudflare': {
      const accountId = credentials.accountId ?? '';
      if (!accountId) return null;
      return {
        url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?per_page=1`,
        headers: { Authorization: `Bearer ${apiKey}` },
        refusedStatus: [400, 401, 403],
      };
    }
    default:
      // Treblo tem verificacao propria (POST) e vive no main; qualquer outro
      // provedor novo cai aqui e o teste diz isso, em vez de mentir.
      return null;
  }
}
