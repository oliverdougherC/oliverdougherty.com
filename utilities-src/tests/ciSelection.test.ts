import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GROUPS, PR_LANES, classifyPaths, changedPaths, selectForEvent, writeSelection } from '../../scripts/ci-select.js';

const sha = 'a'.repeat(40);
const SWEEP = 'cross-engine-sweep';

describe('CI changed-file selection', () => {
  it.each(['docs/release/checks.md', 'README.md', 'AGENTS.md', '.github/ISSUE_TEMPLATE/bug.md', '.github/PULL_REQUEST_TEMPLATE.md'])('omits browser regressions for documentation %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual([]);
    expect(classifyPaths([file]).hasRegressions).toBe(false);
    expect(classifyPaths([file], 'pr').lanes).toEqual([]);
    expect(classifyPaths([file], 'pr').hasRegressions).toBe(false);
  });

  it.each(['utilities-src/src/audioFourier.worker.ts', 'utilities-src/src/transformCore.ts', 'utilities-src/src/stressTestController.ts', 'utilities-src/vm-src/proxy-worker/index.js', 'pages/utilities/index.html', 'assets/utilities/image-transform/face.png', 'js/utilities-shell.js', 'css/utilities.css'])('includes all utility release coverage for %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual(['navigation', 'utilities', 'artifact', 'cache']);
    expect(classifyPaths([file], 'pr').lanes).toEqual(['navigation', 'utilities-shell', 'utilities-workloads', 'utilities-games', 'packaged-routes', SWEEP]);
  });

  it.each(['pages/gallery/index.html', 'mobile/gallery/index.html', 'assets/photos/descriptions.md', 'js/gallery.js', 'css/mobile-gallery.css'])('covers gallery runtime input %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual(['navigation', 'gallery', 'artifact']);
    expect(classifyPaths([file], 'pr').lanes).toEqual(['navigation', 'gallery', 'packaged-routes', SWEEP]);
  });

  it.each(['index.html', 'mobile/index.html', 'pages/resume/index.html', 'mobile/resume/index.html', 'js/nighthawks.js', 'css/home.css', 'assets/art/nighthawks-credited.png', 'css/project-motion/vmaf.css'])('covers home and navigation input %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual(['navigation', 'home']);
    expect(classifyPaths([file], 'pr').lanes).toEqual(['navigation', 'home', SWEEP]);
  });

  it.each(['scripts/ci-select.js', 'scripts/nighthawks-reveal-check.js', 'config/vite.utilities.mts', 'utilities-src/tests/gallery.test.ts', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'js/main.js', 'css/design-system.css', 'css/schematic.css', 'css/mobile.css', 'assets/fonts/example.ttf', 'new-feature/file.md', '.github/unknown.md'])('fails broad for shared or unknown input %s', (file) => {
    expect(classifyPaths([file]).groups).toEqual(GROUPS);
    expect(classifyPaths([file], 'pr').lanes).toEqual(PR_LANES);
  });

  it('always keeps the cross-engine sweep when a PR runs regressions at all', () => {
    // Home changes touch no artifact/cache suite, yet Firefox/WebKit still see
    // the packaged routes: the sweep is the PR's only cross-engine evidence.
    const result = classifyPaths(['index.html'], 'pr');
    expect(result.groups).toEqual(['navigation', 'home']);
    expect(result.lanes.at(-1)).toBe(SWEEP);
    expect(result.decisions[SWEEP].selected).toBe(true);
    expect(result.decisions[SWEEP].reason).toContain('sweep');
  });

  it('derives PR lane reasons from the group evidence that triggered them', () => {
    const result = classifyPaths(['js/gallery.js'], 'pr');
    expect(result.decisions.gallery.reason).toContain('js/gallery.js');
    expect(result.decisions.home.selected).toBe(false);
    expect(result.decisions.home.reason).toContain('lane');
  });

  it('runs full validation with groups for main and unsupported events', () => {
    const main = selectForEvent({ eventName: 'push', event: {}, ref: 'refs/heads/main' });
    expect(main.groups).toEqual(GROUPS);
    expect(main.lanes).toEqual(GROUPS);
    expect(main.laneProfile).toBe('full');
    expect(selectForEvent({ eventName: 'mystery', event: {}, ref: '' }).groups).toEqual(GROUPS);
    expect(selectForEvent({ eventName: 'push', event: {}, ref: 'refs/heads/feature' }).groups).toEqual(GROUPS);
  });

  it.each(['schedule', 'workflow_dispatch'])('runs every group for %s', (eventName) => {
    const result = selectForEvent({ eventName, event: {}, ref: 'refs/heads/beta' });
    expect(result.groups).toEqual(GROUPS);
    expect(result.lanes).toEqual(GROUPS);
    expect(result.laneProfile).toBe('full');
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
      expect(result.laneProfile).toBe('pr');
      expect(result.lanes).toEqual(['navigation', 'home', 'gallery', 'packaged-routes', SWEEP]);
      const beta = selectForEvent({ eventName: 'push', event: { before: base, after: head }, ref: 'refs/heads/beta', cwd: root });
      expect(beta.groups).toEqual(result.groups);
      expect(beta.laneProfile).toBe('pr');
      expect(beta.lanes).toEqual(result.lanes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('unions changed paths, retaining a reason for every selected and omitted group', () => {
    const result = classifyPaths(['README.md', 'js/nighthawks.js', 'pages/gallery/index.html']);
    expect(result.groups).toEqual(['navigation', 'home', 'gallery', 'artifact']);
    expect(result.decisions.home.reason).toContain('js/nighthawks.js');
    expect(result.decisions.cache.selected).toBe(false);
    expect(result.decisions.cache.reason).toBeTruthy();
    expect(classifyPaths([]).groups).toEqual([]);
  });

  it('writes machine-readable outputs, a durable selection and a readable summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-output-'));
    try {
      const output = join(root, 'github-output');
      const summary = join(root, 'github-summary');
      const result = classifyPaths(['assets/photos/<image>|name.jpg']);
      writeSelection(result, { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, root);
      expect(readFileSync(output, 'utf8')).toBe('groups=["navigation","gallery","artifact"]\nlanes=["navigation","gallery","artifact"]\nlane-profile=full\nhas-regressions=true\n');
      expect(JSON.parse(readFileSync(join(root, 'output/ci/selection.json'), 'utf8'))).toEqual(result);
      expect(readFileSync(summary, 'utf8')).toContain('| cache | Omit |');
      expect(readFileSync(summary, 'utf8')).toContain('&lt;image&gt;&#124;name.jpg');

      const prOutput = join(root, 'github-output-pr');
      const prSummary = join(root, 'github-summary-pr');
      const prResult = classifyPaths(['assets/photos/<image>|name.jpg'], 'pr');
      writeSelection(prResult, { GITHUB_OUTPUT: prOutput, GITHUB_STEP_SUMMARY: prSummary }, root);
      expect(readFileSync(prOutput, 'utf8')).toBe('groups=["navigation","gallery","artifact"]\nlanes=["navigation","gallery","packaged-routes","cross-engine-sweep"]\nlane-profile=pr\nhas-regressions=true\n');
      expect(readFileSync(prSummary, 'utf8')).toContain(`| ${SWEEP} | Run |`);
      expect(readFileSync(prSummary, 'utf8')).toContain('| home | Omit |');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
