import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CodexAccount,
  CodexAccountState,
  CodexApprovalDecision,
  CodexEvent,
  CodexSendMessageResult,
} from './shared';

type RpcId = string | number;

type RpcResponse = {
  id: RpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: RpcResponse['error'];
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingApproval = {
  kind: 'command' | 'file-change';
};

type AccountReadResponse = {
  account: null | {
    type: 'chatgpt' | 'apiKey' | 'amazonBedrock';
    email?: string | null;
    planType?: string | null;
  };
  requiresOpenaiAuth: boolean;
};

type LoginStartResponse =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: string };

type ThreadStartResponse = { thread: { id: string } };
type TurnStartResponse = { turn: { id: string } };

// Modelo fixo do chat. O default do CLI 0.147.0 e gpt-5.6-sol (isDefault no
// model/list), que o backend recusa com 400 em contas ChatGPT. O catalogo do
// proprio binario aponta gpt-5.6-terra como sucessor do antigo padrao
// (upgrade de gpt-5.4), e a sonda confirmou no rollout que tanto o config.toml
// quanto o parametro de thread/start cravam o modelo — com turno real
// COMPLETO em conta ChatGPT. NAO enviar allowProviderModelFallback: com true
// o app-server exige a capability experimentalApi e derruba o thread/start
// (regressao da 0.13.6, vista em producao); se o terra for aposentado um dia,
// o erro de modelo ja chega traduzido pelo friendlyAiError.
const CODEX_CHAT_MODEL = 'gpt-5.6-terra';

// O aluno NUNCA aprova comando: ele veio editar video, nao auditar shell. Isso
// era 'on-request' e no Windows virou enxurrada de pedidos, porque o sandbox de
// la nao consegue impor restricao de arquivo ("windows sandbox backend cannot
// enforce file_system", string do proprio binario) e o Codex escala tudo por
// precaucao. Pior: a thread utilitaria de imagem RECUSA aprovacoes sozinha,
// entao cada pedido virava imagem nao gerada — o ENOENT visto em maquina real.
// Com 'never' o Codex nunca pergunta; o limite continua sendo o sandbox
// workspace-write (escrita so no projeto e nos caches do Edvid) e a rede
// permanece negada.
const CODEX_APPROVAL_POLICY = 'never';

// Sandbox POR PLATAFORMA, e nao por gosto. No macOS o seatbelt impoe
// workspace-write de verdade: o agente escreve no projeto e nos caches, o
// resto e negado, sem perguntar nada. No Windows o backend NAO consegue impor
// restricao de arquivo ("windows sandbox backend cannot enforce file_system")
// e o Codex precisa escolher entre perguntar ou negar: com 'on-request' virava
// enxurrada de aprovacoes, e com 'never' a sessao inteira caiu para SOMENTE
// LEITURA — o agente nao conseguia nem preparar a Fase 2 nem salvar imagem
// (visto em maquina real). Como a restricao la nunca foi real, o unico modo
// que entrega o que o aluno precisa e o acesso direto; o limite pratico
// continua sendo a pasta do projeto, para onde todas as instrucoes apontam.
const CODEX_SANDBOX = process.platform === 'win32' ? 'danger-full-access' : 'workspace-write';

