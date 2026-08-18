# Edvid Desktop — contexto consolidado do projeto

Atualizado em: 2026-08-17 (0.8.0 — login de alunos pela Creator Factory)

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
- O modelo de VAD não é baixado: ele acompanha o pacote do WhisperX em
  `whisperx/assets/pytorch_model.bin`. Verificado rodando a transcrição
  completa com `HF_HUB_OFFLINE=1`.

## 5. Login e Codex

- O login com ChatGPT acontece pelo Codex App Server.
- O navegador recebe o fluxo OAuth e retorna ao aplicativo.
- O Codex usa um `CODEX_HOME` próprio dentro dos dados do Edvid.
- O fluxo já suporta `account/login/start`, cancelamento, logout, criação de
  thread, envio de turnos, streaming e interrupção.
- O Desktop não deve depender da skill instalada no `CODEX_HOME` pessoal do
  usuário. As regras essenciais do produto ficam nas developer instructions do
  próprio aplicativo.
- O fuse de criptografia de cookies está desabilitado porque o Edvid não
  persiste cookies do Electron. Isso evitou o prompt desnecessário do macOS
  Keychain chamado “Edvid Safe Storage”.

## 6. Modelo de segurança e aprovações

- O Codex usa `approvalPolicy: on-request` e sandbox `workspace-write`.
- O `thread/start` aceita `sandbox` **apenas como string** (`read-only`,
  `workspace-write`, `danger-full-access`); não há parâmetros inline. Isso foi
  verificado sondando o app-server: qualquer objeto é recusado com
  "expected map with a single key" / "expected unit". A configuração fina vai
  no `config.toml` do `CODEX_HOME`, que o aplicativo escreve a cada start
  (`codex-app-server.ts`).
- Esse `config.toml` mantém `network_access = false` e declara os caches do
  aplicativo em `writable_roots`. É o que permite transcrever sem aprovação
  sem abrir rede para o agente.
- Reduzir atrito nunca é motivo para autoaprovar: a forma correta é remover a
  causa da escalada (dar caminho gravável e conteúdo já baixado), não aceitar
  comando automaticamente.
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
- Nunca autoaprovar comandos genéricos apenas para reduzir atrito.

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

- Tipo de edição: limpa, tela dividida ou tela dividida 2.
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
- Quando existe J-cut, o EDL deve incluir `jcut_timeline` com posições reais do
  arquivo final.
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
9. "Aplicar edições" envia os novos ranges (tempo de fonte) ao agente para
   regravar o EDL e re-renderizar; "Descartar" volta ao corte atual.
   Enquanto houver edições pendentes, as marcações In/Out ficam bloqueadas.

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

Versão corrente: **0.8.0**.

Artefato local atual:

`/Users/fillrocha/Developer/edvid-desktop/out/make/Edvid-0.8.0-arm64.dmg`

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

Status: certificado Developer ID Application instalado e validado
("Filipe Rocha", team X6ADV89943), credenciais no signing.env local
(gitignored), bucket R2 criado com URL pública fixada em UPDATE_FEED_URL, e
`npm run publish:update` publica ZIP + feed via wrangler. Lição de campo: o
Keychain mostrando "0 valid identities" com o certificado presente significa
**intermediária ausente** — instalar a Developer ID G2 CA de
apple.com/certificateauthority/DeveloperIDG2CA.cer resolve.

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

## 14. Windows

- Existe configuração inicial com Electron Forge/Squirrel.
- Os runtimes Windows x64 precisam ser preparados e empacotados na própria
  plataforma Windows.
- Ainda é necessário validar instalador, assinatura de código, paths, execução
  dos sidecars e atualização no Windows.
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
