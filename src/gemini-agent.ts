import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EDVID_INSTRUCTIONS } from './codex-app-server';
import type {
  CodexApprovalDecision,
  CodexEvent,
  GeminiAccountState,
} from './shared';

// Adaptador Gemini: o CLI oficial em modo ACP (JSON-RPC 2.0 por stdio),
// autenticado por CHAVE DE API (o login gratuito com conta Google morreu em
// 06/2026). Como os demais provedores, emite o vocabulario CodexEvent pelo
// mesmo canal — o chat nao sabe a diferenca. Sondado contra o CLI real:
// initialize/session/new/session/prompt/session/update/set_mode e o gate de
// confianca de pasta (desligado via GEMINI_CLI_SYSTEM_SETTINGS_PATH).

const GEMINI_CLI_VERSION = '0.55.1';
const GEMINI_PACKAGE = '@google/gemini-cli';
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Nano Banana: modelo de imagem com free tier na chave do AI Studio.
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

const GEMINI_EXTRA_INSTRUCTIONS = `
Regras especificas desta integracao:
- Pergunte qualquer duvida diretamente no texto da resposta, em portugues simples.
- Nao use busca na web nem qualquer ferramenta de rede; trabalhe offline com os arquivos do projeto.`;

type StoredGeminiAuth = { apiKey: string };

type RpcId = number;
type RpcMessage = {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

type SessionState = {
  sessionId: string;
  threadId: string;
  instructed: boolean;
};

type ActiveTurn = {
  turnId: string;
  threadId: string;
  turnText: string;
  deltaText: string;
  interrupted: boolean;
};

type PermissionOption = { optionId?: string; kind?: string; name?: string };

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

// As falhas da API chegam como JSON aninhado em string (ate tres niveis na
// sondagem). Desembrulha ate sobrar texto legivel.
function unwrapErrorMessage(raw: string): string {
  let message = raw;
  for (let round = 0; round < 3; round += 1) {
    try {
      const parsed = JSON.parse(message) as { error?: { message?: string }; message?: string };
      const inner = parsed.error?.message ?? parsed.message;
      if (typeof inner !== 'string' || !inner) break;
      message = inner;
    } catch {
      break;
    }
  }
  return message.trim().split(/\r?\n/u)[0]?.slice(0, 300) || 'O Gemini encontrou um erro.';
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 10) return `${apiKey.slice(0, 3)}…`;
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}

export type GeminiAgentDeps = {
  // userData/runtime/gemini: node_modules com o CLI pinado.
  runtimeDirectory: string;
  // Chave do aluno (0600), mesmo padrao dos demais provedores.
  authFile: string;
  // Settings de SISTEMA controladas pelo Edvid (GEMINI_CLI_SYSTEM_SETTINGS_PATH):
  // desligam o gate de confianca de pasta e a telemetria.
  systemSettingsFile: string;
  toolsEnvironment: () => NodeJS.ProcessEnv;
  resolveNode: () => string | null;
  resolveNpm: () => { command: string | null; argsPrefix: string[] };
  emitEvent: (event: CodexEvent) => void;
  emitAccount: (state: GeminiAccountState) => void;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
};

export class GeminiAgent {
  private stored: StoredGeminiAuth | null | undefined;
  private installJob: Promise<void> | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private outputBuffer = '';
  private nextRequestId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private sessionsByProject = new Map<string, SessionState>();
  private activeBySession = new Map<string, ActiveTurn>();
  private nextApprovalId = 1;
  private approvals = new Map<string, (decision: CodexApprovalDecision) => void>();

  constructor(private readonly deps: GeminiAgentDeps) {}

  // --- Chave de API ---------------------------------------------------------

  private async readStored(): Promise<StoredGeminiAuth | null> {
    if (this.stored !== undefined) return this.stored;
    try {
      const parsed = JSON.parse(await readFile(this.deps.authFile, 'utf8')) as Partial<StoredGeminiAuth>;
      this.stored = typeof parsed.apiKey === 'string' && parsed.apiKey ? { apiKey: parsed.apiKey } : null;
    } catch {
      this.stored = null;
    }
    return this.stored;
  }

  async readAccount(): Promise<GeminiAccountState> {
    const stored = await this.readStored();
    return stored
      ? { status: 'signed-in', maskedKey: maskApiKey(stored.apiKey) }
      : { status: 'signed-out', maskedKey: null };
  }

