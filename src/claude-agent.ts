import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EDVID_INSTRUCTIONS } from './codex-app-server';
import type {
  ClaudeAccountState,
  CodexApprovalDecision,
  CodexEvent,
} from './shared';

// O adaptador Claude fala o MESMO vocabulario de eventos do Codex
// (assistant-delta, turn-state, approval-requested...): o chat do renderer
// nao sabe qual provedor esta por tras. A conversa roda no Claude Agent SDK,
// instalado sob demanda em userData/runtime/claude como o motor do Remotion.

// Fluxo OAuth publico do proprio Claude Code (PKCE, cliente publico sem
// segredo). O aluno entra com a conta Claude dele; o token vai para o SDK
// via CLAUDE_CODE_OAUTH_TOKEN — o caminho documentado para ambientes sem
// terminal. Nada disso e segredo: e o mesmo fluxo do "claude /login".
// Enderecos extraidos do proprio CLI 2.1.235 (o embutido no SDK pinado):
// com o rebrand Console -> Claude Platform, o authorize de contas Claude.ai
// mudou para claude.com/cai e o token para platform.claude.com. Os enderecos
// antigos (claude.ai/oauth/authorize + console.anthropic.com/v1/oauth/token)
// ainda renderizam a pagina de login, mas a troca do codigo por token parou
// de completar — o aluno "logava" no site e a conta nunca conectava.
const OAUTH_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Porta de callback registrada do Claude Code. Se estiver ocupada, caimos
// para o fluxo manual: o site mostra o codigo e o aluno cola no Edvid.
const OAUTH_CALLBACK_PORT = 54545;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
const OAUTH_MANUAL_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';
const OAUTH_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Versao exata do SDK (que embute o proprio binario do Claude Code na mesma
// versao 2.1.x). Atualizar aqui muda o agente de todos os alunos no proximo
// release; o runtime local reinstala sozinho quando a versao pinada muda.
const CLAUDE_SDK_VERSION = '0.3.235';
const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

const CLAUDE_EXTRA_INSTRUCTIONS = `

Regras especificas desta integracao:
- Pergunte qualquer duvida diretamente no texto da resposta, em portugues simples. Nao use a ferramenta AskUserQuestion.
- Nao ha rede disponivel para comandos; nunca tente instalar pacotes ou baixar arquivos.`;

// Duas formas de conexao: OAuth da assinatura (padrao) ou chave de API da
// Anthropic. Arquivos antigos sem "mode" sao OAuth.
type StoredClaudeAuth =
  | {
      mode?: 'oauth';
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      email: string | null;
    }
  | { mode: 'api-key'; apiKey: string };

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';

function maskKey(apiKey: string): string {
  if (apiKey.length <= 10) return `${apiKey.slice(0, 3)}…`;
  return `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}`;
}

// Erro do endpoint OAuth com o status HTTP anexado: o refresh precisa
// distinguir "grant recusado" (derruba a sessao) de 429/5xx (transitorio).
class OauthHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type PendingLogin = {
  verifier: string;
  state: string;
  manual: boolean;
  server: Server | null;
  timer: NodeJS.Timeout | null;
  // Trava a troca em voo: um refresh da aba de callback re-GETa a URL com o
  // MESMO codigo e uma segunda troca falharia sobrescrevendo o sucesso.
  busy: boolean;
};

type PendingApproval = {
  key: string;
  resolve: (decision: CodexApprovalDecision) => void;
};

type ActiveTurn = {
  turnId: string;
  interrupt: (() => Promise<unknown>) | null;
  abort: AbortController;
  interrupted: boolean;
};

// O SDK e carregado dinamicamente do runtime instalado em userData; estes
// tipos cobrem apenas o que o adaptador usa.
type SdkMessage = Record<string, unknown> & { type?: string };
type SdkQuery = AsyncGenerator<SdkMessage, void> & {
  interrupt?: () => Promise<unknown>;
};
type SdkModule = {
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => SdkQuery;
};

type ToolInput = Record<string, unknown>;
type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput }
  | { behavior: 'deny'; message: string };

