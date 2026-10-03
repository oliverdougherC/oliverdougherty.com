import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GROUPS, classifyPaths, changedPaths, selectForEvent, writeSelection } from '../../scripts/ci-select.js';

const sha = 'a'.repeat(40);

describe('CI changed-file selection', () => {
  it.each(['docs/release/checks.md', 'README.md', 'AGENTS.md', '.github/ISSUE_TEMPLATE/bug.md', '.github/PULL_REQUEST_TEMPLATE.md'])('omits browser regressions for documentation %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual([]);
    expect(classifyPaths([file]).hasRegressions).toBe(false);
  });

  it.each(['utilities-src/src/audioFourier.worker.ts', 'utilities-src/src/transformCore.ts', 'utilities-src/src/stressTestController.ts', 'utilities-src/vm-src/proxy-worker/index.js', 'pages/utilities/index.html', 'assets/utilities/image-transform/face.png', 'js/utilities-shell.js', 'css/utilities.css'])('includes all utility release coverage for %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual(['navigation', 'utilities', 'artifact', 'cache']);
  });

  it.each(['pages/gallery/index.html', 'mobile/gallery/index.html', 'assets/photos/descriptions.md', 'js/gallery.js', 'css/mobile-gallery.css'])('covers gallery runtime input %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual(['navigation', 'gallery', 'artifact']);
  });

  it.each(['index.html', 'mobile/index.html', 'pages/resume/index.html', 'mobile/resume/index.html', 'js/nighthawks.js', 'css/home.css', 'assets/art/nighthawks-credited.png', 'css/project-motion/vmaf.css'])('covers home and navigation input %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual(['navigation', 'home']);
  });

  it.each(['scripts/ci-select.js', 'scripts/nighthawks-reveal-check.js', 'config/vite.utilities.mts', 'utilities-src/tests/gallery.test.ts', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'js/main.js', 'css/design-system.css', 'css/schematic.css', 'css/mobile.css', 'assets/fonts/example.ttf', 'new-feature/file.md', '.github/unknown.md'])('fails broad for shared or unknown input %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual(GROUPS);
  });

  it('unions changed paths, retaining a reason for every selected and omitted group', () => {
    const result = classifyPaths(['README.md', 'js/nighthawks.js', 'pages/gallery/index.html']);
    expect(result.groups).toEqual(['navigation', 'home', 'gallery', 'artifact']);
    expect(result.decisions.home.reason).toContain('js/nighthawks.js');
    expect(result.decisions.cache.selected).toBe(false);
    expect(result.decisions.cache.reason).toBeTruthy();
    expect(classifyPaths([]).groups).toEqual([]);
  });

  it.each(['schedule', 'workflow_dispatch'])('runs every group for %s', (eventName) => {
    expect(selectForEvent({ eventName, event: {}, ref: 'refs/heads/beta' }).groups).toEqual(GROUPS);
  });

  it('runs every group on main and unsupported events', () => {
    expect(selectForEvent({ eventName: 'push', event: {}, ref: 'refs/heads/main' }).groups).toEqual(GROUPS);
    expect(selectForEvent({ eventName: 'mystery', event: {}, ref: '' }).groups).toEqual(GROUPS);
    expect(selectForEvent({ eventName: 'push', event: {}, ref: 'refs/heads/feature' }).groups).toEqual(GROUPS);
  });

  it.each([undefined, '', '0'.repeat(40), '--help'])('runs full validation for unusable beta before SHA %s', (before) => {
    expect(selectForEvent({ eventName: 'push', event: { before, after: sha }, ref: 'refs/heads/beta' }).groups).toEqual(GROUPS);
  });

  it('rejects malformed PR SHAs and beta heads before executing git', () => {
    expect(() => selectForEvent({ eventName: 'pull_request', event: {}, ref: '' })).toThrow('invalid commit SHA');
    expect(() => changedPaths('.', '--help', sha)).toThrow('invalid commit SHA');
    expect(() => selectForEvent({ eventName: 'push', event: { before: sha, after: '--help' }, ref: 'refs/heads/beta' })).toThrow('invalid commit SHA');
  });

  it('reports Git failures instead of silently skipping checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-no-git-'));
    try {
      expect(() => changedPaths(root, sha, 'b'.repeat(40))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses the full PR merge-base diff and both names of renames, including deletions', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-diff-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
    try {
      git('init', '-q');
      git('config', 'user.name', 'CI Selection Test');
      git('config', 'user.email', 'ci@example.invalid');
      mkdirSync(join(root, 'docs'));
      mkdirSync(join(root, 'js'));
      writeFileSync(join(root, 'README.md'), 'base\n');
      writeFileSync(join(root, 'js', 'nighthawks.js'), 'home input\n');
      writeFileSync(join(root, 'js', 'gallery.js'), 'gallery input\n');
      const base = commit('base');
      git('checkout', '-qb', 'feature');
      renameSync(join(root, 'js', 'nighthawks.js'), join(root, 'docs', 'nighthawks.md'));
      rmSync(join(root, 'js', 'gallery.js'));
      commit('move runtime file to docs and delete gallery');
      writeFileSync(join(root, 'README.md'), 'feature latest commit only docs\n');
      const head = commit('docs follow-up');
      git('checkout', '-qb', 'base-advanced', base);
      writeFileSync(join(root, 'unknown-shared-config'), 'base-only change\n');
      const advancedBase = commit('base branch advances');
      const event = { pull_request: { base: { sha: advancedBase }, head: { sha: head } } };
      const result = selectForEvent({ eventName: 'pull_request', event, ref: 'refs/pull/1/merge', cwd: root });
      expect(result.files).toContain('js/nighthawks.js');
      expect(result.files).toContain('docs/nighthawks.md');
      expect(result.files).toContain('js/gallery.js');
      expect(result.files).not.toContain('unknown-shared-config');
      expect(result.groups).toEqual(['navigation', 'home', 'gallery', 'artifact']);
      expect(selectForEvent({ eventName: 'push', event: { before: base, after: head }, ref: 'refs/heads/beta', cwd: root }).groups).toEqual(result.groups);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('writes machine-readable outputs, a durable selection and a readable summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-output-'));
    try {
      const output = join(root, 'github-output');
      const summary = join(root, 'github-summary');
      const result = classifyPaths(['assets/photos/<image>|name.jpg']);
      writeSelection(result, { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, root);
      expect(readFileSync(output, 'utf8')).toBe('groups=["navigation","gallery","artifact"]\nhas-regressions=true\n');
      expect(JSON.parse(readFileSync(join(root, 'output/ci/selection.json'), 'utf8'))).toEqual(result);
      expect(readFileSync(summary, 'utf8')).toContain('| cache | Omit |');
      expect(readFileSync(summary, 'utf8')).toContain('&lt;image&gt;&#124;name.jpg');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