  async connectApiKey(apiKey: string): Promise<GeminiAccountState> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return { status: 'signed-out', maskedKey: null, error: 'Cole a chave de API do Google AI Studio.' };
    }
    // Valida contra a API antes de aceitar: o CLI aceitaria qualquer texto e
    // o aluno so descobriria o erro no meio da primeira edicao.
    let response: Response;
    try {
      response = await this.deps.fetchImpl(`${GEMINI_MODELS_URL}?pageSize=1&key=${encodeURIComponent(trimmed)}`);
    } catch {
      const state: GeminiAccountState = {
        ...(await this.readAccount()),
        error: 'Sem conexão para validar a chave. Tente de novo.',
      };
      this.deps.emitAccount(state);
      return state;
    }
    if (!response.ok) {
      const state: GeminiAccountState = {
        ...(await this.readAccount()),
        error: response.status === 400 || response.status === 401 || response.status === 403
          ? 'Chave inválida. Confira no Google AI Studio e cole de novo.'
          : `A validação da chave falhou (HTTP ${response.status}). Tente de novo.`,
      };
      this.deps.emitAccount(state);
      return state;
    }
    this.stored = { apiKey: trimmed };
    await writeFile(this.deps.authFile, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
    // A chave viaja no ambiente do processo: derruba o atual para o proximo
    // turno subir com a credencial nova.
    this.stopProcess();
    const state: GeminiAccountState = { status: 'signed-in', maskedKey: maskApiKey(trimmed) };
    this.deps.emitAccount(state);
    void this.ensureRuntime().catch(() => {});
    return state;
  }

  // Gera uma imagem com o Nano Banana e devolve o PNG. A proporcao vai no
  // imageConfig; se a API recusar o campo, tenta de novo sem ele.
  async generateImage(prompt: string, aspectRatio: string | null): Promise<Buffer> {
    const stored = await this.readStored();
    if (!stored) throw new Error('Conecte sua chave do Gemini para gerar imagens.');
    const url = `${GEMINI_MODELS_URL}/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(stored.apiKey)}`;
    const call = (withAspect: boolean): Promise<Response> =>
      this.deps.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(withAspect && aspectRatio ? { imageConfig: { aspectRatio } } : {}),
          },
        }),
      });
    let response: Response;
    try {
      response = await call(Boolean(aspectRatio));
      if (!response.ok && aspectRatio) response = await call(false);
    } catch {
      throw new Error('Sem conexão para gerar a imagem no Gemini.');
    }
    const payload = (await response.json().catch(() => ({}))) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(unwrapErrorMessage(payload.error?.message ?? `O Gemini recusou a geração (HTTP ${response.status}).`));
    }
    const data = payload.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData?.data;
    if (!data) throw new Error('O Gemini respondeu sem imagem. Tente reformular o pedido.');
    return Buffer.from(data, 'base64');
  }

  async disconnect(): Promise<GeminiAccountState> {
    this.stored = null;
    await rm(this.deps.authFile, { force: true });
    this.stopProcess();
    const state: GeminiAccountState = { status: 'signed-out', maskedKey: null };
    this.deps.emitAccount(state);
    return state;
  }

  // --- Runtime (CLI instalado sob demanda) ----------------------------------

  private cliEntry(): string {
    return path.join(this.deps.runtimeDirectory, 'node_modules', ...GEMINI_PACKAGE.split('/'), 'bundle', 'gemini.js');
  }

  private async runtimeIsReady(): Promise<boolean> {
    try {
      const pkg = JSON.parse(
        await readFile(
          path.join(this.deps.runtimeDirectory, 'node_modules', ...GEMINI_PACKAGE.split('/'), 'package.json'),
          'utf8',
        ),
      ) as { version?: string };
      return pkg.version === GEMINI_CLI_VERSION;
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
        throw new Error('O npm interno não está disponível para instalar o motor do Gemini.');
      }
      await mkdir(this.deps.runtimeDirectory, { recursive: true });
      await writeFile(
        path.join(this.deps.runtimeDirectory, 'package.json'),
        `${JSON.stringify(
          {
            name: 'edvid-gemini-runtime',
            version: '1.0.0',
            private: true,
            dependencies: { [GEMINI_PACKAGE]: GEMINI_CLI_VERSION },
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
        throw new Error('A instalação do motor do Gemini não terminou íntegra. Tente de novo.');
      }
    })();
    this.installJob = job.finally(() => {
      if (this.installJob === job) this.installJob = null;
    });
    return this.installJob;
  }

  // --- Processo ACP ---------------------------------------------------------

  private async ensureProcess(): Promise<void> {
    if (this.child && this.startPromise) return this.startPromise;
    const stored = await this.readStored();
    if (!stored) throw new Error('Conecte sua chave do Gemini em Configurações para conversar.');
    const node = this.deps.resolveNode();
    if (!node) throw new Error('O Node interno não está disponível nesta plataforma.');

    // Settings de sistema: sem gate de confianca de pasta (senao o modo
    // autoEdit e recusado) e sem estatisticas de uso.
    await writeFile(
      this.deps.systemSettingsFile,
      `${JSON.stringify(
        {
          security: { folderTrust: { enabled: false } },
          privacy: { usageStatisticsEnabled: false },
        },
        null,
        2,
      )}\n`,
    );

    const environment: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith('GEMINI_') || key.startsWith('GOOGLE_')) delete environment[key];
    }
    const child = spawn(node, [this.cliEntry(), '--acp'], {
      cwd: this.deps.runtimeDirectory,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...environment,
        ...this.deps.toolsEnvironment(),
        GEMINI_API_KEY: stored.apiKey,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: this.deps.systemSettingsFile,
        NO_COLOR: '1',
      },
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeOutput(chunk));
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) console.warn(`[gemini-acp] ${message.slice(0, 300)}`);
    });
    child.on('error', (error) => this.handleExit(error));
    child.on('exit', (code, signal) => {
      this.handleExit(new Error(`O motor do Gemini encerrou (código ${code ?? 'n/a'}, sinal ${signal ?? 'n/a'}).`));
    });

    this.startPromise = this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, 20_000).then(() => undefined);
    return this.startPromise;
  }

  private handleExit(error: Error): void {
    if (!this.child) return;
    this.child = null;
    this.startPromise = null;
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    // As sessoes morrem com o processo; os turnos ativos falham na promise
    // do prompt (rejeitada acima) e emitem o turn-state por la.
    this.sessionsByProject.clear();
    this.activeBySession.clear();
  }

  private stopProcess(): void {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.sessionsByProject.clear();
    this.activeBySession.clear();
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(new Error('O motor do Gemini foi reiniciado.'));
    }
    this.pending.clear();
    if (child && !child.killed) child.kill();
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
        } catch {
          console.warn('Mensagem inválida do Gemini ACP.');
        }
      }
      newline = this.outputBuffer.indexOf('\n');
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(unwrapErrorMessage(message.error.message ?? 'Falha no Gemini.')));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleAgentRequest(message.id, message.method, message.params ?? {});
      return;
    }
    if (message.method === 'session/update') this.handleSessionUpdate(message.params ?? {});
  }

  private send(message: RpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error('O motor do Gemini não está ativo.');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private request<T>(method: string, params: Record<string, unknown>, timeoutMs: number | null): Promise<T> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Tempo esgotado em ${method}.`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    });
    try {
      this.send({ id, method, params });
    } catch (error) {
      const waiting = this.pending.get(id);
      if (waiting?.timer) clearTimeout(waiting.timer);
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  // --- Eventos da conversa --------------------------------------------------

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = String(params.sessionId ?? '');
    const active = this.activeBySession.get(sessionId);
    if (!active) return;
    const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string } } | undefined;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text) {
      active.deltaText += update.content.text;
      this.deps.emitEvent({
        type: 'assistant-delta',
        threadId: active.threadId,
        turnId: active.turnId,
        itemId: active.turnId,
        delta: update.content.text,
      });
    }
  }

  private handleAgentRequest(id: RpcId, method: string, params: Record<string, unknown>): void {
    if (method === 'session/request_permission') {
      const sessionId = String(params.sessionId ?? '');
      const active = this.activeBySession.get(sessionId);
      const options = Array.isArray(params.options) ? (params.options as PermissionOption[]) : [];
      const toolCall = params.toolCall as { title?: string; kind?: string; toolCallId?: string } | undefined;
      const approvalId = `gemini:${this.nextApprovalId}`;
      this.nextApprovalId += 1;
      const pick = (kind: string): string | null =>
        options.find((option) => option.kind === kind)?.optionId ?? null;
      const respond = (decision: CodexApprovalDecision): void => {
        this.approvals.delete(approvalId);
        this.deps.emitEvent({ type: 'approval-resolved', approvalId });
        const optionId =
          decision === 'decline'
            ? pick('reject_once') ?? pick('reject_always')
            : decision === 'acceptForSession'
              ? pick('allow_always') ?? pick('allow_once')
              : pick('allow_once') ?? pick('allow_always');
        this.send({
          id,
          result: optionId
            ? { outcome: { outcome: 'selected', optionId } }
            : { outcome: { outcome: 'cancelled' } },
        });
      };
      this.approvals.set(approvalId, respond);
      this.deps.emitEvent({
        type: 'approval-requested',
        approval: {
          id: approvalId,
          kind: toolCall?.kind === 'edit' ? 'file-change' : 'command',
          threadId: active?.threadId ?? '',
          turnId: active?.turnId ?? '',
          title: toolCall?.kind === 'edit' ? 'Alterar arquivos' : 'Executar comando',
          detail: toolCall?.title ?? 'Ação do Gemini',
          cwd: null,
        },
      });
      return;
    }
    this.send({ id, error: { code: -32601, message: `Método do cliente não suportado: ${method}` } });
  }

  async respondToApproval(id: string | number, decision: CodexApprovalDecision): Promise<void> {
    const respond = this.approvals.get(String(id));
    if (!respond) throw new Error('Esta solicitação de aprovação não está mais ativa.');
    respond(decision);
  }

  ownsApproval(id: string | number): boolean {
    return typeof id === 'string' && id.startsWith('gemini:');
  }

  ownsThread(threadId: string): boolean {
    return threadId.startsWith('gemini:');
  }

  // --- Conversa -------------------------------------------------------------

  async sendMessage(
    projectDirectory: string,
    text: string,
  ): Promise<{ threadId: string; turnId: string }> {
    await this.ensureRuntime();
    await this.ensureProcess();

    let session = this.sessionsByProject.get(projectDirectory);
    if (!session) {
      const created = await this.request<{ sessionId?: string }>('session/new', {
        cwd: projectDirectory,
        mcpServers: [],
      }, 30_000);
      if (!created.sessionId) throw new Error('O Gemini não abriu a sessão do projeto.');
      session = {
        sessionId: created.sessionId,
        threadId: `gemini:${randomUUID()}`,
        instructed: false,
      };
      this.sessionsByProject.set(projectDirectory, session);
      // Edicoes de arquivo sem prompt (paridade com os outros provedores);
      // comandos continuam passando pela aprovacao da interface.
      await this.request('session/set_mode', { sessionId: session.sessionId, modeId: 'autoEdit' }, 15_000)
        .catch(() => {});
    }
    if (this.activeBySession.has(session.sessionId)) {
      throw new Error('Aguarde o turno atual terminar antes de enviar outra mensagem.');
    }

    const turnId = randomUUID();
    const active: ActiveTurn = {
      turnId,
      threadId: session.threadId,
      turnText: '',
      deltaText: '',
      interrupted: false,
    };
    this.activeBySession.set(session.sessionId, active);

    const prompt = session.instructed
      ? text
      : `Instruções do Edvid — valem para a sessão inteira:\n${EDVID_INSTRUCTIONS}${GEMINI_EXTRA_INSTRUCTIONS}\n\n---\n\nMensagem do aluno:\n${text}`;
    session.instructed = true;

    const finish = (status: 'completed' | 'interrupted' | 'failed', error?: string): void => {
      const current = this.activeBySession.get(session!.sessionId);
      if (current !== active) return;
      this.activeBySession.delete(session!.sessionId);
      const finalText = active.turnText || active.deltaText;
      if (finalText) {
        this.deps.emitEvent({
          type: 'assistant-final',
          threadId: active.threadId,
          turnId,
          itemId: turnId,
          text: finalText,
        });
      }
      this.deps.emitEvent({
        type: 'turn-state',
        threadId: active.threadId,
        turnId,
        status,
        error,
      });
    };

    this.request<{ stopReason?: string }>('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    }, null)
      .then((result) => {
        active.turnText = [active.turnText, active.deltaText].filter(Boolean).join('');
        active.deltaText = '';
        if (active.interrupted || result.stopReason === 'cancelled') {
          finish('interrupted');
        } else if (result.stopReason === 'refusal') {
          finish('failed', 'O Gemini recusou este pedido.');
        } else {
          finish('completed');
        }
      })
      .catch((error: unknown) => {
        active.turnText = [active.turnText, active.deltaText].filter(Boolean).join('');
        active.deltaText = '';
        if (active.interrupted) finish('interrupted');
        else finish('failed', error instanceof Error ? error.message : String(error));
      });

    this.deps.emitEvent({ type: 'turn-state', threadId: session.threadId, turnId, status: 'started' });
    return { threadId: session.threadId, turnId };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    for (const [sessionId, active] of this.activeBySession) {
      if (active.threadId === threadId && active.turnId === turnId) {
        active.interrupted = true;
        this.send({ method: 'session/cancel', params: { sessionId } });
        return;
      }
    }
    throw new Error('Este turno não está mais ativo.');
  }

  stop(): void {
    this.stopProcess();
  }
}
