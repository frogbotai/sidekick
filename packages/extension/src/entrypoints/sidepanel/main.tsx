import '@frogbotai/ui/fonts.css';
import '@frogbotai/ui/styles.css';
import './panel.css';

import {
  cleanupLegacyPanel,
  connectWorker,
  registerBuiltinSearchProviders,
  registerWebfetchTool,
  registerWebSearchTool,
  sidekickProtocol,
  theme,
  tools,
} from '@frogbotai/sidekick-core';
import { registerFrogbotSearch } from '@frogbotai/sidekick-core/frogbot';
import * as provider from '@frogbotai/sidekick-core/provider';
import { streamText } from 'ai';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { savedNavOpen } from '../../nav/PanelNav';
import { startCatalog } from '../../providers/catalog';
import { startSessions } from '../../session';
import { App } from './App';

const root = document.getElementById('root');

if (!root) throw new Error('Missing #root');

const worker = connectWorker(sidekickProtocol);

const sidekick = { worker, provider, streamText, tools };

if (import.meta.env.SIDEKICK_E2E) Object.assign(window, { sidekick });

provider.registerBuiltinProviders();
registerBuiltinSearchProviders();
registerFrogbotSearch();
registerWebSearchTool();
registerWebfetchTool();
void cleanupLegacyPanel({ localStorage, document });

const [initialMode, navOpen] = await Promise.all([
  theme.get(),
  savedNavOpen(),
  provider.registerCustomProviders(),
]);

void startCatalog();

const sessions = chrome.windows
  .getCurrent()
  .then(({ id }) => startSessions(worker, id))
  .then((started) => {
    if (import.meta.env.SIDEKICK_E2E) Object.assign(sidekick, started);

    return started;
  });

createRoot(root).render(
  <StrictMode>
    <App initialMode={initialMode} navOpen={navOpen} worker={worker} sessions={sessions} />
  </StrictMode>,
);
