#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const STEPS = [
  ['format', ['prettier', '--check', '.', '--log-level', 'warn']],
  ['eslint', ['eslint', '.', '--max-warnings=0']],
  ['oxlint', ['oxlint', '--type-aware', '--quiet']],
  ['typecheck', ['tsc', '-b', '--pretty']],
];

const failed = [];

for (const [name, [command, ...args]] of STEPS) {
  const result = spawnSync('pnpm', ['exec', command, ...args], { stdio: 'inherit' });

  if (result.status !== 0) failed.push(name);
}

if (failed.length > 0) {
  console.error(`check: FAILED ${failed.join(', ')}`);
  process.exit(1);
}

console.log(`check: OK ${STEPS.map(([name]) => name).join(', ')}`);
