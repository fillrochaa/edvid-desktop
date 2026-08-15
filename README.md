# Edvid Desktop

Aplicativo Electron do editor de video por conversa Edvid. Este repositorio e
independente da [skill Edvid](https://github.com/fillrochaa/edvid): projetos de
edicao continuam em pastas escolhidas pelo usuario e nunca sao armazenados
dentro do aplicativo ou do codigo-fonte.

## Desenvolvimento

```bash
npm install
npm start
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
FFmpeg/FFprobe, uv, yt-dlp e Python/WhisperX em
`resources/runtimes/<plataforma>-<arquitetura>/`. Os binarios, modelos e caches
nao entram no Git; os scripts verificam fontes, assinaturas ou hashes antes de
montar o aplicativo. Em desenvolvimento existe fallback explicito para o
`PATH`; em um aplicativo empacotado esse fallback e desativado.

O build macOS arm64 ja gera `.app`, DMG e ZIP. Runtimes nativos para macOS x64 e
Windows x64 devem ser preparados e empacotados na respectiva plataforma.
