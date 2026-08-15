# Edvid Desktop

Aplicativo Electron do editor de video por conversa Edvid. Este repositorio e
independente da [skill Edvid](https://github.com/fillrochaa/edvid): projetos de
edicao continuam em pastas escolhidas pelo usuario e nunca sao armazenados
dentro do aplicativo ou do codigo-fonte.

## Desenvolvimento

```bash
npm install
npm run stage:codex
npm start
```

O estagio atual (`0.2.1`) inclui selecao da pasta do projeto, login gerenciado do
ChatGPT, conversa em streaming, interrupcao do turno e aprovacoes explicitas de
comandos e alteracoes de arquivo.

## Integracao com o ChatGPT

O Electron inicia um Codex App Server oficial como processo local e se comunica
com ele por JSONL em `stdio`. A versao `0.147.0` e fixada no manifesto, cada
artefato de macOS/Windows possui SHA-256 esperado e a licenca acompanha o
runtime empacotado.

- O OAuth abre `auth.openai.com` no navegador padrao.
- Tokens e estado de autenticacao ficam no processo do Codex, nunca no renderer.
- O `CODEX_HOME` e exclusivo do Edvid dentro dos dados do aplicativo.
- Cada conversa usa a pasta selecionada como workspace, sandbox
  `workspace-write` e politica de aprovacao `on-request`.
- Pedidos para executar comandos ou alterar arquivos aparecem como cartoes de
  aprovacao na conversa.

O smoke test valida inicializacao, leitura da conta e inicio/cancelamento do OAuth
sem abrir o navegador nem concluir um login:

```bash
npm run test:codex-protocol
```

## Validacao e empacotamento

```bash
npm run typecheck
npm run package
```

O Node 26.7.0 continua sendo o runtime planejado para o motor do Edvid. Os
comandos de empacotamento executam o Electron Forge com Node 22.23.2 porque a
linha 7 do Forge tem um bug conhecido ao finalizar pacotes com Node 24/26. Isso
afeta apenas a ferramenta de build, nao o Node que sera entregue ao usuario.

Os comandos de pacote preparam runtimes internos versionados para Node/npm,
FFmpeg/FFprobe, uv, yt-dlp, Python/WhisperX e Codex App Server em
`resources/runtimes/<plataforma>-<arquitetura>/`. Os binarios, modelos e caches
nao entram no Git; os scripts verificam fontes, assinaturas ou hashes antes de
montar o aplicativo. Em desenvolvimento existe fallback explicito para o
`PATH`; em um aplicativo empacotado esse fallback e desativado.

O build macOS arm64 ja gera `.app`, DMG e ZIP. Runtimes nativos para macOS x64 e
Windows x64 devem ser preparados e empacotados na respectiva plataforma.
