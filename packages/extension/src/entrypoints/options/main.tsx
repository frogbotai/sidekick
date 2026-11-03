import '@frogbotai/ui/fonts.css';
import '@frogbotai/ui/styles.css';
import '../sidepanel/panel.css';

import {
  connectWorker,
  createSessionStore,
  openDatabase,
  sidekickProtocol,
  theme,
} from '@frogbotai/sidekick-core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { followPageTheme } from '../../theme/pageTheme';
import { Options } from './Options';

const root = document.getElementById('root');

if (!root) throw new Error('Missing #root');

const [initialMode, database] = await Promise.all([theme.get(), openDatabase()]);

followPageTheme(initialMode, theme.watch);

const sessions = createSessionStore(database);

const worker = connectWorker(sidekickProtocol);

const disconnect = (pairingID: string) => {
  void worker.call('mcp.disconnect', { pairingID }).catch(() => undefined);
};

createRoot(root).render(
  <StrictMode>
    <Options initialMode={initialMode} disconnect={disconnect} sessions={sessions} />
  </StrictMode>,
);
