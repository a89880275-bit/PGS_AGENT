import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const folder of ['apps','packages','scripts','tests']) {
  for (const path of await readdir(root + folder, { recursive: true })) {
    if (!/\.(mjs|ts)$/.test(path)) continue;
    const result = spawnSync(process.execPath, ['--check', root + folder + '/' + path], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('Node source check passed');