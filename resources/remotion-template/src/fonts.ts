import {continueRender, delayRender, staticFile} from 'remotion';

// Fontes locais, servidas de public/fonts. O @remotion/google-fonts busca os
// arquivos em fonts.gstatic.com durante o render, e o Edvid renderiza sem
// rede: os arquivos viriam vazios e a tipografia cairia para a fonte padrao,
// desmontando justamente os estilos. O aplicativo baixa as familias uma vez ao
// instalar o runtime e escreve public/fonts/fonts.css com os @font-face.

export const POPPINS = 'Poppins';
export const PLAYFAIR = 'Playfair Display';
export const LORA = 'Lora';
export const BASKERVILLE = 'Libre Baskerville';
export const INTER = 'Inter';

// Se o carregamento passar disso, o render segue com a fonte reserva: um
// frame com a fonte errada e melhor do que abortar o render inteiro.
const FONT_TIMEOUT_MS = 30000;

let loading: Promise<void> | null = null;

export function loadEdvidFonts(): void {
  if (loading) return;
  // timeoutInMilliseconds proprio: o backstop abaixo garante que o handle e
  // liberado em ate 30 s, entao o prazo do Remotion aqui e so redundancia — e
  // com o prazo da CLI ele ja derrubou renders inteiros marcando este handle
  // como pendente mesmo depois de todas as abas confirmarem as fontes.
  const handle = delayRender('Carregando as fontes locais do Edvid', {
    timeoutInMilliseconds: 86_400_000,
  });
  // Os marcadores edvid-fonts aparecem com --log=verbose e mostram onde o
  // carregamento parou quando um render morrer por timeout das fontes.
  console.log('edvid-fonts: v2 iniciando');
  const load = (async () => {
    const href = staticFile('fonts/fonts.css');
    if (!document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
      await new Promise<void>((resolve) => {
        link.addEventListener('load', () => resolve(), {once: true});
        // Sem a folha o render continua com fonte padrao, o que e melhor do
        // que travar o frame para sempre.
        link.addEventListener('error', () => resolve(), {once: true});
      });
    }
    console.log('edvid-fonts: folha carregada');
    // Carrega cada @font-face declarado na folha, sem document.fonts.ready:
    // sob carga esse promise pode nunca resolver numa aba de render, e o
    // delayRender estoura o timeout depois de minutos de trabalho feito.
    await Promise.allSettled(Array.from(document.fonts).map((face) => face.load()));
    console.log(`edvid-fonts: ${document.fonts.size} faces prontas`);
  })();
  loading = Promise.race([
    load,
    // Backstop: uma requisicao de fonte pendurada (sem load e sem error) nao
    // pode segurar o handle para sempre e derrubar o render no timeout.
    new Promise<void>((resolve) => {
      setTimeout(() => {
        console.log('edvid-fonts: backstop de tempo acionado');
        resolve();
      }, FONT_TIMEOUT_MS);
    }),
  ])
    .catch(() => undefined)
    .finally(() => {
      continueRender(handle);
      console.log('edvid-fonts: handle liberado');
    });
}
