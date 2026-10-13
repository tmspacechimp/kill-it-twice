import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function verifyAll(run = spawnSync) {
  let failed = false;
  for (const scenario of ['g1', 'g2']) {
    const script = fileURLToPath(new URL(`./${scenario}/verify-${scenario}.mjs`, import.meta.url));
    const result = run(process.execPath, [script], { stdio: 'inherit', windowsHide: true });
    if (result.signal || result.status === 130 || result.status === 143) {
      return result.status || 130;
    }
    if (result.error || result.status !== 0) {
      failed = true;
      if (result.error) console.error(`Could not run ${scenario.toUpperCase()}:`, result.error);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = verifyAll();
}