// Compartilhadas com o adaptador Claude: o contrato com a interface e o
// mesmo seja qual for o provedor de IA que conduz a conversa.
export const EDVID_INSTRUCTIONS = `Voce e o agente de edicao do Edvid Desktop. Converse em portugues do Brasil e trate a pasta do projeto como a unica area de trabalho do video. Preserve sempre os arquivos originais. Antes de uma edicao completa, faca primeiro o corte limpo guiado pelo audio e obtenha aprovacao do usuario; depois aplique visuais, legendas, trilha e acabamento.

Contrato obrigatorio com a interface do Edvid:
- O preview reproduz automaticamente o render mais recente que estiver dentro de edit/ ou edicao/. Grave todo resultado nessas pastas e nunca inclua no chat caminhos absolutos, URLs file:// ou links Markdown para arquivos locais.
- Arquivos intermediarios (sem estilo, temporarios, partes) devem ter no nome uma dessas marcas: tmp, temp, parte, chunk, raw ou sem_estilo. Sem isso o preview pode exibir um rascunho no lugar do resultado.
- Depois de qualquer render que altere cortes ou duracao, crie ou atualize edit/edl.json antes de responder. Use ranges com um item para cada cena mantida (beat, start e end nos tempos da fonte). Esse EDL e o que permite a timeline desenhar blocos e cortes reais.
- CORTE LIMPO exige transcricao real: rode o WhisperX antes de cortar e derive os ranges dela. Se a transcricao falhar, PARE — explique o problema em uma frase e nao crie edit/edl.json, nao renderize corte nenhum e nao peca aprovacao. Um EDL que devolve o video inteiro sem remover nada NAO e corte limpo e nunca deve ser apresentado como pronto: a interface so mostra o botao de Aprovado quando material foi removido de verdade.
- QUEM DECIDE OS CORTES E O HELPER OFICIAL, nao voce: "$EDVID_PYTHON" "$EDVID_HELPERS/clean_cut.py" --transcript <transcricao.json> --audio <arquivo de origem> --source <nome da fonte> -o edit/edl.json. Ele mede o silencio real do audio e escreve o edl.json inteiro. Escolher trechos "no olho" pela leitura do texto produz corte grosseiro: o alinhador estica a ultima palavra da frase por cima do silencio, entao o intervalo entre palavras NAO revela a pausa. Com varios arquivos, repita o trio --transcript/--audio/--source por arquivo, na ordem da concatenacao, numa unica chamada. Ajuste apenas se o aluno pedir outro ritmo: --min-pause (pausa minima que vira corte, padrao 0.45s) e --keep (respiracao mantida na borda, padrao 0.12s). Depois do helper, renderize os ranges do edl.json com o FFmpeg e relate ao aluno o resumo que ele imprimiu (quantos blocos, quanto foi removido).
- Quando a pasta tiver mais de um video-fonte, o corte limpo cobre TODOS eles, na ordem alfabetica natural dos nomes (a mesma da timeline): transcreva cada arquivo, corte cada um e concatene tudo num render unico, com edit/edl.json declarando o mapa sources e um range por cena mantida de cada arquivo.
- J-CUT NAO E TAREFA SUA: o Edvid aplica e reaplica o J-cut sozinho, fora do sandbox, remontando apenas o audio do corte (o video fica intacto). Nunca antecipe audio por conta propria, nao escreva o campo jcut_timeline no EDL e nao apague edit/jcut.json nem arquivos *-sem-jcut-tmp* — sao o estado e o backup dessa aplicacao.
- Node, npm, FFmpeg, FFprobe, uv, yt-dlp, Python e WhisperX ja estao empacotados. Nunca crie uma .venv e nunca execute pip install.
- SEMPRE chame essas ferramentas pelas VARIAVEIS DE AMBIENTE com o caminho completo, nunca pelo nome solto: "$EDVID_PYTHON" (nao python3), "$EDVID_FFMPEG" (nao ffmpeg), "$EDVID_FFPROBE", "$EDVID_UV", "$EDVID_YTDLP", e a pasta de helpers em "$EDVID_HELPERS". No macOS o shell reordena o PATH e um "python3" solto cai no Python do sistema, que NAO tem o WhisperX — foi assim que o corte falhou em maquina real. No PowerShell a sintaxe e outra: & $env:EDVID_PYTHON -m whisperx ... e "$env:EDVID_HELPERS/arquivo.py".
- Para transcrever use "$EDVID_PYTHON" -m whisperx com o modelo indicado em EDVID_WHISPER_MODEL e SEMPRE com --language pt: o modelo de transcricao e o de alinhamento em portugues ja estao baixados no cache do aplicativo e o ambiente roda offline — nao baixe modelos, nao mude o cache e nao defina HF_HOME, XDG_CACHE_HOME nem MPLCONFIGDIR, que ja vem configurados. Se o video estiver claramente em outro idioma, avise o aluno e transcreva com --no_align (o alinhamento de outros idiomas nao esta no cache offline). Se um modelo diferente for necessario, explique ao usuario em vez de tentar baixar.

Fase 2 — o visual e renderizado pelo Remotion, nunca improvisado:
- Ao aprovar os estilos, o Edvid monta edit/remotion com o template oficial e as dependencias ja instaladas. Nao rode npm install, nao crie outro projeto e nao use nenhum outro caminho para os elementos visuais. Nao ha rede disponivel.
- E proibido produzir legenda ou headline por outro meio: nada de legendas .ass queimadas pelo FFmpeg, nada de imagens geradas com PIL/Pillow, nada de drawtext. O template ja implementa os estilos com as fontes e animacoes corretas.
- Escreva apenas os dados em edit/remotion/public/: edit-data.json (a edicao inteira), captions.json (palavras da transcricao), segments.json (cortes), caption-cues.json (so para a legenda empilhada) e track.json, alem de copiar o corte aprovado para edit/remotion/public/cut.mp4 — e esse arquivo que o template estiliza. O scaffold ja deixa versoes neutras de captions.json, segments.json e track.json, entao o projeto sempre compila; substitua as que a edicao precisar.
- Os arquivos de legenda tem geradores oficiais em EDVID_HELPERS, e voce deve usa-los em vez de montar o JSON na mao: "$EDVID_PYTHON" "$EDVID_HELPERS/captions_for_remotion.py" --transcript <transcricao.json> -o public/captions.json, e para a legenda empilhada tambem "$EDVID_PYTHON" "$EDVID_HELPERS/caption_style.py" --transcript <transcricao.json> -o public/caption-cues.json --lang pt. Eles aceitam direto o JSON do WhisperX. Sem o caption-cues.json a legenda empilhada nao aparece.
- Quando o briefing pedir tracking de rosto, gere o track.json com "$EDVID_PYTHON" "$EDVID_HELPERS/face_track.py" <cut.mp4> -o public/track.json. Com o tracking desligado, deixe o track.json neutro que ja veio no scaffold.
- O segments.json tambem tem gerador oficial, e somar os segundos do EDL dessincroniza o zoom dos cortes: use "$EDVID_PYTHON" "$EDVID_HELPERS/segments_for_remotion.py" <clipes por corte, em ordem> -o public/segments.json quando existirem clipes separados, ou "$EDVID_PYTHON" "$EDVID_HELPERS/segments_for_remotion.py" --edl edit/edl.json --fps <fps do cut> -o public/segments.json quando o corte for um arquivo unico. Nunca edite src/Main.tsx.
- Os nomes de estilo do briefing sao os mesmos do template: headline outline, card, realce ou misto; legenda karaoke, stacked, scatter, simples, serifada ou classica. Copie a cor escolhida para hook.accent e captions.accent — sao esses campos que pintam realce, misto e a linha serifada da empilhada.
- TELA DIVIDIDA e OFICIAL e declarativa: escreva no edit-data.json o campo splits, uma lista [{"kind": "image" ou "video", "src": "imagens/arquivo.png" (relativo a public/), "start": segundos, "end": segundos, "position": "top" (default) ou "bottom"}]. O template monta a divisao sozinho (midia numa metade, o video segue na outra) e TODAS as legendas se reposicionam sozinhas no meio da divisa durante o split — nao escreva captions.windows para isso e NUNCA monte tela dividida no CustomGraphics.tsx (ele e so para motion graphics avulsos). Copie a midia usada para dentro de edit/remotion/public/imagens/ antes.
- ANIMACOES SAO DECLARATIVAS e o campo animations do edit-data.json e o que as faz APARECER no video: [{"start": segundos, "end": segundos, "kind": "...", "label": "nome curto em portugues"}]. O kind e OBRIGATORIO — sem ele nada e desenhado, so aparece a faixa na timeline do Edvid (foi assim que uma edicao real saiu sem nenhum efeito). Os kinds prontos sao: "flash" (estouro de luz no corte; use um por corte quando o briefing pedir flashes de transicao, com start no tempo do corte), "script" (cartao que digita frases na tela — passe tambem lines: ["frase 1", "frase 2"]), "timeline" (uma linha do tempo animada) e "shapes" (formas coloridas que pipocam). Escolha o kind mais proximo do que o aluno pediu; para "infografico" use "script" com as frases dele.
- QUANDO O ALUNO DESCREVE UM VISUAL, OS PRONTOS NAO SERVEM. Pedido com estilo proprio — cor especifica, fonte, "tela cheia", grid, glassmorphism, layout descrito, referencia visual — exige animacao SOB MEDIDA: escreva o componente no CustomGraphics.tsx com exatamente o que ele descreveu e registre a janela em animations com "kind": "custom" (o "custom" avisa o template que o desenho vem do seu codigo, entao nada generico aparece por cima). Entregar um kind pronto no lugar de um visual que o aluno detalhou e ignorar o pedido dele — ja aconteceu: o aluno pediu tela cheia com grid escuro e destaque em #ff5200 e recebeu o cartao "ROTEIRO" padrao.
- Os kinds prontos existem para quando o pedido e generico ("coloca uma animacao aqui", "destaca esse trecho") ou para o flash de transicao. Na duvida entre um pronto e escrever codigo, ESCREVA O CODIGO.
- Registro sem kind e sem codigo proprio nao fica invisivel (o Edvid deduz um tipo pelo rotulo), mas o resultado fica pobre: um nome interno vira o texto que o espectador le. Decida voce.
- NUNCA invente campos proprios no edit-data.json (ex.: creatorInfographics): o template nao le campos desconhecidos e nada e renderizado a partir deles. Os campos oficiais sao os unicos com efeito: hook, captions, camera, inserts, behind, splits, animations e soundtrack. Se um campo inventado ja existir de sessoes anteriores, migre os dados dele para o campo oficial e apague o campo antigo.
- Nunca execute remotion render, nem inteiro nem em partes: o Chromium do render nao inicia dentro do sandbox e cada tentativa pediria aprovacao ao usuario. Quando os arquivos de public/ estiverem prontos, encerre o turno com um resumo curto da edicao. O Edvid detecta os dados novos, renderiza sozinho fora do sandbox, mostra o progresso na interface e publica o resultado em edicao/fase_2/. Nao crie renders em out/, nao concatene partes e nao copie arquivos de video para as pastas de saida.

Imagens geradas por IA:
- Quando a edicao precisar de uma imagem criada do zero (fundo, thumbnail, elemento grafico), NAO tente gerar ou desenhar voce mesmo: escreva o arquivo edit/imagens/pedidos.json com uma lista [{"arquivo": "nome.png", "prompt": "descricao detalhada em ingles", "proporcao": "4:3"}] (proporcao aceita 4:3, 9:16, 1:1 ou 16:9; para TELA DIVIDIDA use SEMPRE 4:3, porque cada metade da tela e uma faixa larga e uma imagem 9:16 entra cortada — 9:16 so serve para imagem que ocupa a tela inteira) e encerre o turno avisando que as imagens foram pedidas. O Edvid gera fora do sandbox com a IA de imagem conectada pelo aluno, salva os arquivos em edit/imagens/ e ENVIA SOZINHO uma mensagem de continuacao quando eles estiverem prontos — nesse turno de continuacao, aplique as imagens na edicao exatamente onde planejou, sem esperar o aluno pedir de novo. Se a mensagem de continuacao disser que a geracao falhou ou nao vier, o aluno pode nao ter IA de imagem conectada — siga sem a imagem e avise.
- Explique apenas o resultado da edicao de forma curta; detalhes tecnicos de execucao pertencem a interface de permissao, nao a conversa.`;

