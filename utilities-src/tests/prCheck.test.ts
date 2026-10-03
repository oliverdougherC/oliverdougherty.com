import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('pull-request packaged browser gate', () => {
  it.each(['missing artifact', 'wrong artifact kind', 'stale candidate', 'foreign static root'])('fails closed and records evidence for %s', (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'pr-check-'));
    try {
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      copyFileSync(resolve('scripts/pr-check.js'), join(root, 'scripts/pr-check.js'));
      copyFileSync(resolve('scripts/lib/playwright-static.js'), join(root, 'scripts/lib/playwright-static.js'));
      if (scenario !== 'missing artifact') {
        mkdirSync(join(root, 'dist'));
        writeFileSync(join(root, 'dist/release-artifact.json'), JSON.stringify({
          kind: scenario === 'wrong artifact kind' ? 'authoring-tree' : 'oliverdougherty-deploy',
          commit: 'stale-candidate'
        }));
      }
      if (scenario === 'stale candidate') {
        const git = (...args: string[]) => {
          const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
          expect(result.status, result.stderr).toBe(0);
        };
        git('init', '--quiet');
        git('-c', 'user.name=PR Check Test', '-c', 'user.email=pr-check@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Create isolated test candidate');
      }
      const env = { ...process.env };
      delete env.STATIC_ROOT;
      delete env.GITHUB_STEP_SUMMARY;
      if (scenario === 'foreign static root') env.STATIC_ROOT = root;
      const result = spawnSync(process.execPath, [join(root, 'scripts/pr-check.js')], { env, encoding: 'utf8', timeout: 10000 });
      expect(result.status, result.stderr).toBe(1);
      const reportPath = join(root, 'output/pr/results.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      expect(report.status).toBe('fail');
      expect(report.results).toHaveLength(1);
      expect(report.results[0].name).toBe('packaged artifact identity and isolation');
      expect(report.results[0].status).toBe('fail');
      expect(report.seconds).toBeGreaterThanOrEqual(0);
      expect(report.error).toContain({
        'missing artifact': 'ENOENT',
        'wrong artifact kind': 'authoring-tree',
        'stale candidate': 'different candidate',
        'foreign static root': 'must serve this checkout'
      }[scenario]);
      // These checks must fail before browser launch, even without Playwright installed.
      expect(report.error).not.toContain("Cannot find module 'playwright'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
