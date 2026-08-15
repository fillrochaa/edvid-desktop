import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createQaBrowserApi } from './qa-browser-api';
import './brand/preview-base.css';
import './styles.css';

if (!window.edvidDesktop && import.meta.env.DEV) {
  window.edvidDesktop = createQaBrowserApi();
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Elemento raiz do Edvid nao foi encontrado.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
