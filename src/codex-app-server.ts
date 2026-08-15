import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
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

const EDVID_INSTRUCTIONS = `Voce e o agente de edicao do Edvid Desktop. Converse em portugues do Brasil e trate a pasta do projeto como a unica area de trabalho do video. Preserve sempre os arquivos originais. Antes de uma edicao completa, faca primeiro o corte limpo guiado pelo audio e obtenha aprovacao do usuario; depois aplique visuais, legendas, trilha e acabamento. Explique mudancas importantes de forma curta e clara.`;

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

  constructor(
    private readonly executable: string,
    private readonly codexHome: string,
    private readonly appVersion: string,
    private readonly emit: (event: CodexEvent) => void,
  ) {}

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
    const child = spawn(this.executable, ['--listen', 'stdio://', '--session-source', 'appServer'], {
      env: { ...process.env, CODEX_HOME: this.codexHome },
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
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        serviceName: 'edvid_desktop',
        developerInstructions: EDVID_INSTRUCTIONS,
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
    if (child && !child.killed) child.kill();
  }
}
