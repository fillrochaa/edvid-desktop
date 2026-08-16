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

// Uma amostra por familia e suficiente: document.fonts.ready espera todo o
// restante que a folha declarar.
const PROBES = [
  `900 100px '${POPPINS}'`,
  `italic 900 100px '${PLAYFAIR}'`,
  `400 100px '${LORA}'`,
  `700 100px '${BASKERVILLE}'`,
  `500 100px '${INTER}'`,
];

let loading: Promise<void> | null = null;

export function loadEdvidFonts(): void {
  if (loading) return;
  const handle = delayRender('Carregando as fontes locais do Edvid');
  loading = (async () => {
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
    await Promise.all(PROBES.map((probe) => document.fonts.load(probe)));
    await document.fonts.ready;
  })()
    .catch(() => undefined)
    .finally(() => continueRender(handle));
}
