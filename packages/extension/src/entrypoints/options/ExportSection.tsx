import type { ExportReader } from '@frogbotai/sidekick-core';
import { Button } from '@frogbotai/ui';
import { useState } from 'react';

import { exportAll } from '../../session/export';

/** The options page's Export, at `#export`: every chat and its subagents in one JSON file. */
export function ExportSection({ reader }: { reader: ExportReader }) {
  const [exporting, setExporting] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = () => {
    setExporting(true);
    setFailed(false);

    void exportAll(reader)
      .catch(() => setFailed(true))
      .finally(() => setExporting(false));
  };

  return (
    <section id="export" className="sidekick-stack" aria-labelledby="export-title">
      <h2 id="export-title" className="sidekick-title">
        Export
      </h2>
      <p>
        Saves every chat as one JSON file. It holds what Sidekick saw and did on web pages, such as
        page text, screenshots and anything typed, but no API keys or sign-ins.
      </p>
      <div className="sidekick-row">
        <Button variant="secondary" disabled={exporting} onClick={run}>
          Export all
        </Button>
      </div>
      {failed ? <p role="alert">Couldn’t export your chats. Try again.</p> : null}
    </section>
  );
}
