import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import path from 'node:path';

import { linkCheckout, linkedPackages, packageDirs, SIDEKICK_ROOT } from './linked.ts';
import { writeTypesConfigs } from './linked-types.ts';

const EXTENSION = path.join(SIDEKICK_ROOT, 'packages/extension');

const USAGE = 'Usage: linked-cli.ts link|prepare';

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

function link() {
  const checkout = linkCheckout(SIDEKICK_ROOT);
  const packages = linkedPackages(SIDEKICK_ROOT);

  console.log(
    checkout ? `FrogBot checkout: ${checkout} (${head(checkout)})` : 'FrogBot packages: from npm',
  );

  writeTypesConfigs(packageDirs(SIDEKICK_ROOT), packages);

  return { checkout, packages };
}

function build(checkout: string, names: string[]) {
  const filters = names.flatMap((name) => ['--filter', `${name}...`]);
  const result = spawnSync('pnpm', ['--dir', checkout, ...filters, 'build'], { encoding: 'utf8' });

  if (result.status === 0) return 0;

  console.error(`${result.stdout}${result.stderr}`);
  console.error(`Building ${names.join(', ')} in ${checkout} failed`);

  return result.status ?? 1;
}

function prepare() {
  const { checkout, packages } = link();

  const status =
    run('pnpm', ['exec', 'wxt', 'prepare'], { cwd: EXTENSION }) ||
    (checkout
      ? build(
          checkout,
          packages.map((pkg) => pkg.name),
        )
      : 0);

  if (status === 0) writeTypesConfigs(packageDirs(SIDEKICK_ROOT), packages);

  return status;
}

function main([command]: string[]) {
  if (command === 'link') {
    link();

    return 0;
  }

  if (command === 'prepare') return prepare();

  throw new Error(USAGE);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