// O bundle do main sai em CJS; um import() literal seria reescrito para
// require() por alguns empacotadores e quebraria o carregamento do SDK (que
// e ESM). A indirecao preserva o import dinamico nativo.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...extraEnvironment },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 32_768) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split(/\r?\n/u).at(-1) || `Comando falhou (${code}).`));
    });
  });
}

export type ClaudeAgentDeps = {
  // userData/runtime/claude: node_modules com o SDK pinado.
  runtimeDirectory: string;
  // CLAUDE_CONFIG_DIR proprio do Edvid: sessoes e estado isolados de
  // qualquer instalacao de Claude Code que o usuario tenha na maquina.
  configDirectory: string;
  // Tokens da conta do aluno (0600), mesmo padrao do member-auth.json.
  authFile: string;
  // PATH das ferramentas empacotadas + EDVID_* + caches, o mesmo do Codex.
  // Resolvido a cada uso: na primeira execucao o pacote de runtimes pode
  // ainda nao existir quando o agente e construido (leitura da conta).
  toolsEnvironment: () => NodeJS.ProcessEnv;
  // Caches fora do projeto que os comandos podem escrever (HF, torch...).
  sandboxWritableRoots: string[];
  resolveNpm: () => { command: string | null; argsPrefix: string[] };
  emitEvent: (event: CodexEvent) => void;
  emitAccount: (state: ClaudeAccountState) => void;
  // Assinatura minima em comum entre o fetch global e o net.fetch do Electron.
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
};

export class ClaudeAgent {
  private stored: StoredClaudeAuth | null | undefined;
  private refreshJob: Promise<string> | null = null;
  private pendingLogin: PendingLogin | null = null;
  private installJob: Promise<void> | null = null;
  private sdk: SdkModule | null = null;
  private nextApprovalId = 1;
  private approvals = new Map<string, PendingApproval>();
  private sessionAllowlist = new Set<string>();
  private sessionsByProject = new Map<string, string>();
  private threadsByProject = new Map<string, string>();
  private activeTurns = new Map<string, ActiveTurn>();
  private lastAccount: ClaudeAccountState = { status: 'signed-out', email: null };

  constructor(private readonly deps: ClaudeAgentDeps) {}

  // --- Conta / OAuth --------------------------------------------------------

  private async readStored(): Promise<StoredClaudeAuth | null> {
    if (this.stored !== undefined) return this.stored;
    try {
      const parsed = JSON.parse(await readFile(this.deps.authFile, 'utf8')) as Record<string, unknown>;
      if (parsed.mode === 'api-key' && typeof parsed.apiKey === 'string' && parsed.apiKey) {
        this.stored = { mode: 'api-key', apiKey: parsed.apiKey };
      } else if (
        typeof parsed.accessToken === 'string' &&
        typeof parsed.refreshToken === 'string' &&
        typeof parsed.expiresAt === 'number'
      ) {
        this.stored = {
          mode: 'oauth',
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          expiresAt: parsed.expiresAt,
          email: typeof parsed.email === 'string' ? parsed.email : null,
        };
      } else {
        this.stored = null;
      }
    } catch {
      this.stored = null;
    }
    return this.stored;
  }

