import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import path from 'node:path';

import {
  CHECKOUT_ENV,
  LINKED_MODE,
  type LinkedPackage,
  linkedPackages,
  resolveCheckout,
  SIDEKICK_ROOT,
} from './linked.ts';
import { writeLinkedTsconfigs } from './typecheck-linked.ts';

const EXTENSION = path.join(SIDEKICK_ROOT, 'packages/extension');

const LINKED_PLAYWRIGHT = 'playwright.linked.config.ts';

const USAGE = 'Usage: linked-cli.ts dev|e2e|typecheck [<checkout>] [-- <args>]';

function run(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });

  return result.status ?? 1;
}

function head(checkout: string) {
  const result = spawnSync('git', ['-C', checkout, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  });

  return result.status === 0 ? result.stdout.trim() : 'not a git checkout';
}

function dev(checkout: string, args: string[]) {
  const env = { ...process.env, [CHECKOUT_ENV]: checkout };

  return run('pnpm', ['exec', 'wxt', '--mode', LINKED_MODE, ...args], { cwd: EXTENSION, env });
}

function e2e(checkout: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [CHECKOUT_ENV]: checkout,
    SIDEKICK_E2E: '1',
    NODE_ENV: 'production',
  };

  for (const variant of [{}, { SIDEKICK_LIVE: '1' }]) {
    const build = run('pnpm', ['exec', 'wxt', 'build', '--mode', LINKED_MODE], {
      cwd: EXTENSION,
      env: { ...env, ...variant },
    });

    if (build !== 0) return build;
  }

  return run('pnpm', ['exec', 'playwright', 'test', '--config', LINKED_PLAYWRIGHT, ...args], {
    cwd: SIDEKICK_ROOT,
  });
}

function typecheck(checkout: string, packages: LinkedPackage[]) {
  const filters = packages.flatMap((pkg) => ['--filter', `${pkg.name}...`]);
  const build = run('pnpm', ['--dir', checkout, ...filters, 'build']);

  if (build !== 0) return build;

  let status = 0;

  for (const config of writeLinkedTsconfigs(packages)) {
    console.log(`tsc -p ${path.relative(SIDEKICK_ROOT, config)}`);

    status ||= run('pnpm', ['exec', 'tsc', '--noEmit', '--pretty', '-p', config], {
      cwd: SIDEKICK_ROOT,
    });
  }

  return status;
}

function main(argv: string[]) {
  const split = argv.includes('--') ? argv.indexOf('--') : argv.length;
  const [command, ...rest] = argv.slice(0, split);
  const checkoutArg = rest[0]?.startsWith('-') ? undefined : rest.shift();

  rest.push(...argv.slice(split + 1));

  if (command !== 'dev' && command !== 'e2e' && command !== 'typecheck') throw new Error(USAGE);

  const checkout = resolveCheckout(checkoutArg, SIDEKICK_ROOT, process.env.INIT_CWD);
  const packages = linkedPackages(checkout, SIDEKICK_ROOT);

  console.log(`FrogBot checkout: ${checkout} (${head(checkout)})`);

  if (command === 'dev') return dev(checkout, rest);

  if (command === 'e2e') return e2e(checkout, rest);

  return typecheck(checkout, packages);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
