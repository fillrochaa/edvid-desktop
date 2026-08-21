# Edvid Desktop — contexto consolidado do projeto

Atualizado em: 2026-08-19 (infra Windows completa: runtimes win32-x64, instalador Squirrel, updater e publicação — ver seção 14; falta a primeira rodada real)

Este documento registra o contexto de produto, arquitetura, decisões de UX,
correções e próximos passos definidos durante o desenvolvimento do Edvid
Desktop. Ele existe para que uma nova sessão ou agente consiga continuar o
trabalho sem reconstruir toda a conversa.

Não registrar aqui tokens, chaves de API, cookies, códigos OAuth ou outras
credenciais. Uma credencial foi compartilhada durante a conversa original, mas
foi deliberadamente omitida deste arquivo.

## 1. Identidade e separação dos projetos

Existem três contextos diferentes que não devem ser misturados:

1. **Edvid Desktop**
   - Repositório de desenvolvimento: `/Users/fillrocha/Developer/edvid-desktop`
   - GitHub: `https://github.com/fillrochaa/edvid-desktop.git`
   - Branch principal: `main`
   - Aplicativo Electron que instala e executa o Edvid no Mac e, futuramente,
     no Windows.

2. **Skill Edvid**
   - Clone de desenvolvimento: `/Users/fillrocha/Developer/edvid`
   - Instalação local usada pelo Codex: `/Users/fillrocha/.codex/skills/edvid`
   - Contém o método de edição, helpers de vídeo e templates compartilhados.
   - Não colocar código do Desktop neste repositório. Essa separação já foi um
     problema anteriormente e foi corrigida.

3. **Projetos individuais de vídeo**
   - Exemplo que originou várias decisões: `/Users/fillrocha/Documents/Coding/Edvid/Honor Robot Phone`
   - Projeto usado para testar o Desktop: `/Users/fillrocha/Documents/Coding/Edvid/teste edvid desktop`
   - Arquivos de edição e renders pertencem ao projeto de vídeo, nunca ao
     repositório do Desktop ou da skill.

## 2. Visão do produto

O Edvid Desktop deve transformar a experiência da skill Edvid em um aplicativo
instalável e acessível para usuários de Mac e Windows.

Objetivos centrais:

- Editar vídeo por conversa, mas usar controles visuais para decisões que ficam
  melhores fora do chat.
- Distribuir todas as dependências necessárias dentro do aplicativo.
- Permitir login com a conta do ChatGPT por meio do Codex App Server.
- Preservar sempre os arquivos originais.
- Trabalhar em duas fases principais:
  - Fase 1: transcrição, limpeza, cortes e aprovação do corte limpo.
  - Fase 2: estilo, legendas, headline, inserts, trilha e acabamento.
- Manter uma única timeline durante as fases. Novas tracks aparecem na mesma
  timeline conforme a edição avança.
- Evoluir a timeline até virar um editor não destrutivo de verdade.

## 3. Escolha tecnológica

Foi escolhido **Electron**, e não Tauri, para a primeira versão.

Motivos:

- O produto já usa React, Node.js e Remotion.
- Electron reduz a complexidade de integração com o ecossistema JavaScript.
- Runtimes pesados podem ser distribuídos como sidecars internos versionados.
- O tamanho maior do instalador foi aceito em troca de menor risco técnico na
  primeira versão.

Stack atual:

- Electron 43.4.0
- React 19
- TypeScript
- Vite
- Electron Forge
- Codex App Server
- FFmpeg/FFprobe
- Python + WhisperX
- Remotion para a Fase 2 e renders com elementos visuais

Arquivos centrais:

- `src/main.ts`: janela, projetos, mídia local, IPC, carga/persistência do
  modelo da timeline e sondagem das fontes.
- `src/timeline-model.ts`: módulo puro do modelo não destrutivo (migração de
  EDL, razor, trim, ripple delete, snap, programa de reprodução, sanitização e
  export de ranges). Testado por `scripts/test-timeline-model.mjs`.
- `src/runtime.ts`: resolução dos runtimes internos por plataforma.
- `src/codex-app-server.ts`: login ChatGPT, threads, streaming e aprovações.
- `src/preload.ts`: API segura exposta ao renderer.
- `src/App.tsx`: shell, chat, preview, timeline, estilos e correções.
- `src/styles.css`: design system e layout do aplicativo.
- `src/media-selection.ts`: escolha da mídia do preview (módulo puro, testado).
- `src/qa-browser-api.ts`: modo de QA visual sem Electron.
- `resources/remotion-template/`: template da Fase 2 embutido.
- `resources/helpers/`: geradores de legenda e tracking, expostos por
  `EDVID_HELPERS`.
- `forge.config.ts`: empacotamento para DMG, ZIP e Windows/Squirrel.
- `resources/runtime-manifest.json`: versões esperadas dos runtimes.

## 4. Runtimes empacotados

O aplicativo não deve depender silenciosamente de instalações feitas pelo
usuário. Em produção, os runtimes devem ser internos.

Versões atuais:

- Node.js 26.7.0
- npm 11.19.0
- FFmpeg/FFprobe 8.1.2
- FFmpeg compartilhado 7.1.5 para TorchCodec
- Filtro `deesser` incluído no FFmpeg
- `libx264` disponível
- uv 0.12.3
- yt-dlp 2026.07.04
- Python 3.12.13
- WhisperX 3.8.6
- OpenCV (headless) 4.14.0.94 para o tracking de rosto
- Codex App Server 0.147.0

Regras importantes:

- O processo do Codex recebe os diretórios dos runtimes internos no `PATH`.
- Também recebe `EDVID_PYTHON`, `EDVID_FFMPEG`, `EDVID_FFPROBE`, `EDVID_UV`,
  `EDVID_YTDLP`, `EDVID_WHISPER_MODEL` e `EDVID_HELPERS`.
- `PYTHONDONTWRITEBYTECODE=1` impede alterações dentro do bundle assinado.
- O agente não deve criar `.venv` dentro do projeto nem executar `pip install`.
- Para transcrição, usar o WhisperX já empacotado, por exemplo
  `python3 -m whisperx`.

### Caches e o modelo de transcrição (0.6.1)

A política `download-on-demand-to-app-data` do manifesto agora está de fato
implementada. Antes dela o modelo caía em `~/.cache/huggingface`, fora do
sandbox, e cada transcrição exigia aprovação do usuário.

- O `main.ts` cria `userData/cache/{huggingface,torch,matplotlib,xdg}` e passa
  `HF_HOME`, `HUGGINGFACE_HUB_CACHE`, `TORCH_HOME`, `XDG_CACHE_HOME` e
  `MPLCONFIGDIR` ao processo do Codex. Sem `MPLCONFIGDIR` o agente improvisava
  um diretório em `/tmp`.
- `HF_HUB_OFFLINE=1`: o agente nunca baixa modelo. Quem baixa é o aplicativo,
  no processo principal, com progresso visível na interface.
- O modelo é fixo em `small` (`Systran/faster-whisper-small`, ~464 MB) e é
  informado ao agente por `EDVID_WHISPER_MODEL`. Trocar o modelo exige mudar
  `WHISPERX_MODEL_NAME`/`WHISPERX_MODEL_REPO` no `main.ts`, senão o agente
  falha offline.
- O prefetch baixa TAMBÉM o modelo de alinhamento pt
  (`jonatasgrosman/wav2vec2-large-xlsr-53-portuguese` —
  `WHISPERX_ALIGN_REPO`): o whisperx resolve `--language pt` para esse repo
  e sem ele a transcrição offline morre depois do texto, na etapa de
  alinhamento (visto em máquina real na 0.13.7). O repo inteiro tem 3,5 GB,
  mas só o `pytorch_model.bin` (1,2 GB) é carregado — `allow_patterns` +
  `ignore_patterns` cortam `flax_model.msgpack` e `language_model/`
  (1,2 GB + 1,1 GB de peso morto). Transcrever é sempre com `--language pt`.
- O critério de "modelo pronto" mede ARQUIVO, não diretório
  (`cachedWeightSize` em `snapshots/<rev>/<peso>`, que o huggingface_hub só
  cria quando o download termina): somar o diretório contaria blobs
  `.incomplete` e daria por pronto um cache sem os pesos — cenário real de
  quem começou a baixar os 3,5 GB na 0.13.8.
- O modelo de VAD não é baixado: ele acompanha o pacote do WhisperX em
  `whisperx/assets/pytorch_model.bin`. Verificado rodando a transcrição
  completa com `HF_HUB_OFFLINE=1`.
- `ensureWhisperModel` termina com um healthcheck (`python -B -m whisperx
  --help`, uma vez por chave de pack, marcador em
  `cache/whisperx-ok-<chave>.json`): WhisperX instalado mas que não ABRE
  nesta máquina vira erro exato no banner, em vez do relato vago do agente.
- PATH NÃO É GARANTIA NO macOS (0.14.0, de máquina real): `/etc/profile` roda
  o `path_helper` em todo shell de login e RECONSTRÓI o PATH com as pastas do
  sistema na frente — o que injetamos vai para o fim. Sondado com
  `command/exec` (executa pelo mesmo caminho do agente, sem gastar turno de
  modelo): o pack caía nas posições 14/15, `which python3` dava
  `/usr/bin/python3` e `import whisperx` falhava — exatamente o "o WhisperX
  não está disponível no ambiente" que o aluno via, enquanto o Windows (sem
  path_helper) funcionava. `allow_login_shell = false` no config do Codex NÃO
  resolve (testado). Duas defesas: as instruções mandam chamar tudo por
  `"$EDVID_PYTHON"`/`"$EDVID_FFMPEG"` (caminho absoluto), e o app escreve um
  `sitecustomize.py` em `userData/runtime/pythonsite` (exposto por
  `PYTHONPATH`, alimentado por `EDVID_TOOL_DIRS`) que devolve as pastas do
  pacote para a frente do PATH DENTRO do Python — necessário porque o
  `whisperx.audio.load_audio` chama `ffmpeg` por nome via subprocess. Provado
  ponta a ponta pela sonda: `load_audio` decodificou 4800 amostras.

## 5. Login e provedores de IA (ChatGPT + Claude + Gemini)

Desde a 0.10.0 o Edvid tem três provedores de IA; cada aluno conecta a própria
conta e escolhe qual conduz a conversa (`settings.json` em userData guarda
`aiProvider`). Cada provedor aceita até dois modos: ASSINATURA (ChatGPT e
Claude, OAuth no navegador) e CHAVE DE API (os três; no Gemini é o único
caminho — o login gratuito com conta Google do Gemini CLI foi descontinuado
pelo Google em 18/06/2026, com migração para o Antigravity, que não suporta
ser embutido). Os TRÊS adaptadores emitem o mesmo vocabulário de eventos
(`assistant-delta`, `assistant-final`, `turn-state`, `approval-*`) pelo canal
`codex:event` — o chat do renderer não sabe qual provedor está por trás. O
roteamento fica no main: `codex:message` despacha pelo provedor ativo;
interrupção e aprovação são roteadas pela posse (`threadId`/approvalId com
prefixo `claude:` ou `gemini:`).

Chaves de API (validadas ANTES de aceitar, sempre):
- ChatGPT: `account/login/start { type: 'apiKey' }` no app-server (sondado:
  ele aceita qualquer texto sem validar e guarda a chave sozinho no
  CODEX_HOME — por isso o main valida em api.openai.com/v1/models antes).
- Claude: `claude-auth.json` vira união `{ mode: 'oauth', … } | { mode:
  'api-key', apiKey }`; a credencial entra no ambiente como
  `ANTHROPIC_API_KEY` em vez de `CLAUDE_CODE_OAUTH_TOKEN`. Validação em
  api.anthropic.com/v1/models.
- Gemini: `gemini-auth.json` (0600) + `GEMINI_API_KEY` no ambiente do CLI.
  Validação em generativelanguage.googleapis.com/v1beta/models.

ChatGPT (Codex App Server):
- O login com ChatGPT acontece pelo Codex App Server.
- O navegador recebe o fluxo OAuth e retorna ao aplicativo.
- O Codex usa um `CODEX_HOME` próprio dentro dos dados do Edvid.
- O fluxo já suporta `account/login/start`, cancelamento, logout, criação de
  thread, envio de turnos, streaming e interrupção.
