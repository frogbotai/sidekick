#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const STEPS = [
  ['prepare', ['--recursive', '--if-present', '--silent', 'run', 'postinstall']],
  ['format', ['exec', 'prettier', '--check', '.', '--log-level', 'warn']],
  ['eslint', ['exec', 'eslint', '.', '--max-warnings=0']],
  ['oxlint', ['exec', 'oxlint', '--type-aware', '--quiet']],
  ['typecheck', ['exec', 'tsc', '-b', '--pretty']],
];

const failed = [];

for (const [name, args] of STEPS) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit' });

  if (result.status !== 0) failed.push(name);
}

if (failed.length > 0) {
  console.error(`check: FAILED ${failed.join(', ')}`);
  process.exit(1);
}

console.log(`check: OK ${STEPS.map(([name]) => name).join(', ')}`);
