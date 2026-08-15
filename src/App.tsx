import { useEffect, useRef, useState, type FormEvent } from 'react';
import edvidLogo from './brand/edvid-logo-white.png';
import type {
  CodexAccountState,
  CodexApproval,
  CodexEvent,
  DesktopInfo,
  RuntimeCheck,
} from './shared';

const labels: Record<RuntimeCheck['name'], string> = {
  node: 'Node.js',
  npm: 'npm',
  ffmpeg: 'FFmpeg',
  ffprobe: 'FFprobe',
  uv: 'uv',
  'yt-dlp': 'yt-dlp',
  python: 'Python',
  whisperx: 'WhisperX',
  'codex-app-server': 'Codex',
};

const sourceLabels: Record<RuntimeCheck['source'], string> = {
  bundled: 'interno',
  system: 'sistema (dev)',
  missing: 'pendente',
};

const runtimeNames = Object.keys(labels) as RuntimeCheck['name'][];

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
};

const initialAccount: CodexAccountState = {
  status: 'starting',
  account: null,
  requiresOpenaiAuth: true,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeCheck[]>([]);
  const [projectDirectory, setProjectDirectory] = useState<string | null>(null);
  const [account, setAccount] = useState<CodexAccountState>(initialAccount);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<CodexApproval[]>([]);
  const [composer, setComposer] = useState('');
  const [checking, setChecking] = useState(true);
  const [sending, setSending] = useState(false);
  const [activeTurn, setActiveTurn] = useState<{ threadId: string; turnId: string } | null>(
    null,
  );
  const messageListRef = useRef<HTMLDivElement | null>(null);

  async function refreshRuntimes() {
    setChecking(true);
    try {
      setRuntimes(await window.edvidDesktop.checkRuntimes());
    } finally {
      setChecking(false);
    }
  }

  async function chooseProjectDirectory() {
    const selected = await window.edvidDesktop.selectProjectDirectory();
    if (!selected || selected === projectDirectory) return;
    setProjectDirectory(selected);
    setMessages([]);
    setApprovals([]);
  }

  async function login() {
    setAccount({ ...initialAccount, status: 'starting' });
    try {
      setAccount(await window.edvidDesktop.loginWithChatGPT());
    } catch (error) {
      setAccount({
        status: 'error',
        account: null,
        requiresOpenaiAuth: true,
        error: errorMessage(error),
      });
    }
  }

  async function logout() {
    try {
      setAccount(await window.edvidDesktop.logoutCodex());
      setMessages([]);
    } catch (error) {
      setAccount({ ...account, status: 'error', error: errorMessage(error) });
    }
  }

  async function cancelLogin() {
    try {
      setAccount(await window.edvidDesktop.cancelChatGPTLogin());
    } catch (error) {
      setAccount({ ...initialAccount, status: 'error', error: errorMessage(error) });
    }
  }

  function handleCodexEvent(event: CodexEvent) {
    if (event.type === 'account') {
      setAccount(event.state);
      return;
    }
    if (event.type === 'assistant-delta') {
      const id = `assistant:${event.turnId}`;
      setMessages((current) => {
        const existing = current.findIndex((message) => message.id === id);
        if (existing < 0) {
          return [...current, { id, role: 'assistant', text: event.delta }];
        }
        return current.map((message, index) =>
          index === existing ? { ...message, text: message.text + event.delta } : message,
        );
      });
      return;
    }
    if (event.type === 'assistant-final') {
      const id = `assistant:${event.turnId}`;
      setMessages((current) => {
        const existing = current.some((message) => message.id === id);
        return existing
          ? current.map((message) =>
              message.id === id ? { ...message, text: event.text } : message,
            )
          : [...current, { id, role: 'assistant', text: event.text }];
      });
      return;
    }
    if (event.type === 'turn-state') {
      if (event.status === 'started') {
        setActiveTurn({ threadId: event.threadId, turnId: event.turnId });
      } else {
        setActiveTurn(null);
        setSending(false);
        if (event.error) {
          setMessages((current) => [
            ...current,
            { id: `error:${event.turnId}`, role: 'system', text: event.error ?? '' },
          ]);
        }
      }
      return;
    }
    if (event.type === 'approval-requested') {
      setApprovals((current) => [...current, event.approval]);
      return;
    }
    if (event.type === 'approval-resolved') {
      setApprovals((current) =>
        current.filter((approval) => approval.id !== event.approvalId),
      );
      return;
    }
    if (event.type === 'error') {
      setSending(false);
      setMessages((current) => [
        ...current,
        { id: `error:${Date.now()}`, role: 'system', text: event.message },
      ]);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = composer.trim();
    if (!text || !projectDirectory || account.status !== 'signed-in' || sending) return;

    setComposer('');
    setSending(true);
    setMessages((current) => [
      ...current,
      { id: `user:${Date.now()}`, role: 'user', text },
    ]);
    try {
      const result = await window.edvidDesktop.sendCodexMessage({
        projectDirectory,
        text,
      });
      setActiveTurn(result);
    } catch (error) {
      setSending(false);
      setMessages((current) => [
        ...current,
        { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) },
      ]);
    }
  }

  async function interruptTurn() {
    if (!activeTurn) return;
    try {
      await window.edvidDesktop.interruptCodexTurn(activeTurn.threadId, activeTurn.turnId);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) },
      ]);
    }
  }

  async function answerApproval(
    approval: CodexApproval,
    decision: 'accept' | 'acceptForSession' | 'decline',
  ) {
    try {
      await window.edvidDesktop.respondToCodexApproval(approval.id, decision);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: `error:${Date.now()}`, role: 'system', text: errorMessage(error) },
      ]);
    }
  }

  useEffect(() => {
    const unsubscribe = window.edvidDesktop.onCodexEvent(handleCodexEvent);
    void window.edvidDesktop.getDesktopInfo().then(setDesktopInfo);
    void window.edvidDesktop.getCodexAccount().then(setAccount);
    void refreshRuntimes();
    return unsubscribe;
  }, []);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, approvals]);

  const readyRuntimes = runtimes.filter((runtime) => runtime.available).length;
  const accountLabel =
    account.account?.email ??
    (account.status === 'waiting-for-browser' ? 'Conclua no navegador' : 'ChatGPT desconectado');
  const canChat = Boolean(projectDirectory) && account.status === 'signed-in';

  return (
    <div className="desktop-shell">
      <header className="glass desktop-header">
        <div className="logo-chip"><img src={edvidLogo} alt="Edvid" /></div>
        <div className="head-info">
          <div className="project-name">Edvid Desktop</div>
          <div className="state-message">Edicao de video por conversa</div>
        </div>
        <div className="head-actions">
          <span className={`account-dot ${account.status}`} />
          <span className="account-label">{accountLabel}</span>
          {account.status === 'signed-in' && (
            <button className="btn ghost small" onClick={logout}>Sair</button>
          )}
        </div>
      </header>

      <nav className="tabs" aria-label="Navegacao principal">
        <button className="tab active"><span className="tab-num">EDVID</span> Conversa</button>
        <button className="tab" disabled>Projetos</button>
        <button className="tab" disabled>Configuracoes</button>
      </nav>

      <main className="desktop-main">
        <div className={`project-selector glass ${projectDirectory ? 'selected' : ''}`}>
          <div className="project-selector-copy">
            <span className={`runtime-dot ${projectDirectory ? 'ready' : ''}`} />
            <div className="project-copy">
              <span className="project-kicker">Projeto ativo</span>
              <span className={projectDirectory ? 'project-path' : 'project-path dim'}>
                {projectDirectory ?? 'Escolha a pasta que contem o video e os assets'}
              </span>
            </div>
          </div>
          <button className="btn ghost" onClick={chooseProjectDirectory} disabled={Boolean(activeTurn)}>
            {projectDirectory ? 'Trocar pasta' : 'Escolher pasta'}
          </button>
        </div>

        {account.status !== 'signed-in' && (
          <section className="auth-card glass">
            <div>
              <span className="group-title">Conta OpenAI</span>
              <h2>Use sua conta do ChatGPT para conversar com o Edvid</h2>
              <p>
                O login acontece no navegador. As credenciais ficam sob controle do Codex
                App Server e nunca sao expostas para a interface.
              </p>
              {account.error && <div className="inline-error">{account.error}</div>}
            </div>
            <button
              className={`btn login-button ${account.status === 'waiting-for-browser' ? 'ghost' : 'primary'}`}
              onClick={account.status === 'waiting-for-browser' ? cancelLogin : login}
              disabled={account.status === 'starting'}
            >
              {account.status === 'starting'
                ? 'Preparando...'
                : account.status === 'waiting-for-browser'
                  ? 'Cancelar login'
                  : 'Entrar com ChatGPT'}
            </button>
          </section>
        )}

        <div className="workspace-grid">
          <section className="conversation-panel glass">
            <div className="conversation-head">
              <div>
                <span className="group-title">Direcao da edicao</span>
                <h2>Converse com o Edvid</h2>
              </div>
              <span className={`pill ${canChat ? 'saved' : ''}`}>
                {activeTurn ? 'Trabalhando' : canChat ? 'Pronto' : 'Configuracao pendente'}
              </span>
            </div>

            <div className="message-list" ref={messageListRef}>
              {messages.length === 0 && (
                <div className="conversation-empty">
                  <div className="empty-mark">E</div>
                  <h3>O que vamos editar?</h3>
                  <p>
                    Selecione a pasta, entre com o ChatGPT e descreva o resultado que deseja.
                    O Edvid pedira aprovacao antes de comandos ou alteracoes sensiveis.
                  </p>
                  <div className="prompt-examples">
                    <button onClick={() => setComposer('Inicie a edicao do video e prepare o corte limpo.')}>Iniciar corte limpo</button>
                    <button onClick={() => setComposer('Analise os videos e imagens da pasta assets.')}>Analisar assets</button>
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <div className={`message ${message.role}`} key={message.id}>
                  <span className="message-role">
                    {message.role === 'user' ? 'Voce' : message.role === 'assistant' ? 'Edvid' : 'Sistema'}
                  </span>
                  <p>{message.text || '...'}</p>
                </div>
              ))}

              {approvals.map((approval) => (
                <div className="approval-card" key={approval.id}>
                  <span className="approval-kicker">Aprovacao necessaria</span>
                  <strong>{approval.title}</strong>
                  {approval.detail && <code>{approval.detail}</code>}
                  {approval.cwd && <small>{approval.cwd}</small>}
                  <div className="approval-actions">
                    <button className="btn primary small" onClick={() => answerApproval(approval, 'accept')}>
                      Permitir uma vez
                    </button>
                    <button className="btn ghost small" onClick={() => answerApproval(approval, 'acceptForSession')}>
                      Nesta sessao
                    </button>
                    <button className="btn ghost small danger" onClick={() => answerApproval(approval, 'decline')}>
                      Recusar
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <form className="composer" onSubmit={sendMessage}>
              <textarea
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={canChat ? 'Descreva a proxima alteracao...' : 'Conecte a conta e escolha um projeto'}
                disabled={!canChat || sending}
                rows={2}
              />
              {activeTurn ? (
                <button className="btn ghost stop-button" type="button" onClick={interruptTurn}>
                  Parar
                </button>
              ) : (
                <button className="btn primary send-button" type="submit" disabled={!canChat || !composer.trim() || sending}>
                  Enviar
                </button>
              )}
            </form>
          </section>

          <aside className="sidebar">
            <section className="runtime-panel glass">
              <div className="panel-head">
                <div>
                  <span className="group-title">Ambiente local</span>
                  <h3>
                    {checking && runtimes.length === 0
                      ? 'Verificando dependencias'
                      : `${readyRuntimes}/${runtimes.length || runtimeNames.length} dependencias`}
                  </h3>
                </div>
                <button className="btn ghost small" onClick={refreshRuntimes} disabled={checking}>
                  {checking ? '...' : 'Verificar'}
                </button>
              </div>
              <div className="runtime-list">
                {runtimes.length === 0 &&
                  runtimeNames.map((name) => (
                    <div className="runtime-row pending" key={name}>
                      <span className="runtime-dot" />
                      <strong>{labels[name]}</strong>
                      <span className="runtime-source">aguardando</span>
                    </div>
                  ))}
                {runtimes.map((runtime) => (
                  <div className="runtime-row" key={runtime.name} title={runtime.version ?? runtime.error}>
                    <span className={`runtime-dot ${runtime.available ? 'ready' : 'missing'}`} />
                    <strong>{labels[runtime.name]}</strong>
                    <span className={`runtime-source ${runtime.source}`}>{sourceLabels[runtime.source]}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="system-panel glass">
              <span className="group-title">Aplicativo</span>
              <dl>
                <div><dt>Sistema</dt><dd>{desktopInfo?.platform ?? '...'}</dd></div>
                <div><dt>Arquitetura</dt><dd>{desktopInfo?.arch ?? '...'}</dd></div>
                <div><dt>Electron</dt><dd>{desktopInfo?.electronVersion ?? '...'}</dd></div>
              </dl>
              <p>O projeto fica separado do aplicativo e os originais sao preservados.</p>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
