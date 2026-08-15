import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexAppServer } from './codex-app-server';
import { resolveRuntime, type RuntimeResolution } from './runtime';
import type {
  CodexApprovalDecision,
  CodexEvent,
  CodexSendMessageInput,
  RuntimeCheck,
  RuntimeName,
} from './shared';

if (started) {
  app.quit();
}

const runtimeCommands: Array<{
  name: RuntimeName;
  args: string[];
}> = [
  { name: 'node', args: ['--version'] },
  { name: 'npm', args: ['--version'] },
  { name: 'ffmpeg', args: ['-version'] },
  { name: 'ffprobe', args: ['-version'] },
  { name: 'uv', args: ['--version'] },
  { name: 'yt-dlp', args: ['--version'] },
  { name: 'python', args: ['--version'] },
  {
    name: 'whisperx',
    args: [
      '-c',
      "from importlib.metadata import version; print(version('whisperx'))",
    ],
  },
  { name: 'codex-app-server', args: ['--version'] },
];

let codexAppServer: CodexAppServer | null = null;
const selectedProjectDirectories = new Set<string>();

function broadcastCodexEvent(event: CodexEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('codex:event', event);
  }
}

function getCodexAppServer(): CodexAppServer {
  if (codexAppServer) return codexAppServer;
  const resolution = resolveRuntime('codex-app-server', {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  if (!resolution.command) {
    throw new Error('Codex App Server interno nao foi empacotado para esta plataforma.');
  }
  codexAppServer = new CodexAppServer(
    resolution.command,
    path.join(app.getPath('userData'), 'codex'),
    app.getVersion(),
    broadcastCodexEvent,
  );
  return codexAppServer;
}

function checkRuntime(
  resolution: RuntimeResolution,
  args: string[],
): Promise<RuntimeCheck> {
  if (!resolution.command) {
    return Promise.resolve({
      name: resolution.name,
      available: false,
      version: null,
      expectedVersion: resolution.expectedVersion,
      source: 'missing',
      executablePath: null,
      error: 'Runtime interno ainda nao empacotado',
    });
  }

  return new Promise((resolve) => {
    const timeoutMs = resolution.name === 'yt-dlp' ? 30_000 : 10_000;
    const child = spawn(resolution.command as string, [...resolution.argsPrefix, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const complete = (check: RuntimeCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(check);
    };
    const timer = setTimeout(() => {
      child.kill();
      complete({
        name: resolution.name,
        available: false,
        version: null,
        expectedVersion: resolution.expectedVersion,
        source: resolution.source,
        executablePath: resolution.command,
        error: `Tempo esgotado apos ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 65_536) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 65_536) stderr += chunk;
    });
    child.on('error', (error) => {
      complete({
        name: resolution.name,
        available: false,
        version: null,
        expectedVersion: resolution.expectedVersion,
        source: resolution.source,
        executablePath: resolution.command,
        error: error.message,
      });
    });
    child.on('close', (status) => {
      if (status !== 0) {
        complete({
          name: resolution.name,
          available: false,
          version: null,
          expectedVersion: resolution.expectedVersion,
          source: resolution.source,
          executablePath: resolution.command,
          error: stderr.trim() || `Processo encerrou com codigo ${status ?? 'n/a'}`,
        });
        return;
      }
      const output = `${stdout}\n${stderr}`.trim();
      complete({
        name: resolution.name,
        available: true,
        version: output.split(/\r?\n/, 1)[0] || null,
        expectedVersion: resolution.expectedVersion,
        source: resolution.source,
        executablePath: resolution.command,
      });
    });
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('desktop:get-info', () => ({
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    embeddedNodeVersion: process.versions.node,
  }));

  ipcMain.handle('runtime:check', () =>
    Promise.all(runtimeCommands.map(({ name, args }) => {
      const resolution = resolveRuntime(name, {
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
      });
      return checkRuntime(resolution, args);
    })),
  );

  ipcMain.handle('project:select-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Escolha a pasta do projeto de video',
      buttonLabel: 'Usar esta pasta',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || !result.filePaths[0]) return null;
    const selectedDirectory = path.resolve(result.filePaths[0]);
    selectedProjectDirectories.add(selectedDirectory);
    return selectedDirectory;
  });

  ipcMain.handle('codex:account', () => getCodexAppServer().readAccount());

  ipcMain.handle('codex:login', async () => {
    const login = await getCodexAppServer().startChatGptLogin();
    const authUrl = new URL(login.authUrl);
    if (authUrl.protocol !== 'https:' || authUrl.origin !== 'https://auth.openai.com') {
      throw new Error('O Codex retornou um endereco de login inesperado.');
    }
    await shell.openExternal(login.authUrl);
    return login.state;
  });

  ipcMain.handle('codex:login-cancel', () => getCodexAppServer().cancelLogin());

  ipcMain.handle('codex:logout', () => getCodexAppServer().logout());

  ipcMain.handle('codex:message', (_event, input: CodexSendMessageInput) => {
    const projectDirectory = input.projectDirectory?.trim();
    const text = input.text?.trim();
    if (!projectDirectory) throw new Error('Escolha uma pasta de projeto.');
    const resolvedProjectDirectory = path.resolve(projectDirectory);
    if (!selectedProjectDirectories.has(resolvedProjectDirectory)) {
      throw new Error('Escolha a pasta do projeto pelo seletor do Edvid.');
    }
    if (!text) throw new Error('Escreva uma mensagem para o Edvid.');
    return getCodexAppServer().sendMessage(resolvedProjectDirectory, text);
  });

  ipcMain.handle(
    'codex:interrupt',
    (_event, input: { threadId: string; turnId: string }) =>
      getCodexAppServer().interrupt(input.threadId, input.turnId),
  );

  ipcMain.handle(
    'codex:approval',
    (
      _event,
      input: { approvalId: string | number; decision: CodexApprovalDecision },
    ) => getCodexAppServer().respondToApproval(input.approvalId, input.decision),
  );
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#090b10',
    title: 'Edvid',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const pageLoad = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : mainWindow.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      );

  // Opt-in visual regression hook for local/CI validation. It is inert for
  // users and avoids requiring macOS Screen Recording permission in tests.
  const screenshotPath = process.env.EDVID_SCREENSHOT_PATH;
  if (screenshotPath) {
    const requestedDelay = Number(process.env.EDVID_SCREENSHOT_DELAY_MS);
    const screenshotDelay = Number.isFinite(requestedDelay)
      ? Math.min(Math.max(requestedDelay, 0), 60_000)
      : 500;
    void pageLoad
      .then(() => new Promise((resolve) => setTimeout(resolve, screenshotDelay)))
      .then(() => mainWindow.webContents.capturePage())
      .then(async (capture) => {
        await writeFile(screenshotPath, capture.toPNG());
        app.exit(0);
      })
      .catch((error: unknown) => {
        console.error('Falha ao capturar screenshot de QA:', error);
        app.exit(1);
      });
  } else {
    void pageLoad;
  }
}

registerIpcHandlers();

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  codexAppServer?.stop();
});