  private async writeStored(stored: StoredClaudeAuth | null): Promise<void> {
    this.stored = stored;
    if (!stored) {
      await rm(this.deps.authFile, { force: true });
      return;
    }
    await writeFile(this.deps.authFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  }

  private broadcast(state: ClaudeAccountState): void {
    this.lastAccount = state;
    this.deps.emitAccount(state);
  }

  // Diario do login em userData/claude-login.log, so com etapas e status
  // HTTP — nunca codigos, tokens ou verifier. E o que permite diagnosticar
  // um "loguei no site mas nao conectou" sem acesso a maquina do aluno.
  private loginLog: string[] = [];

  private logLogin(step: string): void {
    this.loginLog.push(`${new Date().toISOString()} ${step}`);
    if (this.loginLog.length > 200) this.loginLog.splice(0, this.loginLog.length - 200);
    const file = path.join(path.dirname(this.deps.authFile), 'claude-login.log');
    void writeFile(file, `${this.loginLog.join('\n')}\n`).catch(() => {});
  }

  async readAccount(): Promise<ClaudeAccountState> {
    if (this.pendingLogin) return this.lastAccount;
    const stored = await this.readStored();
    this.lastAccount = !stored
      ? { status: 'signed-out', email: null }
      : stored.mode === 'api-key'
        ? { status: 'signed-in', email: maskKey(stored.apiKey), mode: 'api-key' }
        : { status: 'signed-in', email: stored.email, mode: 'oauth' };
    return this.lastAccount;
  }

  // Conexao por chave de API da Anthropic: valida contra /v1/models antes de
  // aceitar e substitui qualquer login OAuth anterior.
  async connectApiKey(apiKey: string): Promise<ClaudeAccountState> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      this.broadcast({ ...this.lastAccount, error: 'Cole a chave de API da Anthropic.' });
      return this.lastAccount;
    }
    let response: Response;
    try {
      response = await this.deps.fetchImpl(`${ANTHROPIC_MODELS_URL}?limit=1`, {
        headers: { 'x-api-key': trimmed, 'anthropic-version': '2023-06-01' },
      });
    } catch {
      this.broadcast({ ...this.lastAccount, error: 'Sem conexão para validar a chave. Tente de novo.' });
      return this.lastAccount;
    }
    if (!response.ok) {
      this.broadcast({
        ...this.lastAccount,
        error: response.status === 401 || response.status === 403
          ? 'Chave inválida. Confira no Console da Anthropic e cole de novo.'
          : `A validação da chave falhou (HTTP ${response.status}). Tente de novo.`,
      });
      return this.lastAccount;
    }
    this.closeLogin();
    await this.writeStored({ mode: 'api-key', apiKey: trimmed });
    this.broadcast({ status: 'signed-in', email: maskKey(trimmed), mode: 'api-key' });
    void this.ensureRuntime().catch(() => {});
    return this.lastAccount;
  }

  async startLogin(): Promise<{ authUrl: string; state: ClaudeAccountState }> {
    this.closeLogin();
    const verifier = base64Url(randomBytes(32));
    const state = base64Url(randomBytes(32));
    const login: PendingLogin = { verifier, state, manual: false, server: null, timer: null, busy: false };
    this.pendingLogin = login;

    login.server = await this.bindCallbackServer(login);
    login.manual = !login.server;
    this.logLogin(
      login.manual
        ? `inicio do login: porta ${OAUTH_CALLBACK_PORT} ocupada, fluxo manual (colar codigo)`
        : `inicio do login: aguardando navegador em localhost:${OAUTH_CALLBACK_PORT}`,
    );
    login.timer = setTimeout(() => {
      if (this.pendingLogin === login) {
        this.closeLogin();
        void this.readAccount().then((account) => this.broadcast(account));
      }
    }, OAUTH_LOGIN_TIMEOUT_MS);

    const url = new URL(OAUTH_AUTHORIZE_URL);
    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', OAUTH_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', login.manual ? OAUTH_MANUAL_REDIRECT_URI : OAUTH_REDIRECT_URI);
    url.searchParams.set('scope', OAUTH_SCOPES);
    url.searchParams.set('code_challenge', base64Url(createHash('sha256').update(verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);

    const waiting: ClaudeAccountState = {
      status: 'waiting-for-browser',
      email: null,
      manual: login.manual,
    };
    this.broadcast(waiting);
    return { authUrl: url.toString(), state: waiting };
  }

  private bindCallbackServer(login: PendingLogin): Promise<Server | null> {
    const escapeHtml = (text: string): string =>
      text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
    const page = (title: string, detail: string): string =>
      `<meta charset="utf-8"><body style="font-family:sans-serif;background:#0d1117;color:#e6e8ec;display:grid;place-items:center;height:100vh"><div style="text-align:center;max-width:32rem;padding:0 1rem"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></div>`;
    return new Promise((resolve) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', OAUTH_REDIRECT_URI);
        if (url.pathname !== '/callback') {
          response.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get('code') ?? '';
        const returnedState = url.searchParams.get('state') ?? '';
        const valid = Boolean(code) && returnedState === login.state && this.pendingLogin === login && !login.busy;
        if (!valid) {
          this.logLogin(
            `callback invalido (codigo ${code ? 'presente' : 'ausente'}, state ${returnedState === login.state ? 'confere' : 'diverge'}, login ${this.pendingLogin === login ? 'ativo' : 'encerrado'})`,
          );
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(page('Requisição de login inválida', 'Volte ao Edvid e tente de novo.'));
          return;
        }
        login.busy = true;
        this.logLogin('callback do navegador recebido (state confere); trocando codigo por token');
        // A pagina so anuncia sucesso DEPOIS da troca do token: antes ela
        // dizia "Login concluído" na hora e, se a troca falhasse em seguida,
        // o aluno via sucesso no navegador com a conta ainda desconectada.
        // O login so e encerrado quando a resposta chega ao navegador — o
        // closeAllConnections do encerramento derrubaria esta propria resposta.
        void this.completeLogin(code, login.state, OAUTH_REDIRECT_URI, login.verifier).then((result) => {
          if (result.ok) {
            response.once('close', () => {
              if (this.pendingLogin === login) this.closeLogin();
            });
          }
          response.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
          response.end(
            result.ok
              ? page('Login concluído', 'Pode fechar esta aba e voltar para o Edvid.')
              : page('O login não terminou', `${result.error ?? 'Erro inesperado.'} Volte ao Edvid e tente de novo.`),
          );
        });
      });
      server.once('error', () => resolve(null));
      server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => resolve(server));
    });
  }

  // Fluxo manual: o site exibiu "codigo#estado" e o aluno colou no Edvid.
  async submitLoginCode(pasted: string): Promise<ClaudeAccountState> {
    const login = this.pendingLogin;
    if (!login) return this.readAccount();
    const [code, pastedState] = pasted.trim().split('#', 2);
    if (!code) {
      this.broadcast({ ...this.lastAccount, status: 'waiting-for-browser', manual: login.manual, error: 'Cole o código completo mostrado no site.' });
      return this.lastAccount;
    }
    this.logLogin('codigo manual colado; trocando codigo por token');
    const result = await this.completeLogin(code, pastedState || login.state, OAUTH_MANUAL_REDIRECT_URI, login.verifier);
    if (result.ok) this.closeLogin();
    return this.lastAccount;
  }

  private async completeLogin(
    code: string,
    state: string,
    redirectUri: string,
    verifier: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const manual = this.pendingLogin?.manual ?? false;
    try {
      const tokens = await this.exchangeToken({
        grant_type: 'authorization_code',
        code,
        state,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      await this.writeStored(tokens);
      this.logLogin(`login concluido: tokens gravados (conta ${tokens.email ? 'com e-mail' : 'sem e-mail no retorno'})`);
      this.broadcast({ status: 'signed-in', email: tokens.email, mode: 'oauth' });
      // Deixa o motor pronto em segundo plano: a primeira mensagem do aluno
      // nao deveria esperar um npm install.
      void this.ensureRuntime().catch(() => {});
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.broadcast({
        status: 'waiting-for-browser',
        email: null,
        manual,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  private async exchangeToken(
    body: Record<string, string>,
  ): Promise<Extract<StoredClaudeAuth, { accessToken: string }>> {
    let response: Response;
    try {
      response = await this.deps.fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      this.logLogin(`troca de token (${body.grant_type}): sem conexao com ${OAUTH_TOKEN_URL}`);
      throw new Error('Sem conexão para concluir o login do Claude. Tente de novo.');
    }
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      account?: { email_address?: string };
      error_description?: string;
      error?: string | { message?: string };
    };
    if (!response.ok || !payload.access_token || !payload.refresh_token) {
      // O servidor responde ora com erro OAuth (error/error_description como
      // texto), ora com o formato da API ({ error: { message } }).
      const detail =
        (typeof payload.error_description === 'string' && payload.error_description) ||
        (typeof payload.error === 'string' && payload.error) ||
        (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string' && payload.error.message) ||
        'O Claude recusou o login. Tente de novo.';
      this.logLogin(`troca de token (${body.grant_type}): HTTP ${response.status} — ${detail}`);
      throw new OauthHttpError(detail, response.status);
    }
    this.logLogin(`troca de token (${body.grant_type}): HTTP ${response.status} ok`);
    const previousEmail = this.stored && this.stored.mode !== 'api-key' ? this.stored.email : null;
    return {
      mode: 'oauth',
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000,
      email: payload.account?.email_address ?? previousEmail,
    };
  }

  private closeLogin(): void {
    const login = this.pendingLogin;
    this.pendingLogin = null;
    if (!login) return;
    if (login.timer) clearTimeout(login.timer);
    // Sem derrubar as conexoes keep-alive do navegador, a porta 54545 fica
    // presa e a PROXIMA tentativa de login cairia para o fluxo manual.
    login.server?.closeAllConnections();
    login.server?.close();
  }

  async cancelLogin(): Promise<ClaudeAccountState> {
    this.closeLogin();
    return this.readAccount();
  }

  async logout(): Promise<ClaudeAccountState> {
    this.closeLogin();
    this.logLogin('logout: tokens removidos');
    await this.writeStored(null);
    this.sessionsByProject.clear();
    this.threadsByProject.clear();
    this.sessionAllowlist.clear();
    this.broadcast({ status: 'signed-out', email: null });
    return this.lastAccount;
  }

  // Credencial pronta para o ambiente do proximo turno: chave de API direta
  // ou token OAuth renovado sozinho perto de expirar.
  private async authEnvironment(): Promise<Record<string, string>> {
    const stored = await this.readStored();
    if (!stored) throw new Error('Conecte sua conta Claude em Configurações para conversar.');
    if (stored.mode === 'api-key') return { ANTHROPIC_API_KEY: stored.apiKey };
    return { CLAUDE_CODE_OAUTH_TOKEN: await this.oauthAccessToken(stored) };
  }

  private async oauthAccessToken(stored: Extract<StoredClaudeAuth, { accessToken: string }>): Promise<string> {
    if (stored.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return stored.accessToken;
    if (!this.refreshJob) {
      this.refreshJob = (async () => {
        try {
          const tokens = await this.exchangeToken({
            grant_type: 'refresh_token',
            refresh_token: stored.refreshToken,
            client_id: OAUTH_CLIENT_ID,
          });
          await this.writeStored(tokens);
          return tokens.accessToken;
        } catch (error) {
          // So um refresh de fato RECUSADO (400/401) derruba a sessao; um
          // 429/5xx ou queda de rede e transitorio e mantem os tokens para a
          // proxima tentativa — deslogar o aluno por um soluço do servidor
          // custaria um novo login inteiro.
          const rejected =
            error instanceof OauthHttpError && (error.status === 400 || error.status === 401);
          if (rejected) {
            await this.writeStored(null);
            this.broadcast({ status: 'signed-out', email: null });
            throw new Error('Sua sessão do Claude expirou. Entre de novo em Configurações.');
          }
          throw error instanceof Error ? error : new Error(String(error));
        } finally {
          this.refreshJob = null;
        }
      })();
    }
    return this.refreshJob;
  }

  // --- Runtime (SDK instalado sob demanda) ----------------------------------

  private sdkDirectory(): string {
    return path.join(this.deps.runtimeDirectory, 'node_modules', ...CLAUDE_SDK_PACKAGE.split('/'));
  }

  private async runtimeIsReady(): Promise<boolean> {
    try {
      const pkg = JSON.parse(await readFile(path.join(this.sdkDirectory(), 'package.json'), 'utf8')) as {
        version?: string;
      };
      return pkg.version === CLAUDE_SDK_VERSION;
    } catch {
      return false;
    }
  }

  ensureRuntime(): Promise<void> {
    if (this.installJob) return this.installJob;
    const job = (async () => {
      if (await this.runtimeIsReady()) return;
      const npm = this.deps.resolveNpm();
      if (!npm.command) {
        throw new Error('O npm interno não está disponível para instalar o motor do Claude.');
      }
      await mkdir(this.deps.runtimeDirectory, { recursive: true });
      await writeFile(
        path.join(this.deps.runtimeDirectory, 'package.json'),
        `${JSON.stringify(
          {
            name: 'edvid-claude-runtime',
            version: '1.0.0',
            private: true,
            dependencies: { [CLAUDE_SDK_PACKAGE]: CLAUDE_SDK_VERSION },
          },
          null,
          2,
        )}\n`,
      );
      const npmDirectory = path.dirname(npm.command);
      await runCommand(
        npm.command,
        [...npm.argsPrefix, 'install', '--omit=dev', '--no-audit', '--no-fund'],
        this.deps.runtimeDirectory,
        {
          PATH: [npmDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_update_notifier: 'false',
        },
      );
      if (!(await this.runtimeIsReady())) {
        throw new Error('A instalação do motor do Claude não terminou íntegra. Tente de novo.');
      }
      this.sdk = null;
    })();
    this.installJob = job.catch((error: unknown) => {
      // Erro nao fica cacheado: a proxima mensagem tenta instalar de novo.
      this.installJob = null;
      throw error;
    }).finally(() => {
      if (this.installJob === job) this.installJob = null;
    }) as Promise<void>;
    return this.installJob;
  }

  private async loadSdk(): Promise<SdkModule> {
    if (this.sdk) return this.sdk;
    await this.ensureRuntime();
    const packageDirectory = this.sdkDirectory();
    const pkg = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as {
      main?: string;
      exports?: Record<string, unknown>;
    };
    // exports["."] do 0.3.x e { types, default: "./sdk.mjs" }; as demais
    // formas cobrem versoes futuras sem quebrar a resolucao.
    const root = pkg.exports?.['.'] as string | Record<string, unknown> | undefined;
    const candidates = typeof root === 'string'
      ? [root]
      : [root?.default, root?.import, (root?.import as Record<string, unknown> | undefined)?.default];
    const entry = candidates.find((value): value is string => typeof value === 'string')
      ?? pkg.main ?? 'sdk.mjs';
    const module = (await dynamicImport(pathToFileURL(path.join(packageDirectory, entry)).href)) as SdkModule;
    if (typeof module.query !== 'function') {
      throw new Error('O motor do Claude instalado não expõe a função query.');
    }
    this.sdk = module;
    return module;
  }

  // --- Conversa -------------------------------------------------------------

  private buildEnvironment(auth: Record<string, string>): Record<string, string | undefined> {
    const environment: Record<string, string | undefined> = { ...process.env };
    // Nenhuma credencial ou configuracao de Claude da maquina do usuario
    // pode vazar para o agente do Edvid (ANTHROPIC_API_KEY teria precedencia
    // sobre o token do aluno, por exemplo).
    for (const key of Object.keys(environment)) {
      if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) delete environment[key];
    }
    return {
      ...environment,
      ...this.deps.toolsEnvironment(),
      ...auth,
      CLAUDE_CONFIG_DIR: this.deps.configDirectory,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
  }

  private approvalKey(toolName: string, input: ToolInput): string {
    const detail = toolName === 'Bash' ? String(input.command ?? '') : String(input.file_path ?? '');
    return `${toolName} ${detail}`;
  }

  private requestApproval(
    threadId: string,
    turnId: string,
    projectDirectory: string,
    toolName: string,
    input: ToolInput,
    signal: AbortSignal | undefined,
  ): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Pergunte diretamente na conversa, em texto simples.',
      });
    }
    const key = this.approvalKey(toolName, input);
    if (this.sessionAllowlist.has(key)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const id = `claude:${this.nextApprovalId}`;
    this.nextApprovalId += 1;
    const kind = toolName === 'Bash' ? 'command' : 'file-change';
    const detail =
      toolName === 'Bash'
        ? String(input.command ?? '')
        : typeof input.file_path === 'string'
          ? input.file_path
          : JSON.stringify(input).slice(0, 200);
    return new Promise<PermissionResult>((resolve) => {
      const settle = (decision: CodexApprovalDecision): void => {
        this.approvals.delete(id);
        this.deps.emitEvent({ type: 'approval-resolved', approvalId: id });
        if (decision === 'decline') {
          resolve({ behavior: 'deny', message: 'O usuário recusou esta ação.' });
          return;
        }
        if (decision === 'acceptForSession') this.sessionAllowlist.add(key);
        resolve({ behavior: 'allow', updatedInput: input });
      };
      this.approvals.set(id, { key, resolve: settle });
      signal?.addEventListener('abort', () => {
        if (this.approvals.has(id)) settle('decline');
      });
      this.deps.emitEvent({
        type: 'approval-requested',
        approval: {
          id,
          kind,
          threadId,
          turnId,
          title: kind === 'command' ? 'Executar comando' : 'Alterar arquivos',
          detail: detail || toolName,
          cwd: projectDirectory,
        },
      });
    });
  }

  async respondToApproval(id: string | number, decision: CodexApprovalDecision): Promise<void> {
    const approval = this.approvals.get(String(id));
    if (!approval) throw new Error('Esta solicitação de aprovação não está mais ativa.');
    approval.resolve(decision);
  }

  ownsApproval(id: string | number): boolean {
    return typeof id === 'string' && id.startsWith('claude:');
  }

  ownsThread(threadId: string): boolean {
    return threadId.startsWith('claude:');
  }

  async sendMessage(
    projectDirectory: string,
    text: string,
  ): Promise<{ threadId: string; turnId: string }> {
    const auth = await this.authEnvironment();
    const sdk = await this.loadSdk();
    let threadId = this.threadsByProject.get(projectDirectory);
    if (!threadId) {
      threadId = `claude:${randomUUID()}`;
      this.threadsByProject.set(projectDirectory, threadId);
    }
    if (this.activeTurns.has(threadId)) {
      throw new Error('Aguarde o turno atual terminar antes de enviar outra mensagem.');
    }
    const turnId = randomUUID();
    const abort = new AbortController();
    const active: ActiveTurn = { turnId, interrupt: null, abort, interrupted: false };
    this.activeTurns.set(threadId, active);

    // Entrada em streaming: um unico envio, mas o canal fica aberto ate o
    // fim do turno — e o que habilita interrupt() (o botao Parar).
    let releaseInput: () => void = () => {};
    const inputDone = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    async function* promptStream(): AsyncGenerator<unknown> {
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      };
      await inputDone;
    }

    const resumeSession = this.sessionsByProject.get(projectDirectory);
    let query: SdkQuery;
    try {
      query = sdk.query({
      prompt: promptStream(),
      options: {
        cwd: projectDirectory,
        abortController: abort,
        includePartialMessages: true,
        // O prompt do Claude Code + o contrato do Edvid, identico ao Codex.
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${EDVID_INSTRUCTIONS}${CLAUDE_EXTRA_INSTRUCTIONS}`,
        },
        // Nada do ~/.claude do usuario entra aqui: sem settings, hooks,
        // CLAUDE.md ou MCPs da maquina — o Edvid define tudo.
        settingSources: [],
        permissionMode: 'acceptEdits',
        disallowedTools: ['WebSearch', 'WebFetch'],
        // Mesmo modelo do Codex: comandos rodam num sandbox sem rede com
        // escrita no projeto + caches; escapar do sandbox vira aprovacao.
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
          network: { allowedDomains: [] },
          filesystem: { allowWrite: [...this.deps.sandboxWritableRoots] },
        },
        canUseTool: (toolName: string, input: ToolInput, extra?: { signal?: AbortSignal }) =>
          this.requestApproval(threadId as string, turnId, projectDirectory, toolName, input, extra?.signal),
        env: this.buildEnvironment(auth),
        ...(resumeSession ? { resume: resumeSession } : {}),
      },
      });
    } catch (error) {
      // Falha na CONSTRUCAO (opcoes invalidas, binario ausente): sem isso o
      // turno fantasma ficava em activeTurns e travava o projeto.
      this.activeTurns.delete(threadId);
      releaseInput();
      throw error;
    }
    active.interrupt = typeof query.interrupt === 'function' ? () => query.interrupt!() : null;

    void this.consumeTurn(query, projectDirectory, threadId, turnId, active, () => releaseInput());

    this.deps.emitEvent({ type: 'turn-state', threadId, turnId, status: 'started' });
    return { threadId, turnId };
  }

  private async consumeTurn(
    query: SdkQuery,
    projectDirectory: string,
    threadId: string,
    turnId: string,
    active: ActiveTurn,
    releaseInput: () => void,
  ): Promise<void> {
    // O texto do turno acumula entre blocos e mensagens: o chat mostra uma
    // bolha unica por turno, entao cada "final" reapresenta o texto inteiro.
    let turnText = '';
    let deltaText = '';
    let failure: string | null = null;
    let sawResult = false;
    const emitDelta = (piece: string): void => {
      deltaText += piece;
      this.deps.emitEvent({ type: 'assistant-delta', threadId, turnId, itemId: turnId, delta: piece });
    };
    try {
      for await (const message of query) {
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
          const sessionId = (message as { session_id?: string }).session_id;
          if (typeof sessionId === 'string' && sessionId) {
            this.sessionsByProject.set(projectDirectory, sessionId);
          }
          continue;
        }
        // Streams de subagentes (parent_tool_use_id) nao entram no chat.
        if ((message as { parent_tool_use_id?: string | null }).parent_tool_use_id) continue;
        if (message.type === 'stream_event') {
          const event = (message as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            if (!deltaText && turnText) emitDelta('\n\n');
            emitDelta(event.delta.text);
          }
          continue;
        }
        if (message.type === 'assistant') {
          const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } })
            .message?.content;
          const textBlocks = (content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text)
            .map((block) => block.text as string);
          if (textBlocks.length) {
            turnText = [turnText, textBlocks.join('\n\n')].filter(Boolean).join('\n\n');
            deltaText = '';
            this.deps.emitEvent({ type: 'assistant-final', threadId, turnId, itemId: turnId, text: turnText });
          }
          continue;
        }
        if (message.type === 'result') {
          sawResult = true;
          const result = message as { is_error?: boolean; subtype?: string; result?: string };
          if (result.is_error) {
            failure =
              (typeof result.result === 'string' && result.result) ||
              `O Claude interrompeu o turno (${result.subtype ?? 'erro'}).`;
          }
        }
      }
    } catch (error) {
      // O SDK lanca depois de um result com erro; a mensagem do result ja e
      // a versao limpa e nao deve ser sobrescrita.
      if (!active.interrupted && !failure) {
        failure = error instanceof Error ? error.message : String(error);
      }
    } finally {
      releaseInput();
      this.activeTurns.delete(threadId);
      const status = active.interrupted ? 'interrupted' : failure ? 'failed' : sawResult ? 'completed' : 'failed';
      this.deps.emitEvent({
        type: 'turn-state',
        threadId,
        turnId,
        status,
        error: status === 'failed' ? failure ?? 'A conversa com o Claude terminou de forma inesperada.' : undefined,
      });
    }
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const active = this.activeTurns.get(threadId);
    if (!active || active.turnId !== turnId) {
      throw new Error('Este turno não está mais ativo.');
    }
    active.interrupted = true;
    try {
      if (active.interrupt) await active.interrupt();
      else active.abort.abort();
    } catch {
      active.abort.abort();
    }
  }

  stop(): void {
    this.closeLogin();
    for (const active of this.activeTurns.values()) {
      active.interrupted = true;
      active.abort.abort();
    }
    this.activeTurns.clear();
  }
}
