import '@frogbotai/ui/styles.css';
import './panel.css';

import { connectWorker, sidekickProtocol, theme } from '@frogbotai/sidekick-core';
import * as provider from '@frogbotai/sidekick-core/provider';
import { streamText } from 'ai';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { startCatalog } from '../../providers/catalog';
import { App } from './App';

const root = document.getElementById('root');

if (!root) throw new Error('Missing #root');

const worker = connectWorker(sidekickProtocol);

if (import.meta.env.SIDEKICK_E2E) {
  Object.assign(window, { sidekick: { worker, provider, streamText } });
}

provider.registerBuiltinProviders();

const [initialMode] = await Promise.all([theme.get(), provider.registerCustomProviders()]);

void startCatalog();

createRoot(root).render(
  <StrictMode>
    <App initialMode={initialMode} worker={worker} />
  </StrictMode>,
);
