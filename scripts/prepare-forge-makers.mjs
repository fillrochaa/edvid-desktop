// Preparo dos makers do Forge por plataforma. No macOS o appdmg precisa do
// macos-alias reconstruido com o Node do sistema de build; no Windows o
// maker e o Squirrel e nao ha nada para reconstruir.
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('prepare:forge-makers: nada a preparar fora do macOS.');
  process.exit(0);
}

const result = spawnSync(
  'npx',
  ['--yes', '--package=node@22.23.2', '-c', 'npm rebuild macos-alias'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(result.status ?? 1);
