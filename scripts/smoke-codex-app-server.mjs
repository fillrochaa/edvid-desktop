import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  await readFile(path.join(desktopRoot, 'resources/runtime-manifest.json'), 'utf8'),
);
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const isWindows = target.startsWith('win32-');
const executable = path.join(
  desktopRoot,
  'resources',
  'runtimes',
  target,
  'codex-app-server',
  'bin',
  `codex-app-server${isWindows ? '.exe' : ''}`,
);
const codexHome = await mkdtemp(path.join(tmpdir(), 'edvid-codex-smoke-'));
const child = spawn(executable, ['--listen', 'stdio://', '--session-source', 'appServer'], {
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let nextId = 1;
let buffer = '';
const pending = new Map();

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId;
  nextId += 1;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Tempo esgotado em ${method}.`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
  });
  send(params === undefined ? { id, method } : { id, method, params });
  return promise;
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const waiting = pending.get(message.id);
        if (waiting) {
          pending.delete(message.id);
          clearTimeout(waiting.timer);
          if (message.error) waiting.reject(new Error(message.error.message));
          else waiting.resolve(message.result);
        }
      }
    }
    newline = buffer.indexOf('\n');
  }
});

try {
  const initialized = await request('initialize', {
    clientInfo: { name: 'edvid_desktop_smoke', title: 'Edvid smoke test', version: '0.1.0' },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  if (!String(initialized.userAgent).includes(manifest.runtimes['codex-app-server'].version)) {
    throw new Error(`User agent inesperado: ${initialized.userAgent}`);
  }
  send({ method: 'initialized' });

  const account = await request('account/read', { refreshToken: false });
  if (typeof account.requiresOpenaiAuth !== 'boolean') {
    throw new Error('Resposta account/read invalida.');
  }

  const thread = await request('thread/start', {
    cwd: desktopRoot,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    serviceName: 'edvid_desktop_smoke',
  });
  if (typeof thread.thread?.id !== 'string') {
    throw new Error('Resposta thread/start invalida.');
  }
  await request('thread/delete', { threadId: thread.thread.id });

  const login = await request('account/login/start', {
    type: 'chatgpt',
    useHostedLoginSuccessPage: true,
    appBrand: 'chatgpt',
  });
  if (login.type !== 'chatgpt' || new URL(login.authUrl).origin !== 'https://auth.openai.com') {
    throw new Error('Fluxo OAuth do ChatGPT nao foi iniciado corretamente.');
  }
  await request('account/login/cancel', { loginId: login.loginId });

  console.log(
    `Codex App Server ${manifest.runtimes['codex-app-server'].version}: initialize, account/read, thread/start e OAuth OK`,
  );
} finally {
  child.kill();
  for (const waiting of pending.values()) clearTimeout(waiting.timer);
  await rm(codexHome, { recursive: true, force: true });
}
