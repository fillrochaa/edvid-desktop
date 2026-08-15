import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './brand/preview-base.css';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Elemento raiz do Edvid nao foi encontrado.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