- MODELO FIXO (0.13.6): o default do CLI 0.147.0 é `gpt-5.6-sol` (`isDefault`
  no `model/list`), que o backend recusa com 400 em conta ChatGPT ("The
  'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT
  account" — visto na máquina de aluno). O Edvid crava `gpt-5.6-terra`
  (`CODEX_CHAT_MODEL`), o sucessor oficial do antigo padrão (o catálogo do
  binário aponta upgrade de `gpt-5.4` → terra), em DOIS níveis: `model = "…"`
  no topo do config.toml gerado (chave de topo tem de vir ANTES de qualquer
  `[secao]`, senão o TOML a engole como chave da seção — esse era o bug da
  primeira sonda) e `model` + `allowProviderModelFallback: true` no
  `thread/start` (chat e thread utilitária de imagem). Sonda comprovou nos
  rollouts (`CODEX_HOME/sessions/**/rollout-*.jsonl`, gravados no primeiro
  turno) que sem pin a sessão usa sol e com qualquer um dos pins usa terra.
  Erros de turno agora passam por `friendlyAiError` no App (extrai a message
  do JSON cru e traduz "model is not supported" para PT-BR) e a notificação
  `error` com turno ativo não vira mais mensagem duplicada no chat (o mesmo
  texto chega de novo em `turn/completed`).

Claude (Agent SDK — detalhes na seção 13e):
- Login OAuth PKCE do próprio Claude Code (cliente público, porta de callback
  54545; fallback manual de colar o código). Tokens em
  `userData/claude-auth.json` (0600), refresh automático.
- A conversa roda no `@anthropic-ai/claude-agent-sdk` pinado, instalado sob
  demanda em `userData/runtime/claude` pelo npm empacotado (como o Remotion).
- Onboarding: depois do login da Creator Factory, se nenhuma IA estiver
  conectada, um modal oferece os dois logos; clicar abre o login daquele
  provedor. Também dá para conectar/trocar em Configurações → Geral.
- Se o provedor ativo está desconectado e o outro está pronto, o app troca
  sozinho (o aluno nunca fica com o chat travado por uma escolha antiga).

- O Desktop não deve depender da skill instalada no `CODEX_HOME` pessoal do
  usuário. As regras essenciais do produto ficam nas developer instructions do
  próprio aplicativo (compartilhadas entre os dois provedores —
  `EDVID_INSTRUCTIONS` exportada de `codex-app-server.ts`).
- O fuse de criptografia de cookies está desabilitado porque o Edvid não
  persiste cookies do Electron. Isso evitou o prompt desnecessário do macOS
  Keychain chamado “Edvid Safe Storage”.

## 6. Modelo de segurança e aprovações

- O Codex usa `approvalPolicy: never` (desde a 0.14.1) e sandbox POR
  PLATAFORMA (desde a 0.14.3): `workspace-write` no macOS, onde o seatbelt
  impõe de verdade, e `danger-full-access` no Windows, onde o backend não
  impõe nada e a combinação com `never` fazia a sessão virar somente leitura.
  DECISÃO DO FILL, tomada depois do teste real no Windows
  ("estou tendo que fazer MUUUUITAS aprovações, está irritante… não quero ter
  que fazer aprovações nem no mac nem no Windows"). O aluno veio editar vídeo,
  não auditar shell.
  - Causa da enxurrada, sondada: o sandbox do Windows não consegue impor
    restrição de arquivo (`windows sandbox backend cannot enforce
    file_system`, string do binário) e o Codex escalava tudo por precaução. No
    mac o seatbelt funciona e a sonda mediu ZERO aprovações mesmo com
    `on-request` — ou seja, o atrito era só do Windows.
  - O que `never` muda: quem responde à escalada, não o limite. O sandbox
    `workspace-write` continua declarado (escrita no projeto + caches do
    Edvid) e `network_access = false` segue valendo. Onde o sandbox impõe
    (mac), um comando fora do permitido falha em vez de perguntar.
  - O custo, dito por inteiro: no Windows o agente escreve sem sandbox e sem
    perguntar — o limite prático é a pasta do projeto, para onde todas as
    instruções apontam, não uma barreira do sistema. É consequência aceita
    conscientemente, e o risco efetivo é o mesmo de antes (lá o sandbox nunca
    impôs nada; só mudava quem clicava). Se o sandbox do Windows passar a
    impor de verdade (`windowsSandbox/setupStart` existe no protocolo e não é
    usado hoje), vale reavaliar e voltar para `workspace-write`.
- O `thread/start` aceita `sandbox` **apenas como string** (`read-only`,
  `workspace-write`, `danger-full-access`); não há parâmetros inline. Isso foi
  verificado sondando o app-server: qualquer objeto é recusado com
  "expected map with a single key" / "expected unit". A configuração fina vai
  no `config.toml` do `CODEX_HOME`, que o aplicativo escreve a cada start
  (`codex-app-server.ts`).
- Esse `config.toml` mantém `network_access = false` e declara os caches do
  aplicativo em `writable_roots`. É o que permite transcrever sem aprovação
  sem abrir rede para o agente.
- Remover a CAUSA da escalada continua sendo o trabalho principal (caminho
  gravável, conteúdo já baixado, ferramenta achável): `never` cala a pergunta,
  mas um comando que só funcionava porque o aluno aprovava agora falha calado.
  Toda causa nova de escalada precisa ser corrigida na raiz, como antes.
- Aprovações técnicas são necessárias para segurança, mas não pertencem ao
  histórico da conversa.
- Desde a versão 0.5.2, aprovações de comandos e alterações de arquivos aparecem
  em um modal central sobre o workspace.
- O modal oferece:
  - Recusar.
  - Permitir nesta sessão.
  - Permitir uma vez.
- O modal mostra comando, projeto e contexto, mas não cria uma mensagem no chat.
- Erros de aprovação ficam no próprio modal.
- O modal continua no código e ainda atende os outros provedores; com o Codex
  em `never` ele deixou de aparecer na prática.

## 7. Princípios de UX definidos

Preferências do usuário:

- Interface e comunicação em português do Brasil.
- Menos texto técnico no chat.
- Ações visuais devem acontecer por botões, seletores e timeline, não exigindo
  que o usuário digite palavras como “aprovado”.
- Caminhos absolutos de arquivos não devem aparecer no chat.
- O preview já mostra o arquivo, portanto links locais são redundantes.
- O design deve reutilizar o design system do Edvid; não criar uma identidade
  paralela.

Layout aprovado:

- Sidebar de projetos semelhante ao aplicativo do ChatGPT.
- Sidebar colapsada por padrão, expande em hover e pode ser fixada.
- Estado colapsado estreito, atualmente com aproximadamente 46 px.
- Chat na coluna esquerda, mais estreito que a área de edição.
- Área principal à direita com duas abas:
  - **Edição**: preview e timeline.
  - **Estilos**: seletores visuais da Fase 2.
- Vídeo vertical: preview 9:16 à direita e timeline à esquerda.
- Vídeo horizontal: preview acima da timeline.
- Controles de reprodução pertencem à barra inferior da timeline.
- Botão Play central, retroceder e avançar ao lado.
- Informação de tempo fica no cabeçalho da timeline.
- A agulha é o indicador de progresso; não usar uma barra de progresso separada.
- Labels das tracks mostram apenas ícones; os nomes ficam em `title`/acessibilidade.
- Não mostrar cabeçalho “Preview”, nome do arquivo ou botão de atualizar no player.
- Não mostrar a palavra “Projetos” abaixo do logo.

## 8. Branding

Assets oficiais foram fornecidos originalmente nestes caminhos:

- Ícone: `/Volumes/T7 FILL/_Creator Factory/Cursos/IA Edit Pro/Design/Icone_edvid.png`
- Logo: `/Volumes/T7 FILL/_Creator Factory/Cursos/IA Edit Pro/Design/logo_edvid.png`

Eles já foram preparados e incorporados ao repositório em `src/brand/`:

- `edvid-icon.png`
- `edvid-icon.icns`
- `edvid-icon.ico`
- `edvid-logo.png`
- `edvid-logo-white.png`

Não depender do volume externo em builds futuros.

## 9. Fluxo atual da edição

### Início

- O usuário abre uma pasta ou escolhe um projeto recente.
- O botão “Iniciar corte limpo” inicia o processo automaticamente.
- O usuário não precisa copiar o texto do botão para o chat e enviar
  manualmente.
- “Analisar assets” inicia a análise dos vídeos e imagens da pasta de assets.
- PASTA COM VÁRIOS VÍDEOS (0.13.6): antes do corte existir, a timeline
  espelha TODOS os vídeos-fonte em sequência, na ordem alfabética natural dos
  nomes (`deriveSourceMirror` no main → `modelFromSourceFiles` no módulo
  puro; ids = caminho relativo com `/`, a mesma forma dos sources do EDL). O
  preview entra em modo mapeado mesmo sem edição pendente (`sourceMirror` em
  App.tsx: `media.kind === 'source'` + clipes com fonte real) e toca um
  arquivo após o outro — o motor de troca de src por segmento já existia. O
  selo da barra vira “Vídeos em sequência” nesse estado (só diz “Prévia das
  edições” quando há edição de verdade). As instruções mandam o agente
  transcrever e cortar todos os arquivos e concatenar num render único, com o
  mapa `sources` no EDL. O J-Cut já resolvia fonte por segmento
  (`resolveJcutSource` por range), então funciona com corte multi-fonte.

### Quem decide os cortes — `helpers/clean_cut.py` (0.14.0)

O agente escolhia os trechos lendo o texto da transcrição e o resultado era
grosseiro ("o processo está muito burro, não identifica as pausas
corretamente", teste real no Windows). A decisão saiu do LLM e virou helper
determinístico, obrigatório nas instruções.

A lição que define o algoritmo, medida em fala com pausas de duração
conhecida: **o alinhador estica a última palavra da frase por cima do
silêncio**. Em `Terceira frase depois da pausa longa.` a palavra `longa.`
ficou marcada de 8,37s a 10,81s, enquanto a voz parou em 8,75s — o intervalo
entre palavras virou 0,02s e uma pausa de 2 segundos ficou invisível. Por isso
quem manda é o **silêncio real do áudio** (`silencedetect`), objetivo e imune
ao alinhamento; a transcrição serve para descartar blocos sem fala nenhuma
(ruído, batida de mesa). Cada bloco conserva `--keep` (0,12s) de respiração
DENTRO do silêncio, então nunca corta rente à sílaba. `--min-pause` (0,45s)
é o limiar do que vira corte. Sem trilha analisável há um plano B pelos
intervalos da transcrição, com aviso no stderr.

Provado com fala sintetizada (pausas de 1,5s / 0,25s / 2,0s): corta as duas
longas, preserva a curta, remove 25% do material. `npm run test:clean-cut`
trava a regra com os tempos REAIS daquela medição, incluindo o caso da
palavra esticada.

### Aprovação da Fase 1

- Ao finalizar o corte, o chat mostra somente um resumo do que foi feito.
- Links Markdown, `file://` e caminhos absolutos locais são removidos da
  visualização.
- O preview exibe automaticamente a mídia mais recente. O protocolo
  `edvid-media://` serve os arquivos com suporte a Range (206, sufixo,
  Accept-Ranges) via `resolveByteRange` + `createReadStream`; o
  `net.fetch(file://)` do Electron ignora Range e por isso a agulha não
  buscava em arquivos grandes — em mídia pequena o Chromium bufferiza tudo e o
  defeito fica invisível, inclusive no QA do navegador, que usa data URLs. A escolha está em
  `src/media-selection.ts` (módulo puro, testado): vence o arquivo dentro de
  `edit/` ou `edicao/` com a data mais nova; fontes na raiz, `assets/` e
  nomes de rascunho (`tmp`, `parte`, `sem_estilo`…) ficam de fora. Antes da
  0.6.1 a pontuação era por nome e o corte limpo escondia o render da Fase 2.
- Um botão **Aprovado** confirma visualmente o corte.
- Após a aprovação, o aplicativo abre a aba Estilos.

### Estilos da Fase 2

O usuário escolhe visualmente:

- Tipo de edição: limpa, tela dividida ou tela dividida 2. Com tela
  dividida, o briefing instrui por padrão a GERAR IMAGENS com IA ilustrando
  o que está sendo dito (pedidos.json → splits, posição top no split e
  bottom no split2; nunca duplicar o vídeo do aluno na outra metade) — a
  não ser que a Observação aponte outra fonte (ex.: "insira as imagens que
  estão na pasta do projeto"). Vídeos gerados ficam para quando houver MCP.
- Estilo de headline: outline, card, realce, misto ou sem headline.
- Estilo de legenda: karaokê, empilhada, dispersa, simples, serifada,
  clássica ou sem legenda.
- Cor de destaque.
- Tracking, zoom automático, zoom nos cortes, flash e trilha com IA.
- Observações livres.

O botão **Salvar e aplicar** persiste o briefing e o envia automaticamente para
o agente. O agente não deve voltar a perguntar as mesmas escolhas no chat.

O agente grava essas escolhas em `edicao/fase_2/briefing.json`, com nomes
próprios (`editing_type`, `accent_color`, `elements_included`). A interface lê
tanto esse formato quanto o `state.json` com a chave `style`; sem isso as
escolhas aplicadas não voltavam para a aba Estilos ao reabrir o projeto.

## 10. Timeline atual

Estado na versão 0.6.0:

- Uma única timeline representa Fase 1 e Fase 2.
- Tracks de vídeo e voz aparecem na Fase 1.
- Headline, legendas, assets e música aparecem na Fase 2 quando habilitados.
- O vídeo e o áudio são desenhados como clipes do modelo não destrutivo.
- Marcadores verticais mostram os cortes.
- O EDL continua sendo o contrato com o agente, mas o aplicativo agora mantém
  um modelo persistente próprio (ver seção 11).
- Após qualquer corte, o agente é instruído a criar ou atualizar
  `edit/edl.json` com um `range` por cena mantida.
- O `jcut_timeline` é escrito pelo APLICATIVO ao aplicar o J-Cut (0.13.0); o
  agente é proibido de escrevê-lo ou de antecipar áudio por conta própria
  (era o improviso dele que dessincronizava o vídeo).
- Projetos antigos sem EDL usam detecção visual de cenas como fallback.
- A detecção usa FFmpeg, escala reduzida e limiar de mudança de cena; ela é
  limitada a renders de até 15 minutos para evitar análise longa.
- Detecção visual é fallback, não substituto de um EDL correto.

Agulha e transporte:

- Clique na timeline reposiciona a agulha.
- Arrastar com o botão pressionado faz scrubbing.
- A timeline recebe foco ao ser clicada.
- `Espaço`: play/pause.
- `←` e `→`: um frame para trás ou para frente.
- O timecode usa `MM:SS:FF`, deixando o avanço de um frame verificável.
- `Cmd/Ctrl+Z`: desfaz a última ação de marcação.
- Cursor sobre a timeline é o cursor normal, não a cruz com símbolo de `+`.

Marcações de correção:

- `I` marca In.
- `O` marca Out.
- `M` alterna entre In e Out.
- Ao fechar um intervalo, aparece um campo de texto para a correção.
- É possível salvar várias marcações.
- Cada marcação mostra um botão de exclusão em hover.
- O botão **Aplicar** envia todas as correções em uma única passagem.
- O agente deve atualizar o EDL e o preview depois de aplicar as correções.

## 10b. Renderizador da Fase 2 (Remotion) — 0.7.0

Até a 0.6.1 o Desktop não tinha renderizador de Fase 2 nem a especificação dos
estilos. O agente, sem a skill e sem rede, improvisava: legendas `.ass` em
Arial queimadas pelo FFmpeg e "placas" PNG geradas com PIL. O resultado não
tinha relação com as escolhas da aba Estilos, e estilos animados (karaokê,
empilhada, dispersa) eram impossíveis por construção.

Como funciona agora:

- **Template embutido** em `resources/remotion-template/` (304 KB): é o
  `assets/shortform` da skill sem `node_modules`. Vai no pacote por
  `extraResource`. O código do template é a especificação dos estilos —
  fontes, tamanhos, easings e durações.
- **Runtime instalado pelo aplicativo**, uma vez, em
  `userData/runtime/remotion/`, com o Node/npm empacotados. São ~372 MB:
  178 MB de `node_modules` (`--omit=dev` corta TypeScript e `@types/react`),
  193 MB do Chrome Headless Shell (`remotion browser ensure`) e 748 KB de
  fontes. Todos os projetos compartilham esse runtime.
  - O npm empacotado é `node npm-cli.js` (command + argsPrefix na resolução de
    runtimes). Todo spawn de runtime deve passar por `runResolved`, que
    respeita o argsPrefix — passar só o `command` executa o binário do node
    como se fosse script e quebra na hora (bug da 0.7.4, invisível em
    desenvolvimento porque o runtime já estava instalado na máquina).
  - Mudou o fluxo de instalação? Validar com `userData/runtime/remotion`
    limpo, não apenas com o runtime pronto: a checagem de prontidão
    curto-circuita o caminho de instalação inteiro.
- **Fontes locais embutidas (v2)**: o `@remotion/google-fonts` (63 MB) não
  embarca os arquivos — ele aponta para `fonts.gstatic.com` e baixa durante o
  render, o que não funciona sem rede. A dependência foi removida; o
  aplicativo baixa as cinco famílias (Poppins, Playfair Display, Lora, Libre
  Baskerville, Inter) no install e gera `fonts/fonts.css` com os woff2
  **embutidos como data URIs** (primeira linha carrega a versão; mudou o
  formato, `remotionRuntimeIsReady` regenera). Causa comprovada com
  `--log=verbose` e marcadores `edvid-fonts` no console: o
  `await document.fonts.ready` original nunca resolvia em pelo menos uma aba
  de render, o `delayRender` das fontes estourava no `--timeout` e derrubava
  o render inteiro com ~75% pronto (reproduzido três vezes, sempre no mesmo
  ponto ≈ timeout de parede). O `src/fonts.ts` v2 carrega cada face declarada
  com `face.load()` (instantâneo com data URI, nada de rede) e mantém um
  backstop de 30 s que libera o handle de qualquer jeito.
- **Scaffold por projeto**: `scaffoldRemotionProject` copia o template para
  `edit/remotion/` e cria um symlink `node_modules` para o runtime
  compartilhado (junction no Windows). `public/` nunca é sobrescrito. O
  `renderPhase2` reaplica o scaffold antes de cada render, então correções no
  código do template chegam a projetos já montados.
- O agente só preenche `public/*.json` com os geradores oficiais; **quem
  renderiza é o aplicativo** (seção 10c). As instruções proíbem
  explicitamente npm install, `remotion render`, legenda queimada e imagem
  gerada em Python.

Decisões apuradas com teste, não por suposição:

- O `thread/start` não aceita sandbox parametrizado, e **o Electron não serve
  como navegador de render**: ele não expõe CDP com `--headless`, e o
  Remotion morre em timeout de 25 s. Um Chrome instalado do usuário funciona
  via `--browser-executable` (render visualmente idêntico, difere só no
  antialiasing dos glifos), mas depender disso tira o determinismo.
- Empacotar tudo levaria o instalador de 739 MB para ~1,2 GB por plataforma,
  com compositor e Chrome próprios em cada uma — inviável antes de validar o
  Windows. Daí a instalação sob demanda, no mesmo padrão do modelo do
  WhisperX.
- **Bug herdado da skill, corrigido aqui**: a cor de destaque estava literal
  (`#ff5200`) em três pontos do template e a escolha do usuário era ignorada
  no render. Agora `hook.accent` alimenta realce e misto, e
  `captions.accent` alimenta a linha serifada da empilhada. Verificado
  renderizando com `#0b72b1`.
- A verificação das fontes precisou de um controle: nesta máquina há Poppins
  instalada no sistema, então remover a folha local ainda renderizava certo e
  mascarava a falha. O teste decisivo usou Libre Baskerville, ausente do
  sistema — sem `fonts.css` ela cai para um serif genérico.
- O template embutido é uma **cópia** da skill. Mudanças de estilo na skill
  não chegam sozinhas ao Desktop; ao sincronizar, reaplicar a
  parametrização do accent.

## 10c. Render da Fase 2 pelo aplicativo — 0.7.6

O agente não roda `remotion render`. Motivo comprovado em campo: **o Chromium
do render não inicia dentro do sandbox do Codex**
(`Chromium.MachPortRendezvousServer: Permission denied`), então toda
tentativa exigia escalação e aprovação do usuário — e o limite de tempo dos
comandos ainda forçava o agente a fatiar o vídeo em partes de 1100 frames,
cada uma com nova aprovação (seis diálogos numa única Fase 2). É o mesmo
princípio da transcrição na 0.6.1: nunca auto-aprovar; remover a causa.

Fluxo atual:

- Depois de **todo turno concluído** (e ao abrir o projeto), a interface chama
  `phase2:render`. O main calcula o fingerprint dos insumos em
  `edit/remotion/public/` (`edit-data.json`, `captions.json`,
  `caption-cues.json`, `segments.json`, `track.json` e `cut.mp4`; sem
  `edit-data.json` e `cut.mp4` não há o que renderizar) e compara com
  `edit/remotion/out/render-stamp.json`. Nada mudou → responde na hora.
- Mudou → garante o runtime, reaplica o scaffold, **apaga o cache do webpack
  do runtime** e roda `node remotion-cli.js render Reels` fora do sandbox,
  com `--timeout=120000`, transmitindo progresso (`Rendered N/M`) para a
  barra na seção de preview. O cache não é opcional de apagar: ele serviu um
  módulo velho mesmo com o arquivo mudado no disco, e duas rodadas de
  correção do fonts.ts pareceram "não funcionar" por causa disso. Sempre que
  um render se comportar como se uma mudança não existisse, limpar
  `node_modules/.cache/webpack` do runtime antes de concluir qualquer coisa.
- O resultado sai versionado em `edicao/fase_2/fase_2_vN.mp4` (nunca
  sobrescreve; o preview escolhe o mais recente sozinho) e o carimbo é
  gravado. Um erro vira mensagem de sistema no chat com o motivo real.
- Velocidade medida neste Mac (M-series, 14 núcleos): ~4340 frames
  1080×1920 em ~4 min com a concorrência padrão — contra ~12 min nas partes
  fatiadas do agente com `--concurrency=3`.

### Helpers da Fase 2 e tracking (0.7.0)

- Os geradores oficiais estão embutidos em `resources/helpers/` (24 KB) e
  chegam ao agente pela variável `EDVID_HELPERS`, sem cópia dentro do projeto:
  `captions_for_remotion.py` (captions.json), `caption_style.py`
  (caption-cues.json, obrigatório para a legenda empilhada), `face_track.py`
  (track.json) e `segments_for_remotion.py` (segments.json).
- Eles vieram da skill esperando o formato do `transcribe.py`, com uma lista
  `words` no topo. O Desktop transcreve com o WhisperX empacotado, que emite
  `segments[].words[]` com a chave `word`. O resultado eram **zero palavras em
  silêncio**, e o agente acabava inventando o JSON. `_transcript.py` normaliza
  os dois formatos; `npm run test:helpers` cobre isso comparando as duas
  entradas.
- O tracking de rosto agora funciona: `opencv-python-headless>=4.10,<5` entrou
  no `python/whisperx/pyproject.toml`. A faixa é obrigatória — o OpenCV 5
  removeu `CascadeClassifier` e os cascades Haar, que são a base do detector.
  Verificado num trecho real: 120 frames, 100% de detecção.
- Trocar o lock exige rodar `npm run stage:python-whisperx` para o `cv2`
  entrar no runtime empacotado.

- O `segments_for_remotion.py` fecha os quatro arquivos de dados. Ele mede os
  frames reais com `ffprobe -count_frames` quando existem clipes por corte e,
  quando o corte é um arquivo único, deriva do EDL acumulando em **frames
  inteiros**. Somar segundos acumula erro: num teste com cinco cortes a soma
  ingênua ficava 57 ms atrás, o bastante para o zoom disparar fora do corte.
  Os valores saem com 9 casas — com 6, um limite de 31 frames a 30 fps deixa
  de voltar exatamente a 31.

Pendências conhecidas deste marco:

- As miniaturas da aba Estilos (`src/styles.css`) ainda são uma impressão
  aproximada; a especificação fiel está em `src/brand/preview-base.css`.

## 11. Timeline como editor real — estado na 0.6.0

A primeira versão do editor não destrutivo está **implementada** na 0.6.0.

Modelo persistente (`TimelineModel` em `src/shared.ts`, operações em
`src/timeline-model.ts`):

- Clipes com `id`, `trackId` (`video`/`voice`), `linkId` (vínculo vídeo↔voz),
  `sourceId`, `sourceIn`/`sourceOut` (tempo do arquivo-fonte),
  `timelineStart`, `enabled`, `speed`, `gainDb` e fades.
- O modelo é migrado do `edl.json` real: `ranges` dão os tempos de fonte,
  `jcut_timeline` dá posições/durations de saída (J-cuts viram clipes de voz
  deslocados). A migração é determinística (ids `v-NNN`/`a-NNN`/`link-NNN`),
  o que permite detectar se um `timeline.json` salvo contém edições.
- Persistência em `timeline.json` ao lado do EDL (`edit/` ou `edicao/`), com
  fingerprints do EDL e da mídia. Se o agente re-renderizar (EDL/mídia mudam),
  o modelo é re-migrado do EDL novo; edições pendentes salvas sobrevivem a
  recargas enquanto o EDL não mudar.
- Fontes referenciadas são sondadas com FFprobe e recebem tokens
  `edvid-media://` próprios; sem o arquivo, o limite de trim é o trecho já
  usado.
- Segurança e robustez (decisões da revisão da 0.6.0): só arquivos de vídeo
  dentro da pasta do projeto recebem token de mídia (um `sources` malicioso no
  EDL não expõe outros caminhos); tokens são estáveis por arquivo+mtime, então
  recarregar o workspace após cada turno não remonta o player nem reseta
  agulha/zoom/undo; `timeline.json` é gravado de forma atômica e o save
  carrega um carimbo da carga que o originou — se o EDL/mídia mudaram no meio
  (agente re-renderizou), o save obsoleto é ignorado; o renderer descarrega o
  save pendente antes de qualquer refresh do workspace.

Ferramentas implementadas no editor:

1. Seleção de clipes (vídeo e voz vinculados destacam juntos).
2. Handles nas extremidades com trim ripple e snap em cortes/agulha.
3. Razor na agulha (`C` ou botão de tesoura), dividindo vídeo+voz e religando
   as metades por `linkId`.
4. `Delete`/`Backspace` faz ripple delete; `Shift+Delete` deixa espaço.
5. Undo/redo (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`) por pilha de modelos, unificada
   com o undo das marcações de correção.
6. Zoom horizontal 1×–8× ancorado na agulha (`+`, `-`, `0` e botões).
7. Prévia mapeada: com edições pendentes o preview reproduz os arquivos-fonte
   pulando entre segmentos (relógio próprio em espaços vazios), sem render.
8. A prévia mapeada tem duas camadas: o rAF move a agulha e troca de segmento
   enquanto o transporte está ativo, e um `timeupdate` no próprio `<video>`
   impõe o fim de cada segmento mesmo que o motor tenha parado. Sem essa
   segunda camada, qualquer retomada do elemento por fora do estado do React
   fazia o arquivo-fonte tocar inteiro, ignorando os cortes.
9. "Aplicar ajustes" envia os novos ranges (tempo de fonte) ao agente para
   regravar o EDL e re-renderizar; "Descartar" volta ao corte atual.
   Enquanto houver edições pendentes, as marcações In/Out ficam bloqueadas.
   Desde a 0.13.2 esses botões vivem na BARRA DO TOPO da timeline (junto do
   badge "Prévia das edições" e do timecode), ao lado dos botões visíveis de
   desfazer/refazer — os atalhos ⌘Z/⇧⌘Z existem desde a 0.6.0 (listener no
   window; o estado habilitado dos botões lê os refs de histórico, exato
   porque toda mutação re-renderiza).

Regras preservadas:

- A edição é não destrutiva; estender um clipe só recupera conteúdo que exista
  no arquivo original (limitado pela duração sondada da fonte).
- Gestos alteram imediatamente o modelo JSON; nada é renderizado por gesto.
- FFmpeg e Remotion continuam responsáveis pelo render definitivo.
- O modelo é a fonte de verdade; o render é derivado ao Aplicar.

Ainda não implementado (próxima etapa): thumbnails e waveform pré-calculados,
mover clipes na timeline, edição de velocidade/ganho/fades pela interface.

## 12. Decisões de estilo vindas do projeto Honor Robot Phone

O projeto Honor Robot Phone foi usado para validar padrões visuais e de áudio:

- Headline reduzida em aproximadamente 30% e posicionada na junção de layouts
  em tela dividida.
- Legendas reduzidas em aproximadamente 20%.
- O nome correto nas legendas é **Fill**, nunca “Phill”.
- Headline usada no teste:
  “Este celular cria 2 problemas pra criadores de conteúdo”.
- O vídeo “Honor 1” foi usado no hook em tela dividida e podia reaparecer depois.
- Foi corrigido um caso em que vídeos apareciam congelados como imagens.
- O volume de trilha discutido ficou na faixa de −15 a −20 dB. A interface do
  Desktop atualmente exibe −15 dB; confirmar a referência final antes de mudar
  esse padrão global novamente.

Os tamanhos devem ser padrões relativos por estilo, não números únicos que
destruam as diferenças entre os estilos de headline e legenda.

## 13. Empacotamento macOS

Versão corrente: **0.8.2** (instalada via OTA; DMGs assinados de 0.8.1 e
0.8.2 em out/make/).

Artefato de instalação para alunos:

`/Users/fillrocha/Developer/edvid-desktop/out/make/Edvid-0.8.2-arm64.dmg`

Configuração do DMG:

- Janela 660 × 400.
- Edvid em `(180, 220)`.
- Applications em `(480, 220)`.
- Fundo normal e Retina próprios.
- Ícone oficial do Edvid no volume.
- Layout centralizado e compacto.

O build local usa assinatura ad-hoc quando `EDVID_MAC_SIGN_IDENTITY` não está
configurado.

### 13b. OTA e assinatura de produção (pipeline pronto na 0.7.9)

A conta Apple Developer existe e está ativa. O pipeline inteiro está no
repositório e liga sozinho pelas variáveis de ambiente — falta plugar
credenciais e hospedagem:

- **Assinatura de produção**: `EDVID_MAC_SIGN_IDENTITY="Developer ID
  Application: Nome (TEAMID)"` com o certificado instalado no Keychain.
  Com identidade real o build usa Hardened Runtime +
  `entitlements.mac.plist` (JIT do V8, validação de biblioteca desligada e
  dyld liberado para o Python/PyTorch e FFmpeg embutidos).
- **Notarização**: `EDVID_APPLE_ID`, `EDVID_APPLE_APP_PASSWORD` (senha de
  app de appleid.apple.com) e `EDVID_APPLE_TEAM_ID`. Presentes as três +
  identidade, o `npm run make` assina, notariza e grampeia.
- **OTA (Squirrel.Mac, o mesmo do app do ChatGPT)**: o aplicativo checa um
  feed JSON a cada 4 h e no boot, baixa em segundo plano e mostra
  "Atualizar para X · Reiniciar" no topo; um clique instala e reabre.
  O feed sai de `node scripts/generate-update-feed.mjs <URL base>` usando o
  ZIP que o make já produz. Hospedagem recomendada: bucket Cloudflare R2
  público (egresso gratuito; cada update pesa ~820 MB hoje). A URL definitiva
  entra em `UPDATE_FEED_URL` (src/main.ts) — até lá, o updater fica inerte
  (também aceita `EDVID_UPDATE_FEED_URL` para teste).
- **Avisos honestos**: o Squirrel recusa builds ad-hoc — OTA só funciona a
  partir do primeiro build assinado; e a primeira notarização real dos
  runtimes embutidos (centenas de Mach-O do Python/Torch) é o ponto
  sabidamente trabalhoso — reservar uma iteração para ela.
- Otimização futura: mover os runtimes (~700 MB) para download sob demanda
  como o Remotion, derrubando o update para ~100 MB.

**Status: OTA comprovado de ponta a ponta em 2026-08-18.** Fluxo verificado
no ambiente real: 0.8.1 assinada+notarizada instalada → boot → feed no R2 →
download de 855 MB em segundo plano → staging validado pelo Squirrel
(assinatura conferida) → botão "Atualizar para 0.8.2 · Reiniciar" → clique →
app trocado e reaberto como 0.8.2, Gatekeeper e stapler OK. O release de
cada versão é: `npm run make:signed` e `npm run publish:update` (aceita a
versão como argumento para publicar uma build anterior).

Lições de campo desta primeira rodada:

- Keychain com "0 valid identities" e o certificado presente =
  **intermediária ausente**; instalar a Developer ID G2 CA de
  apple.com/certificateauthority/DeveloperIDG2CA.cer resolve.
- A notarização dos runtimes embutidos (Python/Torch/FFmpeg) passou de
  primeira com o Hardened Runtime + entitlements.mac.plist — a iteração
  reservada não foi necessária.
- O wrangler limita uploads a 300 MiB; o publicador usa o protocolo S3 do
  R2 com multipart, derivando as credenciais do próprio token (access key =
  id do token via verify, secret = SHA-256 do valor).
- O botão de atualização precisava aparecer também no gate de login
  (corrigido pós-0.8.2): aluno na tela de entrada ficava sem ver o update.

### 13d. Runtimes sob demanda — instalador magro (0.8.3)

As ferramentas (FFmpeg, Python/WhisperX/PyTorch, Node, Codex, uv, yt-dlp —
1,8 GB descomprimidas) **não vão mais no instalador**. O aplicativo baixa um
runtime pack uma única vez no primeiro boot, com progresso no chat
("Preparando o Edvid"), e de novo apenas quando alguma versão do
`runtime-manifest.json` mudar. Com isso cada update OTA cai de ~855 MB para
~100 MB.

- **Chave do pacote**: `runtimePackKey()` em src/runtime.ts = sha256 de
  `JSON.stringify(manifest.runtimes)` (12 hex). `scripts/pack-runtimes.mjs`
  computa a mesma chave — mudar um, mudar o outro.
- **Fluxo no app**: `ensureRuntimePack()` (single-flight) baixa
  `runtimes/<plat>-<chave>.tar.gz` do bucket, verifica o `.sha256`, extrai
  com o bsdtar do sistema em `tools.partial` e troca atômico para
  `userData/runtime/tools` com um `pack.json` de marcador. `resolveRuntime`
  procura primeiro em tools, depois em resources (o repositório de dev segue
  com as ferramentas staged e nunca baixa pacote).
- **Gates**: modelo Whisper, servidor Codex (via `codexServer()`),
  instalação/render do Remotion, ffprobe do workspace e ondas sonoras
  aguardam o pacote; com ele instalado o await resolve na hora.
- **Release do dia a dia**: `npm run make:signed` + `npm run publish:update`.
  **Só quando o manifest de runtimes mudar**: `npm run pack:runtimes` +
  `npm run publish:runtimes` (o publish pula se a chave já estiver no
  bucket) — e o publish:update da release correspondente.
- QA visual: `?pack` na URL simula o download do primeiro boot.

### 13c. Login de alunos — Creator Factory (0.8.0)

O acesso ao Edvid é dos alunos com matrícula ativa no curso **IA Edit Pro**
da Creator Factory (plataforma própria, Next.js + Supabase, repo
`fillrochaa/creator-factory`). O gate usa a infraestrutura existente, sem
backend novo:

- **Mesmo login da área de membros**: Supabase Auth direto
  (`/auth/v1/token`, grant password/refresh) com a **anon key** pública. A
  senha nunca é persistida; o refresh token (rotativo) fica em
  `userData/member-auth.json` (0600).
- **Direito de uso**: leitura das próprias matrículas via política RLS
  existente `enrollments_select_own_or_admin` —
  `enrollments?select=status,expires_at,course:courses(slug,title)`; vale
  matrícula `active` não expirada do slug `ia-edit-pro-thpgfw` (fallback por
  título "IA Edit Pro", caso o curso seja recriado). Compra/reembolso já
  mantêm a tabela em dia pelos webhooks Hotmart/Kiwify/Hubla da plataforma.
- **Estados**: `unconfigured` (sem chaves → gate desligado, app normal),
  `signed-out`, `checking`, `no-access` (login ok sem matrícula; sessão fica
  guardada para reabrir resolver) e `signed-in` (com `offline: true` quando
  validando pela tolerância de 7 dias sem rede).
- **UI**: tela de login em tela cheia (e-mail/senha da Creator Factory),
  tela "matrícula não está ativa", bloco do aluno com Sair na rail. O login
  do ChatGPT (agente) permanece separado.
- **Para ativar**: preencher `MEMBER_SUPABASE_URL` e
  `MEMBER_SUPABASE_ANON_KEY` em src/main.ts (ou env `EDVID_SUPABASE_URL`/
  `EDVID_SUPABASE_ANON_KEY` para teste) com a Project URL e a anon key do
  painel Supabase. A anon é pública por design (RLS protege); a
  **service_role jamais** entra no app ou no repositório.
- QA visual: `?aluno` na URL do QA simula deslogado; senha "errada" e e-mail
  contendo "sem-acesso" exercitam os erros.

Ao testar um DMG novo, ejetar a versão montada anteriormente para evitar que o
Finder reaproveite estado antigo.

### 13e. Provedor de IA duplo — Claude via Agent SDK (0.9.0)

Arquitetura (`src/claude-agent.ts`, tudo em um módulo):
- Conversa: `query()` do `@anthropic-ai/claude-agent-sdk` com entrada em
  streaming (um envio por turno, canal aberto até o `result`) — é o que
  habilita `interrupt()` para o botão Parar. Sessões retomadas por projeto
  via `resume` (session_id capturado no `system:init`; em memória, como as
  threads do Codex).
- Opções do query espelham o modelo do Codex: `systemPrompt` preset
  `claude_code` + `EDVID_INSTRUCTIONS`; `settingSources: []` (NADA do
  `~/.claude` do usuário entra: sem CLAUDE.md, hooks ou MCPs da máquina);
  `permissionMode: 'acceptEdits'`; `disallowedTools: WebSearch/WebFetch`;
  sandbox nativo `{ enabled, autoAllowBashIfSandboxed, network sem domínios,
  filesystem.allowWrite: caches }` — comando sandboxed roda sem prompt,
  escapar do sandbox cai no `canUseTool`, que vira o card de aprovação
  padrão da interface ("permitir nesta sessão" mantém um allowlist em
  memória). AskUserQuestion é negada com instrução de perguntar em texto.
- Ambiente: variáveis `ANTHROPIC_*`/`CLAUDE_*` herdadas são REMOVIDAS antes
  de montar o env (uma `ANTHROPIC_API_KEY` da máquina teria precedência
  sobre o token do aluno); entram o PATH das ferramentas empacotadas +
  `EDVID_*` + caches (mesmo env do Codex, `agentToolsEnvironment()` no
  main), `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` (userData/claude),
  `DISABLE_AUTOUPDATER=1`.
- Runtime: SDK pinado (`CLAUDE_SDK_VERSION` em claude-agent.ts; o pacote
  embute o binário nativo do Claude Code da mesma versão via
  optionalDependency por plataforma). Instalado sob demanda em
  `userData/runtime/claude` com o npm empacotado; carregado com import()
  dinâmico protegido por `new Function` (o bundle CJS do main reescreveria
  import() para require() e quebraria o ESM). A instalação dispara em
  segundo plano no login e no boot (conta conectada), para a primeira
  mensagem não esperar npm install.
- Login OAuth: fluxo PKCE público do próprio Claude Code, nos endpoints
  ATUAIS extraídos das strings do CLI 2.1.235 embutido no SDK:
  claude.com/cai/oauth/authorize → platform.claude.com/v1/oauth/token
  (redirect manual platform.claude.com/oauth/code/callback; client_id
  público 9d1c250a…, escopos org:create_api_key user:profile
  user:inference). Os endereços legados (claude.ai/oauth/authorize +
  console.anthropic.com/v1/oauth/token) ainda RENDERIZAM a página de
  login, mas a troca do código parou de completar — na 0.9.0–0.12.2 o
  aluno autorizava no site e a conta nunca conectava. Callback local em
  `http://localhost:54545/callback` (porta registrada do CLI; o servidor
  do authorize aceita qualquer porta de loopback); porta ocupada → fluxo
  manual com `code=true` (o site mostra `código#estado` e o aluno cola no
  app). A página local só anuncia "Login concluído" DEPOIS da troca do
  token (antes anunciava na hora e mascarava falha de troca); o
  encerramento derruba conexões keep-alive (closeAllConnections) para a
  porta 54545 não ficar presa numa nova tentativa. Refresh automático com
  margem de 5 min; só um refresh RECUSADO (HTTP 400/401) desloga — 429,
  5xx e falta de rede são transitórios e mantêm os tokens. O endpoint de
  token responde erros ora como OAuth (error_description) ora como API
  (`{error:{message}}`) — os dois são tratados. Diário sanitizado em
  `userData/claude-login.log` (etapas e status HTTP, nunca códigos,
  tokens ou verifier) para diagnosticar um login que falha à distância.
  O endpoint de token limita por IP com facilidade (429 real em uso):
  o callback responde página neutra na hora e a troca roda no app com
  retries (3s/8s/20s/45s) e estado finishing no modal; refresh com
  retries curtos (2s/5s). EDVID_OAUTH_CALLBACK_PORT muda a porta nas
  sondas (o authorize aceita qualquer porta de loopback).
- Provas executadas no desenvolvimento (sem conta real): instalação com o
  npm empacotado ok; probe do query com token falso passou TODA a
  validação de opções (init com session e claude-sonnet-5) e falhou
  exatamente na autenticação (401) — com token real é um turno vivo. A
  página de autorização renderiza o fluxo real no navegador (nos dois
  domínios; a diferença dos endpoints aparece só DEPOIS do authorize).
  Sonda com servidor de token FALSO (fetchImpl injetado) cobre o fluxo
  inteiro sem conta: URL do authorize, callback com state, corpo da
  troca, gravação 0600, página verdadeira de sucesso/falha, fluxo manual
  e semântica do refresh — 24 verificações. Lição: o SDK LANÇA depois de
  um result com erro — extrair a mensagem do result e não deixar o catch
  sobrescrever.
- QA visual: `?ia` abre o app sem nenhuma IA conectada (onboarding);
  `?ia=manual` força o fluxo de colar código ("codigo-errado" simula
  recusa). Chaves com "errada" no texto simulam recusa nos três provedores.

### 13g. Papéis chat/imagem + geração de imagens pelo app (0.11.0)

Papéis (`AiRolesState` em settings.json: chatProvider/imageProvider +
chatPinned/imagePinned; "aiProvider" antigo migra para chatProvider):
- As REGRAS AUTOMÁTICAS moram no renderer (que enxerga todas as contas):
  chat cai para outro provedor conectado quando o preferencial desconecta
  (estado resolvido primeiro — nunca por corrida de boot); imagem segue a
  capacidade: ChatGPT por ASSINATURA > Gemini por chave > nada. Escolha
  explícita (pinned) só é desfeita se o provedor escolhido desconectar.
  Capacidade de imagem: ChatGPT em QUALQUER modo (assinatura usa a ferramenta
  do Codex na cota do plano; chave usa a API de imagens da OpenAI, paga por
  imagem — ~US$0,05 na qualidade media); Gemini por chave; Claude nunca.
- Seletores rápidos sob o composer (Chat/Imagem) trocam preferenciais sem
  abrir Configurações; a aba Conexões mostra chips "Chat"/"Imagem" por
  provedor e "Usar no chat".
- Fallback de limite: turno que FALHA com erro de limite/cota (regex sobre a
  mensagem) e outro chat conectado → troca automática + mensagem de sistema;
  NUNCA reenvia a mensagem (evita edição dupla). O erro cru do provedor (em
  inglês) nunca chega ao aluno: sem alternativa conectada o chat mostra
  "Você chegou ao limite de uso da IA. Tente novamente mais tarde ou conecte
  outra IA." (0.12.3; "simular limite" no QA exercita os dois caminhos). O
  app-server também emite account/rateLimits/updated (usedPercent) —
  capturado em lastRateLimitUsedPercent para uso futuro.

Geração de imagens (mesmo padrão da Fase 2 — dados no projeto, app executa
fora do sandbox):
- O agente de chat (qualquer provedor) escreve edit/imagens/pedidos.json
  [{arquivo, prompt, proporcao 9:16|1:1|16:9}] — contrato nas
  EDVID_INSTRUCTIONS. Depois de cada turno o renderer chama image:fulfill;
  o main gera as pendentes com a IA de imagem e salva em edit/imagens/;
  pedidos atendidos saem da fila, falhas ficam e vão ao chat.
- CONTINUAÇÃO AUTOMÁTICA (0.11.1): geração que termina em ready com done>0
  dispara sozinha um turno "Imagens prontas — aplicando na edição" — sem
  isso o agente pedia a imagem, o app gerava e NINGUÉM aplicava (o agente
  não volta sozinho depois que o turno acaba; achado em uso real). O
  despacho sai de um efeito (closures atuais), nunca do handler de evento
  registrado no boot, que tem closures congeladas.
- Backend ChatGPT: runUtilityTurn no CodexAppServer — thread própria
  invisível ao chat (eventos suprimidos, aprovações auto-recusadas) que
  instrui a skill imagegen (gpt-image-2, cota da assinatura). SONDADO com o
  login real: item imageGeneration in_progress→completed, zero aprovações,
  arquivo salvo. Nomes de arquivo achatados com path.basename (nada de ../).
- Backend ChatGPT por CHAVE: generateOpenAiImage no main — POST
  api.openai.com/v1/images/generations { model gpt-image-2, size por
  proporcao (1024x1536/1536x1024/1024x1024, retry 'auto' em 400),
  quality medium } → b64_json. A chave e lida do auth.json que o proprio
  app-server guarda no CODEX_HOME do Edvid (o app nunca teve copia
  propria). Validar com chave real na primeira utilizacao.
- Backend Gemini: generateImage no GeminiAgent — REST
  models/gemini-2.5-flash-image:generateContent com responseModalities
  [TEXT,IMAGE] e imageConfig.aspectRatio (retry sem o campo se recusar);
  inlineData base64 → PNG. Free tier do Nano Banana cobre; validar com
  chave real na primeira utilização.
- Modelos padrao (nenhum fixado pelo Edvid, todos herdados dos motores):
  chat ChatGPT = gpt-5-codex (padrao do app-server 0.147); chat Claude =
  claude-sonnet-5 (padrao do Agent SDK com assinatura, visto no init da
  sondagem); chat Gemini = 'auto' (gemini-3.1-pro-preview quando
  disponivel, senao gemini-3.5-flash — com chave gratis fica no flash);
  imagem = gpt-image-2 (ferramenta do Codex e API) e
  gemini-2.5-flash-image (pinado no Edvid).
- QA: ?imagens simula a fila (banner de progresso no chat).

### 13f. Gemini via ACP + chave de API (0.10.0)

Arquitetura (`src/gemini-agent.ts`):
- O CLI oficial `@google/gemini-cli` PINADO, instalado sob demanda em
  `userData/runtime/gemini` com o npm empacotado (os nativos node-pty/keytar
  são optionalDependencies — o bloqueio de install-scripts do npm novo é
  inofensivo). Um processo `gemini --acp` de vida longa (JSON-RPC 2.0 por
  stdio, newline-delimited), sessões por projeto via `session/new { cwd }`.
- Sondagens que definiram o desenho (contra o CLI real, com chave falsa):
  initialize lista authMethods e `gemini-api-key` entra sozinho quando
  `GEMINI_API_KEY` está no ambiente (sem chamada authenticate); modelos
  gemini-3.1-pro-preview / gemini-3.5-flash (padrão `auto`);
  `session/set_mode { modeId: 'autoEdit' }` é o nome de wire correto e FALHA
  com "untrusted folder" até desligar o gate por settings de sistema:
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH` → arquivo do Edvid com
  `security.folderTrust.enabled=false` + `privacy.usageStatisticsEnabled=false`.
  `session/prompt` com chave falsa falha exatamente na API (API_KEY_INVALID),
  com o erro em JSON aninhado em string (há um desembrulhador de 3 níveis).
- Modo `autoEdit`: edições de arquivo sem prompt; comandos chegam por
  `session/request_permission` e viram o card de aprovação padrão
  ("permitir nesta sessão" responde com a opção `allow_always`, que o CLI
  lembra pelo resto da sessão). Sem sandbox do lado do Gemini na v1 — os
  comandos rodam com aprovação explícita do aluno.
- Instruções: o ACP não tem prompt de sistema; as EDVID_INSTRUCTIONS entram
  como preâmbulo da PRIMEIRA mensagem de cada sessão.
- Interrupção: notificação `session/cancel` → prompt retorna stopReason
  `cancelled`. Streaming: `session/update` com
  `update.sessionUpdate === 'agent_message_chunk'`.

### 13h. J-Cut determinístico pelo aplicativo (0.13.0)

O J-Cut deixou de ser um pedido ao agente (que re-renderizava "com J-cuts" e
dessincronizava o vídeo) e virou operação determinística do app, no padrão da
Fase 2:

- `src/jcut.ts` (módulo puro, testado em test:jcut): `planJcut(ranges)` calcula
  a antecipação por junção (150 ms com clamps: material disponível antes do
  in, no máx. 45% dos takes vizinhos, mínimo audível 30 ms; plano só vale com
  TODOS os ranges válidos — o jcut_timeline é pareado 1:1 na migração) e gera
  os comandos ffmpeg: extração das peças WAV (cada take começa "lead" antes do
  in), mixagem única (afade in/out nas junções + adelay por posição + amix
  normalize=0 + atrim no total) e remux com `-c:v copy` — o vídeo NUNCA é
  reencodado, então a soma das peças fecha exatamente na duração do vídeo e
  dessincronia é impossível por construção. Provado no test:jcut com o ffmpeg
  empacotado: framemd5 do vídeo idêntico byte a byte, durações fechadas e a
  janela pré-junção que era silêncio ganha a fala seguinte (RMS −120 → −13 dB).
- No main: `applyJcutToProject` (single-flight) localiza o corte (candidato
  clean-cut mais recente fora de remotion/public; espelha em
  edit/remotion/public/cut.mp4 se existir — o que dispara o re-render da Fase
  2 pela impressão digital), verifica duração com ffprobe antes de substituir,
  guarda backup `-sem-jcut-tmp` (o preview ignora a marca), escreve o
  jcut_timeline no edl.json e o marcador `edit/jcut.json` (arquivos + size +
  mtime). `syncJcutForProject` roda no pós-turno: se o agente re-renderizou o
  corte (stats divergem do marcador), reaplica em silêncio com o EDL atual.
- UI: botão "Aplicar J-Cut" no gate "Corte limpo pronto" (aparece junto com o
  Aprovado, sem depender do clique de aprovação) e no gate de estilos; chama
  jcut:apply direto (sem turno de agente), mostra mensagem de sistema com o
  número de transições e o aviso de que o vídeo não foi reencodado. Com
  sobreposição de voz detectada (modelo ou segments), a track Voz vira DUAS
  faixas em xadrez (Voz A/Voz B) — é o que torna a sobreposição visível.
- Gate à prova de fraseado (0.13.1, de uso real): a detecção antiga exigia
  "aprova" a ≤80 caracteres de "corte" e a frase real do Codex ("Corte limpo
  preparado com 16,3s… me diga se aprova") passava de 140 — nenhum gate
  aparecia, nem o J-Cut. Agora asksForCleanCutApproval usa âncoras de palavra
  sem limite de distância (corte + aprova/aprovar/aprove/aprovação; o
  particípio "aprovado" fica de fora para a mensagem pós-aprovação não
  recriar o gate) e, se NENHUMA mensagem casar, um gate FIXO aparece depois
  da última mensagem sempre que workspace.media.kind === 'clean-cut' sem
  aprovação registrada (aprovar ali usa id sintético pinned:…). Gate some
  quando styleApplied. .clean-cut-gate ganhou flex-wrap para caber na coluna
  do chat.
- EVIDÊNCIA DE CORTE REAL (0.13.6, de uso real nas duas plataformas): o gate
  ancorado em mensagem disparava só pelo texto — no mac apareceu sob uma
  mensagem que explicava que o corte FALHOU ("…não existe nenhum corte
  renderizado… para sua aprovação" contém corte+aprovação) e no Windows sob
  um corte INVENTADO (transcrição quebrada pelo VC++ → o agente escreveu EDL
  com o vídeo inteiro e pediu aprovação). Agora NENHUM gate (nem o de
  mensagem, nem o fixo) aparece sem `realCleanCutReady`: media.kind ===
  'clean-cut' + modelo EDL com fontes reais + `modelRemovesMaterial` (módulo
  puro, testado) provando que o corte manteve MENOS material do que as fontes
  têm (tolerância 0,5 s; fonte sem duração conhecida nunca é evidência; só a
  faixa de vídeo conta — as pistas Voz A/B do J-Cut não interferem). Caso
  legítimo raríssimo de zero remoção: o aluno aprova digitando no chat. As
  instruções ganharam a contrapartida: transcrição real obrigatória antes do
  corte, transcrição falhou → parar sem criar EDL nem pedir aprovação, e EDL
  que devolve o vídeo inteiro nunca é "corte pronto". QA:
  `?qa` (gate aparece), `?qa&semcorte` (clipes no preview → sem gate),
  `?qa&cortefake` (EDL sem remoção → sem gate), `?qa&espelho` (pasta
  multi-vídeo pré-corte → sem gate, selo "Vídeos em sequência").
- Instruções: J-CUT NÃO É TAREFA DO AGENTE — não antecipar áudio, não
  escrever jcut_timeline, não apagar edit/jcut.json nem `*-sem-jcut-tmp*`.

## 14. Windows

Infra completa e PRIMEIRA BUILD VERDE no CI em 2026-08-19 (run
32266364640 do workflow windows-build, 6 iterações): todos os stages
win32-x64, FFmpeg 7.1.5 compilado via MSYS2, WhisperX com torchcodec
carregando as DLLs, instalador Squirrel e runtime pack gerados —
artefato "edvid-windows" (~1,1 GB) anexado na rodada. Falta instalar
numa máquina Windows real e validar o ciclo completo de aluno.

PUBLICADO no R2 em 2026-08-19 (run com publish, 8ª iteração): runtime pack
`runtimes/runtimes-win32-x64-<chave>.tar.gz`, canal `win32/RELEASES`
(edvid-0.13.2-full.nupkg) e instalador `EdvidSetup.exe` estável na raiz —
o link para a página de download da Creator Factory. feed.json do mac
intacto. Secrets adicionados ao repositório com autorização do Fill.

Lições das 8 iterações (vao doer de novo se esquecidas):
- O tar do actions/cache corrompe as junctions do python-install do uv
  ("directory name is invalid", os error 267): python-install fica FORA do
  cache e o stage recria do zero (wheels seguem no uv-cache).
- gh CLI no Actions exige GH_TOKEN (attestation do uv).
- O gpg de runtime MSYS do PATH dos runners mutila caminhos com letra de
  drive; usar o gpg do MSYS2 (pacman gnupg) com caminhos /c/....
- O exe do yt-dlp NAO tem attestation no GitHub (404) — é gpg mesmo.
- Temp (C:) e workspace (D:) são drives distintos: rename dá EXDEV,
  precisa fallback de cópia.
- DLLs mingw dependem de libwinpthread-1.dll/libgcc_s_seh-1.dll:
  -static-libgcc + copiar o winpthread junto, senão o libtorchcodec não
  carrega ("or one of its dependencies").
- .runtime-cache é cacheado no CI: mudança no MODO de build precisa de
  winBuildRevision no metadata para invalidar.
- O runner do CI tem o VC++ Redistributable instalado e MASCARA a ausência
  dele nas máquinas de aluno (torch/ctranslate2 precisam de
  msvcp140/vcomp140/vcruntime140). Solução: DLLs REDIST app-local ao lado
  do python.exe, copiadas do VC143 Redist do runner no stage (0.13.4);
  o smoke exige as DLLs NO pack. Codex (rust) rodava mesmo assim — só
  exigia vcruntime, que costuma existir; o sintoma era só no Python.

Como construir (os dois caminhos rodam os MESMOS npm scripts):
- CI: workflow `windows-build` (.github/workflows/windows-build.yml),
  disparo manual. Sem "publish" só compila e anexa artefatos (instalador
  Squirrel + runtime pack) para teste; com "publish" envia runtime pack e
  release ao R2. Exige secrets EDVID_CF_ACCOUNT_ID, EDVID_CF_API_TOKEN,
  EDVID_R2_BUCKET e EDVID_UPDATE_BASE_URL (mesmos nomes do signing.env).
- Local (máquina Windows): `npm ci && npm run make` — a cadeia roda os
  stage:* na plataforma corrente; depois `npm run pack:runtimes` e, com o
  signing.env carregado no ambiente, os publish:*.

O que cada peça faz no win32-x64:
- Runtimes: node/uv/yt-dlp/codex-app-server já tinham alvo win32 pinado
  (o manifest pina o binário windows do codex por sha256). FFmpeg principal
  vem do autobuild BtbN DATADO pinado por sha256 do checksums oficial
  (scripts/fetch-ffmpeg-win.mjs; build-ffmpeg.mjs delega no win) — mesma
  configuração GPL + libx264 estático do build darwin; a tag "latest" do
  BtbN muda diariamente e os autobuilds antigos são apagados (~14 dias),
  por isso o pin é da tag datada. FFmpeg compartilhado do TorchCodec
  compila da MESMA fonte 7.1.5 verificada por GPG, via MSYS2
  (build-ffmpeg-torchcodec.mjs, ramo win32; o runner do GitHub já traz
  MSYS2 em C:\msys64 — pacman instala mingw-w64-x86_64-toolchain) e as
  DLLs (avcodec-61.dll…) vão para o LADO do python.exe, primeiro lugar da
  busca de DLLs, sem depender de PATH.
- Python + WhisperX: stage na própria plataforma (por design); os ajustes
  win são o filtro .dll, a LICENSE.txt na raiz do cpython e o alias
  python3.exe — as instruções dos agentes usam "python3" nos três
  provedores e o alias mantém o contrato idêntico. As instruções também
  avisam que no PowerShell a pasta de helpers é $env:EDVID_HELPERS.
- Instalador/atualização: MakerSquirrel já configurado (ícone .ico ok);
  electron-squirrel-startup trata os eventos de instalação. O autoUpdater
  no win aponta para `<base>/win32` (Squirrel.Windows lê RELEASES da
  pasta); publish-update.mjs detecta a plataforma do make: no win sobe
  nupkg → RELEASES sob win32/ e o instalador como
  win32/Edvid-Setup-<v>.exe + EdvidSetup.exe ESTÁVEL na raiz (link de
  download da Creator Factory). O feed.json do mac fica intacto. No mac o
  mesmo script também publica o DMG: Edvid-<v>-arm64.dmg (arquivado) +
  Edvid.dmg ESTÁVEL na raiz — o par macOS do EdvidSetup.exe. Links de
  download da página: <base>/Edvid.dmg e <base>/EdvidSetup.exe.
- runtime.ts sempre foi parametrizado (.exe, npm-cli.js, python.exe);
  spawns usam binários absolutos ou `node script.js` (sem npx/.cmd);
  PATH usa path.delimiter; a extração do pack usa bsdtar (Windows 10+).

Smoke contínuo: o workflow windows-smoke baixa o runtime pack PUBLICADO
do R2 num runner limpo e roda os comandos do agente (ferramentas, imports
do WhisperX, prefetch do modelo e transcrição real pela CLI) — é o
replicador do ambiente do aluno; rodar sempre que houver suspeita de
pacote quebrado no Windows. Verde em 2026-08-19.

Validação pendente na primeira rodada real (nesta ordem):
1. Workflow sem publish → instalar o Setup.exe numa máquina/VM Windows.
2. Boot: download do runtime pack win32 + extração + checkRuntimes verde.
3. Corte limpo de ponta a ponta (WhisperX + torchcodec com as DLLs 7.1).
4. Fase 2 (npm install do Remotion + render com chrome-headless win).
5. Sandbox do Codex no Windows: conferir se o app-server aceita
   workspace-write ou se os comandos passam a pedir aprovação — se pedir,
   decidir o ajuste de fricção.
6. Atualização OTA: instalar versão N, publicar N+1, conferir o ciclo.

Dependências do Fill:
- Adicionar os 4 secrets no repositório (gh secret set …).
- Assinatura Windows (Azure Trusted Signing): o CI já está PRONTO e
  gateado — com os secrets presentes, o passo "Preparar assinatura" baixa
  o dlib (Microsoft.Trusted.Signing.Client via nuget), acha o signtool do
  SDK, escreve o metadata.json e exporta EDVID_WIN_SIGNTOOL +
  EDVID_WIN_SIGN_PARAMS; o forge.config aplica windowsSign no packager
  (Edvid.exe) e no MakerSquirrel (Update.exe/Setup.exe via
  electron-winstaller 5.4+). Sem secrets, build sem assinatura como
  antes. Falta o lado Azure do Fill: assinatura ativa → recurso "Trusted
  Signing Account" (Basic ~US$9,99/mês) → Identity Validation (aguardar
  aprovação) → Certificate Profile (Public Trust) → App registration com
  client secret + papel "Trusted Signing Certificate Profile Signer" no
  recurso → secrets AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/
  EDVID_ATS_ENDPOINT (ex.: https://eus.codesigning.azure.net)/
  EDVID_ATS_ACCOUNT/EDVID_ATS_PROFILE no repositório. Primeira build
  assinada valida o arranjo (signtool antigo do Squirrel NÃO é usado —
  windowsSign substitui).
- Não assumir que o pacote macOS prova compatibilidade Windows.

## 15. Histórico recente de versões

- `1af43d5`: workspace integrado com chat, preview e timeline.
- `66bc25b`: início automático do corte e refinamento da reprodução.
- `ba0da1f`: aprovação visual e correções por In/Out.
- `e9cd07d`: timeline, atalhos, branding e release 0.5.0.
- `c931ee0`: DMG centralizado e release 0.5.1.
- `cc00bc5`: aprovações técnicas fora do chat e release 0.5.2.
- `626642b`: cortes visíveis, agulha interativa, frame stepping, EDL obrigatório,
  runtimes internos no PATH e release 0.5.3.
- 0.6.0: primeira versão da timeline não destrutiva — modelo persistente de
  clipes migrado do EDL, seleção, trim, razor, ripple delete, undo/redo, zoom
  ancorado e prévia mapeada sem render.
- (sem release) infra Windows completa, 2026-08-19: FFmpeg principal win32
  via autobuild BtbN datado pinado por sha256 (fetch-ffmpeg-win.mjs; GPL +
  libx264 como no darwin) e FFmpeg compartilhado do TorchCodec compilado
  da mesma fonte 7.1.5 GPG-verificada via MSYS2 (ramo win32 do
  build-ffmpeg-torchcodec); stage-python-whisperx com DLLs ao lado do
  python.exe, LICENSE.txt na raiz e alias python3.exe; autoUpdater
  Squirrel.Windows apontando para <base>/win32; publish-update com fluxo
  win (nupkg → RELEASES → Setup versionado + EdvidSetup.exe estável);
  workflow windows-build (dispatch manual, publish opcional por secrets);
  prepare:forge-makers ciente de plataforma. Detalhe que motivou os pins:
  o BtbN apaga autobuilds antigos (~14 dias) e a tag latest muda todo dia
  — só a tag datada é imutável; e o n7.1 já saiu de linha por lá, por
  isso o compartilhado compila da fonte. Validação real pendente (seção
  14).
- 0.14.7: whoosh -60% e o render que começava sozinho. (1) O SFX de entrada
  das animações chamava mais atenção que a animação: virou a constante
  `WHOOSH_VOLUME` (0,036, era 0,09 e 0,1 em alguns pontos) usada por TODOS os
  whooshes; pop e clique do corte ficaram como estavam. (2) Abrir o Edvid ou
  trocar de projeto disparava um render inteiro do nada — `activateWorkspace`
  chama `requestPhase2Render` de propósito (cobre dados que ficaram prontos
  com o app fechado), e a impressão digital DEVERIA evitar o trabalho. Só que
  ela era `tamanho:mtime` e o app reescreve arquivos por conta própria: o
  scaffold reaplica o CustomGraphics.tsx DEPOIS do fingerprint ser calculado,
  então a digital gravada no carimbo já nascia velha e nunca batia. Agora a
  digital é o SHA do CONTEÚDO (só o cut.mp4, de centenas de MB, segue por
  tamanho+data): reescrever igual é invisível, mudança real ainda dispara.
  `npm run test:fingerprint` cobre os dois lados. Mesma família de defeito da
  0.14.6 — o app mexendo em arquivo do agente sem se dar conta.
- 0.14.6: A CAUSA RAIZ das animações que nunca apareciam — e não era o
  agente. O `scaffoldRemotionProject` roda ANTES de cada render ("reaplica o
  template para que correções em src/ cheguem aos projetos montados") e
  copiava `src/` inteiro com `force: true`. Junto ia o CustomGraphics.tsx, que
  o cabeçalho do próprio template chama de "The ONE editable file" — o único
  arquivo que o agente escreve. Ciclo do desastre: o agente escrevia a
  animação, o app restaurava o template segundos depois, o render saía sem
  ela e o arquivo terminava idêntico ao template, o que fazia parecer que o
  agente não tinha feito nada. Foi o que me levou a diagnosticar errado três
  vezes seguidas (0.14.2/0.14.4/0.14.5 trataram sintomas: registro sem tipo,
  preset no lugar do visual, promessa sem código). `public/` já tinha a
  proteção `force: false` com comentário "nunca sobrescrever o que já existe";
  `src/` não tinha. Correção: carimbo `.edvid-scaffold.json` com o sha do
  TEMPLATE aplicado — se o arquivo do projeto ainda bate com ele, ninguém
  editou e o template novo entra; se difere, é trabalho do agente e fica de
  pé (o carimbo não é atualizado, então segue preservado nos próximos
  renders). `customGraphicsUntouched` passou a usar o mesmo carimbo.
  `npm run test:scaffold` reproduz o defeito antigo (arquivo volta ao
  template), prova a correção sobrevivendo a três renders seguidos e garante
  que projeto intocado ainda recebe atualização. Prova visual: componente sob
  medida (grid escuro + #ff5200 em tela cheia) escrito, passado pelo scaffold
  e RENDERIZADO no frame 225 do projeto real.
  LIÇÃO GRANDE: quando o agente jura que fez e o arquivo diz que não, suspeite
  do APP antes do agente — havia um processo do próprio Edvid apagando o
  trabalho dele. E toda pasta que o agente escreve precisa de política
  explícita de sobrescrita, como `public/` já tinha.
- 0.14.5: o agente aprendeu a MARCAR e não a ESCREVER. No projeto real ele
  registrou `{"kind": "custom", "label": "Infográfico em tela cheia…"}` e
  deixou o CustomGraphics.tsx byte a byte igual ao template — "custom" diz ao
  template "o desenho vem do código", o código não existia, e a animação saiu
  muda de novo (terceira variação do mesmo defeito: 1ª registrar sem desenhar,
  2ª escolher preset em vez do visual pedido, 3ª prometer código e não
  escrever). O app parou de confiar na promessa: `pendingCustomAnimations`
  detecta "custom" + arquivo intacto e, ANTES de gastar um render, dispara uma
  continuação automática cobrando o componente com o rótulo que o próprio
  agente escreveu — mesmo mecanismo já usado quando as imagens ficam prontas.
  A cobrança é uma por projeto (`customAnimationChasedRef`), para não virar
  pingue-pongue, e se ainda assim o código não vier, `normalizeAnimations`
  passa a tratar "custom" órfão como registro sem tipo e desenha um efeito
  padrão — melhor pobre que invisível. LIÇÃO: quando um campo declara trabalho
  que vive em OUTRO arquivo, o app precisa verificar o outro arquivo; promessa
  declarativa não é entrega.
- 0.14.4: os kinds prontos viraram uma armadilha — defeito que a 0.14.2
  introduziu. O aluno descreveu um visual ("animação em tela cheia, grid
  escuro, glassmorphism, destaque #ff5200, fontes tais") e o agente, em vez de
  escrever o componente, escolheu o preset "script": saiu o cartão "ROTEIRO"
  padrão. Pior, a rede de segurança do app injetava kind em QUALQUER registro
  sem tipo — inclusive quando o desenho vinha de código sob medida no
  CustomGraphics.tsx, e aí o cartão genérico apareceria POR CIMA da animação
  do agente. Duas correções: (1) `normalizeAnimations` só age quando o
  CustomGraphics.tsx do projeto é IDÊNTICO ao do template — arquivo tocado
  significa autor humano/agente no comando, e o registro é respeitado como
  está; (2) o template passou a aceitar `kind: "custom"`, que declara "o
  desenho vem do código" sem desenhar nada por cima. As instruções ficaram
  explícitas: pedido com estilo próprio (cor, fonte, tela cheia, layout
  descrito) EXIGE código sob medida + `kind: "custom"`; os prontos são para
  pedido genérico e para o flash, e na dúvida escreve-se o código. LIÇÃO:
  facilitar o caminho fácil (presets) desloca o agente para ele — a rede de
  segurança precisa saber distinguir "esqueceu" de "fez à mão".
- 0.14.3: sandbox por PLATAFORMA, consertando um efeito colateral que eu mesmo
  criei. Com `approval_policy = never` (0.14.1) o Windows parou de perguntar —
  e passou a NEGAR: a sessão inteira virou somente leitura ("esta sessão está
  somente para leitura"), derrubando a Fase 2 e a geração de imagens junto.
  A razão é a mesma de sempre: o backend de lá não consegue impor
  `workspace-write`, então o Codex escolhe entre perguntar (on-request, a
  enxurrada de antes) ou negar (never). Como a restrição no Windows nunca foi
  real, ficar entre as duas só custava: lá o sandbox passa a ser
  `danger-full-access`, e no macOS continua `workspace-write`, onde o seatbelt
  impõe de verdade e a sonda já mediu zero aprovações. LIÇÃO: `never` não é
  "aprovar sozinho", é "não perguntar" — em sandbox que não impõe, isso vira
  negação, não permissão. Mudança validada por typecheck e pelo smoke do
  protocolo; o comportamento no Windows depende do teste real do fill, porque
  não há máquina Windows aqui e a sonda local foi barrada pelo ambiente.
- 0.14.2: rede de segurança das animações + imagem certa para tela dividida.
  (1) A 0.14.1 tornou `animations` declarativo, mas o desenho ainda dependia do
  agente escrever `kind` — e ele aprendeu PELA METADE: no teste seguinte pôs
  `kind: "flash"` nos três flashes e esqueceu no "Infográfico tela cheia", que
  saiu mudo de novo. A regra saiu do agente: antes de cada render o app roda
  `normalizeAnimations` sobre o edit-data.json e resolve o tipo de quem não
  tem — infere pelo rótulo (flash/estouro → flash, linha do tempo/etapas →
  timeline, formas → shapes, roteiro/tópico/infográfico → script) e, sem pista
  alguma, usa o cartão de texto com o próprio rótulo. Uma animação registrada
  NUNCA mais fica invisível. A normalização roda ANTES do fingerprint, senão a
  correção só entraria no render seguinte. Provado renderizando o frame 380 do
  projeto real que estava mudo: o cartão aparece. `npm run test:animations`
  trava a inferência com os rótulos reais que o agente usou.
  (2) Imagens de TELA DIVIDIDA em 4:3: cada metade de um 9:16 é uma faixa
  larga (1080x960) e a IA vinha gerando 9:16, que entrava cortadíssima. A
  proporção entrou no serviço (`4:3` → 1536x1024, o vizinho mais próximo que a
  API oferece) e virou padrão nas instruções e no briefing de estilos.
  (3) ENOENT no Windows continuou aparecendo: o prompt do turno de imagem
  passou a mandar o caminho ABSOLUTO (com OneDrive e acento em "Área de
  Trabalho" o relativo se perdia) e, se ainda assim o arquivo não estiver no
  lugar, o app procura pelo nome dentro do projeto e traz para `edit/imagens`
  em vez de perder uma imagem já paga na cota do aluno.
- 0.14.1: teste real completo no mac (corte + estilos + imagens + Fase 2) e
  no Windows. Tres defeitos, todos com prova. (1) ANIMACOES REGISTRADAS SEM
  NADA NO VIDEO: `animations` era so metadata para a timeline — o comentario do
  proprio template dizia "o template nao renderiza nada daqui". No projeto real
  o agente registrou 3 flashes + 1 infografico, deixou `transitions: null` (o
  campo que o CutFlashes le, nunca documentado nas instrucoes) e o
  CustomGraphics.tsx ficou IDENTICO ao template — nenhuma linha de codigo. O
  campo virou DECLARATIVO: `kind` (flash | timeline | script | shapes) escolhe
  o desenho e o CustomGraphics renderiza; os tres graficos que ja existiam no
  template e nunca eram montados por dados agora tem uso. Registro antigo sem
  `kind` cujo label fala em flash ainda vira flash, entao projetos ja criados
  passam a renderizar sem o agente reescrever nada. Provado renderizando
  frames do projeto real: flash visivel no frame 124, cartao do infografico no
  340. (Os prontos viraram armadilha logo depois — ver 0.14.4.) (2) APROVACOES NO WINDOWS: `approval_policy` passou a `never` (thread e
  config.toml). A causa: o sandbox do Windows nao consegue impor restricao de
  arquivo ("windows sandbox backend cannot enforce file_system", string do
  binario) e o Codex escalava tudo; no mac, onde o seatbelt funciona, a sonda
  mostrou zero aprovacoes ja com on-request. O sandbox workspace-write continua
  declarado e a rede segue negada — muda so quem responde, nao o limite.
  (3) IMAGENS NAO GERADAS NO WINDOWS (ENOENT): consequencia da mesma causa — a
  thread utilitaria de imagem RECUSA aprovacoes por design, entao cada pedido
  do sandbox matava a geracao em silencio. Alem do `never`, o app passou a
  criar `edit/imagens` fora do sandbox antes do turno.
- 0.14.0: os dois defeitos do teste real depois da 0.13.9. (1) mac: "o
  WhisperX não está disponível no ambiente" mesmo com o modelo baixado e o
  healthcheck do app passando — o `path_helper` do macOS jogava o pack para
  o fim do PATH do agente (sondado com `command/exec`; detalhes na seção 4).
  Corrigido com instruções por caminho absoluto `$EDVID_*` + `sitecustomize`
  que restaura a ordem do PATH dentro do Python (o `load_audio` chama
  `ffmpeg` por nome). (2) Windows: transcrevia e cortava, mas o corte era
  grosseiro — a escolha dos trechos saiu do LLM e virou `clean_cut.py`,
  guiado pelo silêncio real do áudio, com `npm run test:clean-cut`. Lição
  transversal: quando o agente relata "ferramenta indisponível", desconfie do
  AMBIENTE dele antes do pacote — o app e o agente não veem o mesmo PATH.
- 0.13.9: o download da 0.13.8 era 3x maior que o necessário — descoberto
  com o fill esperando na frente do app ("Preparando a transcrição · 562 MB.
  preciso aguardar?"). O repo de alinhamento tem 3,5 GB, mas o whisperx
  carrega só o `pytorch_model.bin` (1,2 GB) via `Wav2Vec2Processor` +
  `Wav2Vec2ForCTC` (lido no alignment.py): `flax_model.msgpack` (1,2 GB) e
  `language_model/` (1,1 GB, só o `Wav2Vec2ProcessorWithLM` usaria) eram
  peso morto. Prova antes de embarcar: cache limpo + download filtrado +
  transcrição offline alinhada (1,2 GB, 12 palavras com tempo). Junto veio
  o critério de pronto por ARQUIVO (`cachedWeightSize`) — medir diretório
  daria por pronto o cache de quem interrompeu a 0.13.8 no meio, com blobs
  `.incomplete` somando mais de 1 GB e sem os pesos. Smoke win32 passou a
  usar os mesmos filtros e a exigir que o flax NÃO esteja no cache.
- 0.13.8: transcrição offline COMPLETA e diagnóstico do WhisperX no banner,
  pelos dois prints do teste real pós-0.13.7. (1) Windows: "o modelo de
  alinhamento em português não está disponível no cache local" — o prefetch
  baixava só o Systran/faster-whisper-small e o ambiente do agente é offline
  de propósito; o whisperx resolve pt → jonatasgrosman/
  wav2vec2-large-xlsr-53-portuguese (DEFAULT_ALIGN_MODELS_HF) e esse repo
  nunca entrou no cache. ensureWhisperModel agora baixa OS DOIS (critério de
  pronto: small >100 MB E alinhamento >1 GB — máquinas antigas com só o
  small voltam a baixar), o ticker soma os dois diretórios e as instruções
  mandam transcrever SEMPRE com --language pt (outros idiomas: avisar e
  --no_align). LIÇÃO DE SMOKE: o smoke antigo rodava com --no_align e sem
  HF_HUB_OFFLINE — ficou verde enquanto o aluno morria no alinhamento; um
  smoke que pula a etapa que quebra não é smoke. Agora ele sintetiza fala
  de verdade (SAPI no Windows), transcreve COM alinhamento, offline, e
  exige tempos de palavra no JSON. (2) Mac: "o WhisperX não está disponível
  no ambiente" sem causa visível — ensureWhisperModel ganhou healthcheck:
  `python -B -m whisperx --help` uma vez por chave de pack (marcador em
  cache/whisperx-ok-<chave>.json; ~10 s de imports quando roda); falha vira
  erro EXATO no banner ("o WhisperX não abre neste computador (última linha
  do stderr)") com o Tentar de novo. Réplica local com o pack darwin
  PUBLICADO no R2 (mesmo tar.gz que o aluno baixa) validou o ciclo:
  whisperx abre, prefetch duplo, say -v Luciana → transcrição offline
  alinhada com tempos de palavra.
- 0.13.7: hotfix da 0.13.6, minutos depois, por erro em produção: "thread/
  start.allowProviderModelFallback requires experimentalApi capability" — o
  campo é gated e derrubava TODO envio de mensagem no ChatGPT. Removido dos
  dois thread/start (o pin fica só em `model` + config.toml; modelo
  aposentado no futuro vira mensagem PT-BR do friendlyAiError). LIÇÃO DE
  SONDA: a sonda da 0.13.6 passou `allowProviderModelFallback: false` e o
  aplicativo embarcou `true` — o gate só dispara com true, então a sonda não
  validou o payload embarcado. Sonda tem de enviar o formato EXATO que vai
  para produção. A re-sonda com o formato do hotfix fechou também a prova
  que faltava: turno real COMPLETO com `gpt-5.6-terra` em conta ChatGPT
  (o limite de uso da conta tinha liberado).
- 0.13.6: três defeitos de uso real (mac do aluno + Windows do fill). (1)
  Modelo do ChatGPT fixado em `gpt-5.6-terra`: o codex-app-server 0.147.0
  passou a ter `gpt-5.6-sol` como default e conta ChatGPT recebe 400 ("not
  supported when using Codex with a ChatGPT account") — pin em dois níveis
  (config.toml de topo + `model`/`allowProviderModelFallback` no
  thread/start), comprovado por sonda nos rollouts; erro de modelo agora
  vira mensagem PT-BR (friendlyAiError) e a notificação `error` duplicada
  com turno ativo foi silenciada. (2) Corte fantasma: gates de aprovação
  (mensagem + fixo) agora exigem evidência de corte real
  (`modelRemovesMaterial`) — o texto do agente sozinho não abre mais
  Aprovado/J-Cut; instruções proíbem corte sem transcrição e EDL de vídeo
  inteiro. (3) Pasta com vários vídeos: timeline espelha todos em sequência
  (ordem natural de nomes), preview mapeado toca um após o outro, selo
  "Vídeos em sequência", instruções mandam limpar todos e concatenar.
- 0.13.5: login do Claude resiliente ao rate limit da Anthropic. Em uso
  real a troca do código chegou a falhar com "Rate limited" — o endpoint
  de token limita por IP com facilidade (poucas tentativas bastam). O
  callback agora responde NA HORA uma página neutra ("Quase lá — volte ao
  Edvid") e a troca segue no aplicativo com novas tentativas (3s/8s/20s/
  45s para 429/5xx/sem-rede; o código vale ~10min), estado "finishing"
  no modal ("Concluindo o login…") e mensagem final em PT-BR acionável
  quando esgota. Refresh usa retries curtos (2s/5s) para não travar
  turnos. Porta de callback ganhou env EDVID_OAUTH_CALLBACK_PORT para as
  sondas não disputarem a 54545 com um Edvid aberto (lição: a sonda
  falhou porque o PRÓPRIO app em produção segurava a porta). Sonda com
  33 verificações, incluindo 429→retry→conectado.
- 0.13.4: segunda rodada do teste real no Windows, agora com causa exata
  graças ao banner novo: "falta o Microsoft Visual C++ Redistributable".
  Em vez de forçar um instalador com UAC na instalação, o runtime VC143
  (CRT + OpenMP) virou APP-LOCAL: o stage win copia as DLLs REDIST para o
  lado do python.exe e registra versões/sha no metadata; o manifest ganhou
  winMsvcRuntime (muda a chave do pack — os DOIS packs são republicados e
  o aplicativo 0.13.4 busca a chave nova); o smoke passou a exigir as
  DLLs dentro do pack. Sem passo extra para o aluno e sem prompt de
  administrador.
- 0.13.3: primeiro teste real no Windows ("mecanismo local de transcrição
  não abriu"). O smoke novo (workflow windows-smoke: baixa o runtime pack
  PUBLICADO do R2, extrai como o app e roda os mesmos comandos do agente,
  incluindo prefetch do modelo e transcrição real pela CLI) provou o
  pacote 100% funcional — até transcreveu "E aí" de um seno (alucinação
  clássica = pipeline inteiro rodou). Ou seja: a falha do aluno é estado
  local, e o suspeito é o prefetch do modelo, cuja falha era INVISÍVEL
  com o chat preenchido (o banner só existia no estado vazio). Correções:
  banner de "Preparando a transcrição"/erro agora persiste no chat com
  mensagens e ganhou "Tentar de novo" (re-dispara ensureWhisperModel);
  e o gate fixo "Corte limpo pronto" passou a exigir corte respaldado
  por EDL (clipes com sourceId real) — ele tinha aparecido logo abaixo
  da mensagem de FALHA do corte. QA: ?modelo=erro|baixando e ?semcorte.
- 0.13.2: refinamentos pedidos em uso real. Sucesso do J-Cut deixou de gerar
  mensagem de sistema no chat: o próprio botão fica VERDE (#4fd08b,
  .jcut-applied) com "J-Cut aplicado" — falha continua avisando por
  mensagem. Botões de desfazer/refazer (ícones novos undo/redo) na barra do
  topo da timeline, com estado habilitado lido dos refs de histórico;
  "Descartar"/"Aplicar ajustes" (ex-"Aplicar edições") migraram da barra de
  transporte para essa mesma barra. QA: ciclo completo navalha → desfazer →
  refazer → ⌘Z validado (o modificador ⌘ não atravessa o painel de
  automação; validar com KeyboardEvent real no body — dispatch no window
  quebra no closest() do guard de inputs).
- 0.13.1: o gate de aprovação (e com ele o J-Cut) não aparecia em uso real —
  a frase do agente variou e a regex exigia proximidade de 80 caracteres.
  Detecção reescrita por âncoras de palavra sem limite de distância + gate
  fixo de reserva quando o preview é um corte limpo sem aprovação (o botão
  deixou de depender do fraseado do agente). Validado com a frase exata do
  print do usuário e QA do fluxo completo no navegador.
- 0.13.0: J-Cut determinístico + tela dividida com imagens por padrão, os
  dois nascidos de uso real. (1) O botão "Aplicar J-Cut" não aparecia (só
  nascia no clique de Aprovado) e a aplicação via agente saiu do ar de
  sincronia. Agora o botão vive no próprio gate "Corte limpo pronto" e a
  aplicação é do app: só o áudio é remontado (150 ms de antecipação com
  clamps + crossfade), o vídeo segue byte a byte idêntico (provado com
  framemd5 no test:jcut), edit/jcut.json marca o estado e o pós-turno
  reaplica quando o agente re-renderiza o corte. Voz vira duas faixas em
  xadrez (Voz A/Voz B) para a sobreposição ser visível. (2) Ao escolher
  tela dividida o agente duplicava o próprio vídeo nas metades; o briefing
  agora manda gerar imagens com IA ilustrando a fala por padrão, com a
  Observação podendo apontar outra fonte.
- 0.12.3: dois consertos de uso real. (1) Login do Claude não conectava
  mesmo com o site dizendo sucesso: os endpoints OAuth da 0.9.0 eram os
  legados (claude.ai + console.anthropic.com); os atuais foram extraídos
  das strings do binário do CLI 2.1.235 (claude.com/cai +
  platform.claude.com) e migrados. A página local agora só diz "Login
  concluído" depois da troca real do token, a porta 54545 é liberada com
  closeAllConnections (keep-alive prendia a porta na tentativa seguinte),
  o refresh só desloga em 400/401 (429/5xx/sem rede mantêm os tokens) e
  userData/claude-login.log grava as etapas sem segredos. Sonda com
  servidor de token falso cobre o fluxo de ponta a ponta (24
  verificações). (2) Limite de uso falava inglês: com outra IA conectada
  o chat troca sozinho e avisa; sem alternativa mostra "Você chegou ao
  limite de uso da IA. Tente novamente mais tarde ou conecte outra IA."
- 0.12.2: timeline imune a improviso de schema. Mesmo com o campo oficial
  animations existindo, um agente registrou a animação num campo INVENTADO
  (creatorInfographics) e a track sumiu de novo — instrução não garante
  disciplina. inspectProjectOverlays agora COLHE qualquer lista
  desconhecida no topo do edit-data cujos itens tenham start+end (ou
  start+dur) e desenha como chip de Animações (label de label/title/src ou
  o nome do campo); campos aninhados (captions.windows) não são tocados.
  Instruções passaram a proibir campos inventados explicitamente, com a
  lista dos oficiais.
- 0.12.1: animação sob medida invisível, causa dupla achada em uso real. O
  agente criou um infográfico no CustomGraphics.tsx e (1) o render nunca
  disparou — a impressão digital da Fase 2 só olhava public/, e o ÚNICO
  arquivo-fonte que o agente edita ficava de fora (agora
  src/CustomGraphics.tsx entra no fingerprint); (2) a timeline não tinha
  como desenhar código — nasce o campo edit-data.animations
  [{start,end,label}] como REGISTRO obrigatório (instruções mandam
  registrar no mesmo turno), alimentando a track Animações.
- 0.12.0: tela dividida oficial + tracks reais. O split vira DADO
  (EditData.splits {kind image|video, src, start, end, position, bandTop}):
  o Main.tsx monta a divisão sozinho (mídia numa metade, faixa bandTop do
  vídeo na outra, fade + whoosh) e o agente fica PROIBIDO de montar split
  no CustomGraphics. A legenda se centra sozinha na divisa em TODOS os
  estilos (karaokê/simples via captionPaddingBottomAt exportado do Main;
  empilhada zera o stackedOffsetY; dispersa força OFFSET_Y 0.5) — provado
  com stills renderizados no template real (karaokê e empilhada, dentro e
  fora do split; cuidado: still no frame EXATO do início de linha pega
  opacidade 0 do fade e parece sumida). Na timeline, a track Assets FALSA
  (chips fixos) morreu: ProjectWorkspace.overlays parseia o edit-data.json
  (splits/inserts/behind/hook) e alimenta tracks reais na ordem Legendas,
  Texto (largura real do hook), Animações, Imagem e Vídeo (verde novo
  #4fd08b/.green), acima das bases Vídeo/Voz/Trilha.
- 0.11.1: continuação automática das imagens. Em uso real o ciclo não
  fechava: o agente pedia a imagem e encerrava o turno, o app gerava, e a
  aplicação só viria se o aluno mandasse outra mensagem. Agora o Edvid
  despacha sozinho o turno de continuação quando a geração termina, e as
  instruções mandam o agente aplicar nesse turno sem esperar novo pedido.
- 0.11.0: papéis de IA e imagens. Papel "chat" e papel "imagem" com regras
  automáticas (ChatGPT > Gemini para imagem; Claude só chat), pins de
  escolha manual, seletores rápidos sob o composer e chips por papel nas
  Conexões. Geração de imagens pelo app fora do sandbox via
  edit/imagens/pedidos.json com TRÊS backends: ChatGPT-assinatura pela
  skill imagegen do Codex (thread utilitária invisível, sondada com login
  real), ChatGPT-chave pela API de imagens da OpenAI (gpt-image-2, pago
  por imagem) e Gemini pelo Nano Banana (REST). Fallback de limite de
  uso: turno falhou por cota + outro chat conectado = troca automática
  com aviso, sem reenvio.
- 0.10.0: três provedores + chaves de API. Adaptador Gemini sobre o modo ACP
  do CLI oficial (processo longo, sessões por projeto, autoEdit + aprovações
  pela interface, instruções no primeiro turno); chave de API como segundo
  modo no ChatGPT (login apiKey nativo do app-server, validado antes pelo
  main) e no Claude (ANTHROPIC_API_KEY no lugar do token OAuth). Onboarding
  com três logos e "ou usar chave de API"; aba Conexões consolidada com os
  três provedores, badge Em uso, troca e campos de chave; troca automática
  generalizada. Contexto de negócio: o free tier generoso do Gemini CLI
  (login Google) foi desligado pelo Google em 18/06/2026 — chave de API é o
  único caminho são para Gemini hoje.
- 0.9.0: provedor de IA duplo. Adaptador Claude (Agent SDK) falando o mesmo
  vocabulário de eventos do Codex pelo mesmo canal; login OAuth PKCE com a
  conta Claude do aluno (callback 54545 + fallback de colar código); runtime
  do SDK pinado instalado sob demanda; sandbox nativo espelhando o modelo do
  Codex (sem rede, caches graváveis, escapar = aprovação). Onboarding de
  conexão de IA após o login do aluno (logos ChatGPT/Claude), conexões e
  troca de provedor em Configurações → Geral, troca automática quando só um
  está conectado. Correção de brinde: `.account-action` nascia com opacity 0
  fora da rail e os botões Entrar/Sair das Configurações ficavam invisíveis.
- 0.8.7: cards da aba Estilos com altura guiada pelo conteúdo (o
  `.choice-visual` fixo em 72px decapitava os diagramas 9:14 e cortava as
  thumbs); clipes animados re-recortados na MESMA janela dos stills.
- 0.8.6: aba Estilos refinada — topo com um único título, sem numeração de
  seções, cards de tipo de edição verticais sem texto, seletor de cor com
  cantos arredondados, rodapé sem o bloco informativo. Thumbnails
  reenquadradas por POSIÇÃO MEDIDA por estilo (TEXT_CENTER_Y no script; o
  cropdetect degenera com o gradiente) com janela 760×394 — texto ~50%
  maior; legendas animadas (karaokê, empilhada, dispersa) viram clipes
  h264 em loop de 6-29 KB (frames 27-165, altura PAR — o libx264 recusa
  ímpar). EDVID_THUMBS_REUSE=1 reaproveita renders e itera só recortes.
  Mudou o layout do template? Re-medir com a montagem hstack+drawgrid
  (célula de 32px = 192px do quadro).
- 0.8.5: as thumbnails de headline (4) e legenda (6) da aba Estilos são
  stills renderizados pelo próprio template do Remotion
  (scripts/render-style-thumbs.mjs: backdrop sintético por FFmpeg, legendas
  pelos helpers oficiais, accent padrão #ff5200, recortes por estilo em
  src/brand/thumbs/*.png). Mudou o template? Rodar o script de novo. O
  FFmpeg empacotado não tem encoder webp — saída em PNG. Sem loading=lazy
  nos cards: dentro do scroll da aba as imagens nunca disparavam. Os cards
  de tipo de edição continuam diagramas CSS (são layout, não tipografia).
- 0.8.4: refino de UI — pacote de ferramentas em modal central com fundo
  desfocado; topbar "Projeto" + subcard (caminho, abrir no Finder,
  proporção/resolução) sem "Trocar pasta"; chat compacto com envio embutido
  no campo (sem gabarito de atalhos); abas só ícone+palavra; zoom/Fit na
  barra de transporte; toolbar da timeline só com o tempo; sidebar quadrada
  com ícones menores, menu ⋯ (fixar/renomear/excluir da lista — a pasta
  nunca é apagada), nome definido ao criar projeto (projects.json preserva
  nome e fixado); rodapé só com o aluno + engrenagem → Configurações
  (Geral: aluno, ChatGPT, dependências · Conexões: placeholder de APIs/MCPs).
- 0.8.3: runtimes sob demanda — o instalador não embarca mais as
  ferramentas; o app baixa o runtime pack (591 MB comprimido, chave por hash
  do manifest, sha256 verificado) no primeiro boot para
  userData/runtime/tools. Updates OTA caem de ~855 MB para ~100 MB.
- 0.8.1/0.8.2: primeiras builds com assinatura de produção, Hardened
  Runtime e notarização (aceitas de primeira pela Apple); OTA comprovado de
  ponta a ponta com o par de versões — download em segundo plano, botão no
  topo e troca automática. Publicador R2 via S3 multipart. Botão de update
  também no gate de login (pós-0.8.2).
- 0.8.0: gate de login dos alunos — mesma conta da Creator Factory
  (Supabase Auth com anon key), matrícula ativa do IA Edit Pro via RLS
  existente, refresh token em userData, tolerância offline de 7 dias, telas
  de login/sem-matrícula e conta do aluno na rail. Inerte até preencher a
  URL e a anon key do projeto (seção 13c).
- 0.7.9: OTA estilo ChatGPT implementado (autoUpdater Squirrel.Mac + feed
  JSON estático + botão "Atualizar · Reiniciar" no topo) e pipeline de
  assinatura de produção/notarização env-driven no Forge com
  entitlements.mac.plist. Inerte até plugar certificado, credenciais e a URL
  do feed (seção 13b). Login de alunos: aguardando detalhes da plataforma
  própria da Creator Factory para desenhar a integração.
- 0.7.8: o trim por arrasto voltou — a regra `.timeline-clip > span` criada
  para o rótulo sobre as ondas tinha especificidade maior que `.clip-handle`
  e roubava position/z-index das alças (lição: estilos de rótulo em classe
  própria, `.clip-label`, nunca em seletor genérico de elemento; verificado
  com arrasto de ponteiro real, 142→50 px). O histórico do chat, o gate de
  aprovação e o estado do J-Cut persistem por projeto em localStorage
  (últimas 200 mensagens; fechar e reabrir não reoferece o início do
  processo; logout não apaga — a conversa pertence ao projeto). Novo botão
  opcional "Aplicar J-Cut" no chat após a aprovação do corte: antecipa o
  áudio da cena seguinte (60–200 ms) via agente, atualizando o
  jcut_timeline; o usuário pode ignorá-lo e ir direto aos estilos.
- 0.7.7: refinamentos de UI/UX — mensagens disparadas pela interface mostram
  no chat só a intenção ("Aplicar os estilos escolhidos na edição"), com o
  briefing técnico indo apenas ao agente (dispatchMessage já aceitava
  displayText); o dot Trabalhando/Pronto e a barra de progresso do render
  vivem abaixo da última mensagem do chat; a timeline ganhou botão Fit e
  zoom fracionário por pinça do trackpad (wheel com ctrlKey, listener nativo
  passive: false, âncora no cursor); a faixa de voz desenha ondas sonoras
  (picos por fonte via FFmpeg s16le 8 kHz → 25 baldes/s, cache em
  userData/cache/waveforms por caminho+mtime, IPC waveform:get pela URL
  edvid-media já autorizada); chip da faixa de legendas mostra só
  "Legendas"; ícone da headline é um T de texto.
- 0.7.6: a Fase 2 é renderizada pelo aplicativo, fora do sandbox — o
  Chromium não inicia no seatbelt e cada `remotion render` do agente pedia
  aprovação (seis numa edição), além de fatiar o vídeo em partes. O
  document.fonts.ready travava numa aba e derrubava renders completos aos
  ~75%: fontes agora são data URIs embutidos, carregadas face a face, com
  backstop. O cache do webpack é apagado a cada render (serviu módulo velho
  com o arquivo mudado). Progresso na interface; saída em edicao/fase_2/.
- 0.7.5: a instalação do motor Remotion falhava em toda máquina limpa — o
  npm empacotado é `node npm-cli.js` e o comando montado ignorava o
  argsPrefix, executando o binário do node como script. Spawns de runtime
  agora passam por `runResolved`; a UI mostra o motivo real da falha e o
  clique em "Salvar e aplicar" tenta de novo (erro não fica cacheado).
- 0.7.4: o protocolo edvid-media passou a servir Range (206/Accept-Ranges).
  O net.fetch(file://) ignorava o cabeçalho; em arquivos grandes o clique na
  timeline era ignorado ou reiniciava o vídeo do zero.
- 0.7.3: o limite do corte na prévia mapeada passou a ser imposto pelo próprio
  <video> (timeupdate). O motor de rAF só roda enquanto o React acha que está
  tocando; quando o elemento voltava a tocar fora desse estado, nada segurava
  o corte e o arquivo-fonte corria inteiro.
- 0.7.2: a fonte do EDL deixa de cair na mídia do preview — os ranges estão
  no tempo do arquivo original e a prévia buscava esses tempos no render já
  cortado. Marcadores de corte removidos da timeline.
- 0.7.1: leitura tolerante do EDL — um "beat" numérico escrito pelo agente
  derrubava o refresh do workspace a cada turno.
- 0.7.0: Fase 2 renderizada pelo Remotion — template embutido com accent real,
  runtime instalado pelo aplicativo e agente proibido de improvisar pipeline.
- 0.6.1: transcrição sem aprovação (caches em app data, `writable_roots` e
  modelo baixado pelo aplicativo), agulha volta a seguir o clique sobre um
  clipe e o preview passa a mostrar o render mais recente da Fase 2.

## 16. Testes e comandos usuais

Durante o desenvolvimento:

```bash
npm run typecheck
npm run test:codex-protocol
npm run test:timeline
npm run test:media
git diff --check
```

QA visual no navegador:

```bash
npx vite --host 127.0.0.1 --port 4831
```

O `src/qa-browser-api.ts` fornece projeto, mídia, EDL, eventos e aprovações
simulados. Validar visualmente mudanças importantes, além da tipagem.

Empacotamento completo:

```bash
npm run make
```

Esse comando prepara todos os runtimes, empacota o Electron e gera DMG/ZIP. É
um processo pesado e pode levar alguns minutos.

Após gerar:

```bash
codesign --verify --deep --strict --verbose=2 out/Edvid-darwin-arm64/Edvid.app
plutil -extract CFBundleShortVersionString raw out/Edvid-darwin-arm64/Edvid.app/Contents/Info.plist
```

## 17. Convenções para continuar o desenvolvimento

- Trabalhar no repositório `edvid-desktop`, salvo pedido explícito envolvendo a
  skill ou um projeto de vídeo.
- Preservar mudanças do usuário e não misturar alterações não relacionadas.
- Atualizar `package.json`, `package-lock.json` e a versão citada no `README.md`
  em cada release distribuída.
- Rodar tipagem, smoke test, QA visual e `git diff --check`.
- Validar assinatura e versão do artefato.
- Os commits recentes foram enviados diretamente para `main`; manter esse fluxo
  enquanto o usuário não pedir branches ou pull requests.
- Não apagar artefatos antigos automaticamente.
- Não registrar nem imprimir segredos.
- Não mostrar caminhos locais no chat do produto.
- Não colocar aprovações técnicas dentro da conversa.
- Preferir controles visuais para aprovações, estilo e edição fina.

## 18. Próximo passo recomendado

O marco da timeline não destrutiva v1 foi concluído na 0.6.0 (seção 11).
Próximos passos candidatos, em ordem sugerida:

1. Validar o fluxo completo com um projeto real no aplicativo Electron:
   editar → Aplicar edições → agente regrava o EDL e re-renderiza → o modelo
   re-migra sincronizado.
2. Thumbnails e waveform pré-calculados nas tracks (FFmpeg em segundo plano,
   cache por fingerprint da fonte).
3. Mover clipes na timeline (drag do corpo do clipe, com snap e ripple).
4. Edição de velocidade, ganho e fades pela interface (o schema já suporta).
5. Estender o modelo para as tracks da Fase 2 (headline, legendas, inserts e
   trilha hoje são chips ilustrativos).
6. Preparar a distribuição: Developer ID, notarização, stapling e atualização
   automática; depois os runtimes Windows.

A prévia mapeada usa os arquivos-fonte sem grade; o render do agente continua
sendo a referência visual final. Não transformar a prévia em substituto do
render.