export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private outputBuffer = '';
  private pending = new Map<RpcId, PendingRequest>();
  private approvals = new Map<RpcId, PendingApproval>();
  private threadsByProject = new Map<string, string>();
  private activeTurns = new Map<string, string>();
  private activeLoginId: string | null = null;
  // Threads utilitarias (geracao de imagem): eventos nao chegam ao chat e
  // aprovacoes sao recusadas na hora — o fluxo sondado nao precisa de nenhuma.
  private utilityThreads = new Set<string>();
  private utilityWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  // Percentual de uso da janela da conta (account/rateLimits/updated): e o
  // sinal honesto de "limite atingido" para o fallback de provedor.
  lastRateLimitUsedPercent: number | null = null;

  constructor(
    private readonly executable: string,
    private readonly codexHome: string,
    private readonly appVersion: string,
    private readonly emit: (event: CodexEvent) => void,
    private readonly runtimeEnvironment: NodeJS.ProcessEnv = {},
    private readonly sandboxWritableRoots: string[] = [],
  ) {}

  // O sandbox workspace-write so permite escrever no projeto. Os caches dos
  // runtimes internos ficam fora dele, entao entram como writable_roots — sem
  // isso o usuario teria de aprovar cada transcricao. A rede continua negada.
  // Motor alternativo do chat: um provedor do catalogo (ex.: Ollama Cloud) no
  // lugar do ChatGPT. O Codex aceita provedores proprios em [model_providers]
  // desde que falem o formato da OpenAI — e o Ollama fala (sondado:
  // ollama.com/v1/chat/completions responde 401 sem chave). Sem isso, conectar
  // uma IA de texto no catalogo nao servia para nada: ela nem aparecia no
  // seletor do chat, que era o defeito relatado.
  private engine: { providerId: string; label: string; baseUrl: string; model: string; envKey: string } | null = null;

  setEngine(engine: CodexAppServer['engine']): boolean {
    const before = JSON.stringify(this.engine);
    this.engine = engine;
    // O config.toml so e lido no start: mudou o motor, o processo reinicia.
    return before !== JSON.stringify(engine);
  }

  private async writeSandboxConfig(): Promise<void> {
    const roots = this.sandboxWritableRoots
      .map((root) => JSON.stringify(root))
      .join(', ');
    const engine = this.engine;
    const config = [
      '# Gerado pelo Edvid Desktop. Alteracoes manuais sao sobrescritas.',
      // Chave de topo: precisa vir ANTES de qualquer [secao], senao o TOML a
      // engole como chave da secao e o pin nao vale.
      `model = ${JSON.stringify(engine ? engine.model : CODEX_CHAT_MODEL)}`,
      // Prefixo proprio: `ollama` e id RESERVADO no Codex (provedor embutido,
      // que aponta para a instalacao local) e o config inteiro e recusado ao
      // tentar sobrescrever — "Built-in providers cannot be overridden".
      ...(engine ? [`model_provider = ${JSON.stringify(`edvid-${engine.providerId}`)}`] : []),
      // Cinto e suspensorio: a politica tambem vai em cada thread/start. Se uma
      // versao do CLI ignorar o parametro, o aluno nao volta a ver aprovacoes.
      `approval_policy = ${JSON.stringify(CODEX_APPROVAL_POLICY)}`,
      `sandbox_mode = ${JSON.stringify(CODEX_SANDBOX)}`,
      ...(engine
        ? [
          `[model_providers.edvid-${engine.providerId}]`,
          `name = ${JSON.stringify(engine.label)}`,
          `base_url = ${JSON.stringify(engine.baseUrl)}`,
          `env_key = ${JSON.stringify(engine.envKey)}`,
          // "chat" foi DESCONTINUADO pelo Codex ("`wire_api = \"chat\"` is no
          // longer supported") e um config invalido e ignorado INTEIRO: o
          // agente voltava para api.openai.com e o aluno via 401 da OpenAI ao
          // usar o Ollama. Os dois provedores do catalogo expoem /v1/responses
          // (401 com chave ausente; rota inexistente responde 404).
          'wire_api = "responses"',
        ]
        : []),
      '[sandbox_workspace_write]',
      'network_access = false',
      `writable_roots = [${roots}]`,
      '',
    ].join('\n');
    await writeFile(path.join(this.codexHome, 'config.toml'), config);
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;

    this.startPromise = this.startInternal().catch((error: unknown) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    await mkdir(this.codexHome, { recursive: true });
    await this.writeSandboxConfig();
    const child = spawn(this.executable, ['--listen', 'stdio://', '--session-source', 'appServer'], {
      env: { ...process.env, ...this.runtimeEnvironment, CODEX_HOME: this.codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeOutput(chunk));
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) console.warn(`[codex-app-server] ${message}`);
    });
    child.on('error', (error) => this.handleExit(error));
    child.on('exit', (code, signal) => {
      this.handleExit(
        new Error(`Codex App Server encerrou (codigo ${code ?? 'n/a'}, sinal ${signal ?? 'n/a'}).`),
      );
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'edvid_desktop',
        title: 'Edvid Desktop',
        version: this.appVersion,
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    this.notify('initialized');
  }

  private handleExit(error: Error): void {
    if (this.stopping) {
      this.stopping = false;
      this.child = null;
      this.startPromise = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.approvals.clear();
      this.threadsByProject.clear();
      this.activeTurns.clear();
      return;
    }
    if (!this.child && this.pending.size === 0) return;
    this.child = null;
    this.startPromise = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.approvals.clear();
    this.threadsByProject.clear();
    this.activeTurns.clear();
    for (const waiter of this.utilityWaiters.values()) waiter.reject(error);
    this.utilityWaiters.clear();
    this.utilityThreads.clear();
    this.emit({ type: 'error', message: error.message });
  }

  private consumeOutput(chunk: string): void {
    this.outputBuffer += chunk;
    let newline = this.outputBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.outputBuffer.slice(0, newline).trim();
      this.outputBuffer = this.outputBuffer.slice(newline + 1);
      if (line) {
        try {
          this.handleMessage(JSON.parse(line) as RpcMessage);
        } catch (error) {
          console.warn('Mensagem invalida do Codex App Server:', error);
        }
      }
      newline = this.outputBuffer.indexOf('\n');
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Falha no Codex App Server.'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message.id, message.method, message.params ?? {});
      return;
    }

    if (message.method) this.handleNotification(message.method, message.params ?? {});
  }

  private handleServerRequest(id: RpcId, method: string, params: Record<string, unknown>): void {
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      // Turno utilitario nunca pede nada ao usuario: recusa e segue.
      if (this.utilityThreads.has(String(params.threadId ?? ''))) {
        this.send({ id, result: { decision: 'decline' } });
        return;
      }
      const kind = method.includes('commandExecution') ? 'command' : 'file-change';
      this.approvals.set(id, { kind });
      const command = typeof params.command === 'string' ? params.command : null;
      const reason = typeof params.reason === 'string' ? params.reason : null;
      const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : null;
      this.emit({
        type: 'approval-requested',
        approval: {
          id,
          kind,
          threadId: String(params.threadId ?? ''),
          turnId: String(params.turnId ?? ''),
          title: kind === 'command' ? 'Executar comando' : 'Alterar arquivos',
          detail: command ?? reason ?? grantRoot,
          cwd: typeof params.cwd === 'string' ? params.cwd : null,
        },
      });
      return;
    }

    this.send({
      id,
      error: { code: -32601, message: `Metodo do servidor nao suportado: ${method}` },
    });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const threadId = String(params.threadId ?? '');
    if (method === 'account/rateLimits/updated') {
      const used = (params.rateLimits as { primary?: { usedPercent?: number } } | undefined)?.primary?.usedPercent;
      if (typeof used === 'number') this.lastRateLimitUsedPercent = used;
      return;
    }
    if (this.utilityThreads.has(threadId)) {
      if (method === 'turn/completed') {
        const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
        const waiter = this.utilityWaiters.get(threadId);
        if (!waiter) return;
        if (turn?.status === 'failed' || turn?.status === 'interrupted') {
          waiter.reject(new Error(turn?.error?.message || 'O turno de imagem falhou.'));
        } else {
          waiter.resolve();
        }
      }
      return;
    }
    if (method === 'item/agentMessage/delta') {
      this.emit({
        type: 'assistant-delta',
        threadId,
        turnId: String(params.turnId ?? ''),
        itemId: String(params.itemId ?? ''),
        delta: String(params.delta ?? ''),
      });
      return;
    }

    if (method === 'item/completed') {
      const item = params.item as { type?: string; id?: string; text?: string } | undefined;
      if (item?.type === 'agentMessage') {
        this.emit({
          type: 'assistant-final',
          threadId,
          turnId: String(params.turnId ?? ''),
          itemId: String(item.id ?? ''),
          text: String(item.text ?? ''),
        });
      }
      return;
    }

    if (method === 'turn/started') {
      const turn = params.turn as { id?: string } | undefined;
      const turnId = String(turn?.id ?? '');
      if (threadId && turnId) this.activeTurns.set(threadId, turnId);
      this.emit({ type: 'turn-state', threadId, turnId, status: 'started' });
      return;
    }

    if (method === 'turn/completed') {
      const turn = params.turn as
        | { id?: string; status?: string; error?: { message?: string } | null }
        | undefined;
      const turnId = String(turn?.id ?? '');
      this.activeTurns.delete(threadId);
      const status =
        turn?.status === 'failed'
          ? 'failed'
          : turn?.status === 'interrupted'
            ? 'interrupted'
            : 'completed';
      this.emit({
        type: 'turn-state',
        threadId,
        turnId,
        status,
        error: turn?.error?.message,
      });
      return;
    }

    if (method === 'account/login/completed' || method === 'account/updated') {
      if (method === 'account/login/completed') this.activeLoginId = null;
      void this.readAccount().then((state) => this.emit({ type: 'account', state }));
      return;
    }

    if (method === 'serverRequest/resolved') {
      const requestId = params.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        this.approvals.delete(requestId);
        this.emit({ type: 'approval-resolved', approvalId: requestId });
      }
      return;
    }

    if (method === 'error') {
      // Com turno ativo o mesmo erro chega de novo em turn/completed; emitir
      // aqui tambem duplicaria a mensagem no chat.
      if (threadId && this.activeTurns.has(threadId)) return;
      const error = params.error as { message?: string } | undefined;
      this.emit({ type: 'error', message: error?.message ?? 'O Codex encontrou um erro.' });
    }
  }

  private send(message: RpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error('Codex App Server nao esta ativo.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.send(params ? { method, params } : { method });
  }

  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tempo esgotado em ${method}.`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    try {
      this.send(params === undefined ? { id, method } : { id, method, params });
    } catch (error) {
      const waiting = this.pending.get(id);
      if (waiting) clearTimeout(waiting.timer);
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  async readAccount(): Promise<CodexAccountState> {
    try {
      await this.start();
      const response = await this.request<AccountReadResponse>('account/read', {
        refreshToken: false,
      });
      const account: CodexAccount | null = response.account
        ? {
            type: response.account.type,
            email: response.account.email ?? null,
            planType: response.account.planType ?? null,
          }
        : null;
      return {
        status: account ? 'signed-in' : 'signed-out',
        account,
        requiresOpenaiAuth: response.requiresOpenaiAuth,
      };
    } catch (error) {
      return {
        status: 'error',
        account: null,
        requiresOpenaiAuth: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async startChatGptLogin(): Promise<{ state: CodexAccountState; authUrl: string }> {
    await this.start();
    const response = await this.request<LoginStartResponse>('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    });
    if (response.type !== 'chatgpt' || !('authUrl' in response)) {
      throw new Error('O Codex nao iniciou o login do ChatGPT.');
    }
    this.activeLoginId = response.loginId;
    return {
      authUrl: response.authUrl,
      state: {
        status: 'waiting-for-browser',
        account: null,
        requiresOpenaiAuth: true,
      },
    };
  }

  // Login com chave de API da OpenAI. O app-server guarda a chave sozinho no
  // CODEX_HOME e responde na hora (sondado: aceita QUALQUER texto, entao a
  // validacao contra a API acontece antes, no main).
  async startApiKeyLogin(apiKey: string): Promise<CodexAccountState> {
    await this.start();
    const response = await this.request<LoginStartResponse>('account/login/start', {
      type: 'apiKey',
      apiKey,
    });
    if (response.type !== 'apiKey') {
      throw new Error('O Codex nao aceitou o login por chave de API.');
    }
    return this.readAccount();
  }

  async cancelLogin(): Promise<CodexAccountState> {
    await this.start();
    if (this.activeLoginId) {
      await this.request('account/login/cancel', { loginId: this.activeLoginId });
      this.activeLoginId = null;
    }
    return this.readAccount();
  }

  async logout(): Promise<CodexAccountState> {
    await this.start();
    await this.request('account/logout');
    this.threadsByProject.clear();
    this.activeTurns.clear();
    const state: CodexAccountState = {
      status: 'signed-out',
      account: null,
      requiresOpenaiAuth: true,
    };
    this.emit({ type: 'account', state });
    return state;
  }

  async sendMessage(
    projectDirectory: string,
    text: string,
  ): Promise<CodexSendMessageResult> {
    await this.start();
    let threadId = this.threadsByProject.get(projectDirectory) ?? null;
    if (!threadId) {
      const started = await this.request<ThreadStartResponse>('thread/start', {
        cwd: projectDirectory,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        sandbox: CODEX_SANDBOX,
        serviceName: 'edvid_desktop',
        developerInstructions: EDVID_INSTRUCTIONS,
        model: this.engine?.model ?? CODEX_CHAT_MODEL,
      });
      threadId = started.thread.id;
      this.threadsByProject.set(projectDirectory, threadId);
    }

    const response = await this.request<TurnStartResponse>('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    this.activeTurns.set(threadId, response.turn.id);
    return { threadId, turnId: response.turn.id };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.start();
    if (this.activeTurns.get(threadId) !== turnId) {
      throw new Error('Este turno nao esta mais ativo.');
    }
    await this.request('turn/interrupt', { threadId, turnId });
  }

  // Turno unico numa thread propria, invisivel para o chat. E o motor da
  // geracao de imagens via assinatura do ChatGPT (ferramenta imagegen).
  async runUtilityTurn(
    projectDirectory: string,
    instruction: string,
    timeoutMs = 300_000,
  ): Promise<void> {
    await this.start();
    const started = await this.request<ThreadStartResponse>('thread/start', {
      cwd: projectDirectory,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX,
      serviceName: 'edvid_desktop_imagens',
      model: this.engine?.model ?? CODEX_CHAT_MODEL,
    });
    const threadId = started.thread.id;
    this.utilityThreads.add(threadId);
    let timer: NodeJS.Timeout | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        this.utilityWaiters.set(threadId, { resolve, reject });
        timer = setTimeout(() => {
          reject(new Error('A geração da imagem demorou demais e foi interrompida.'));
          const turnId = this.activeTurns.get(threadId);
          if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        }, timeoutMs);
        this.request<TurnStartResponse>('turn/start', {
          threadId,
          input: [{ type: 'text', text: instruction, text_elements: [] }],
        }).then((response) => {
          this.activeTurns.set(threadId, response.turn.id);
        }).catch(reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.utilityThreads.delete(threadId);
      this.utilityWaiters.delete(threadId);
      this.activeTurns.delete(threadId);
    }
  }

  async respondToApproval(id: RpcId, decision: CodexApprovalDecision): Promise<void> {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error('Esta solicitacao de aprovacao nao esta mais ativa.');
    this.send({ id, result: { decision } });
    this.approvals.delete(id);
    this.emit({ type: 'approval-resolved', approvalId: id });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    // Sinaliza que o encerramento foi pedido por nos: trocar o motor do chat
    // derruba o processo de proposito, e o aluno via "Codex App Server
    // encerrou (SIGTERM)" em vermelho como se algo tivesse quebrado.
    this.stopping = true;
    if (child && !child.killed) child.kill();
  }

  private stopping = false;
}
