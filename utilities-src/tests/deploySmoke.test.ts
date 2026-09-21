import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('deployment smoke release gate', () => {
  it.each([false, true])('fails closed with missing output/CNAME (dist exists: %s)', (hasDist) => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-smoke-'));
    try {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(resolve('scripts/smoke.js'), join(root, 'scripts/smoke.js'));
      if (hasDist) mkdirSync(join(root, 'dist'));
      const result = spawnSync(process.execPath, [join(root, 'scripts/smoke.js'), '--deploy-only'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(hasDist ? 'Deploy output missing CNAME' : 'Deploy output missing: run npm run build:deploy');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
