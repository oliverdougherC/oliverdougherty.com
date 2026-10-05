import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../../scripts/lib/run-emscripten.sh', import.meta.url));
describe('instrumented runtime toolchain argument boundary', () => {
  it('treats SDK paths and tool arguments as literal data, including shell syntax', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'assistant-toolchain-'));
    try {
      const sdk = path.join(root, 'sdk $(touch injected-sdk); quote"');
      mkdirSync(sdk);
      writeFileSync(path.join(sdk, 'emsdk_env.sh'), 'export ASSISTANT_TEST_SDK=loaded\n');
      const argument = '$(touch injected-argument); "literal"';
      const output = execFileSync('bash', [wrapper, sdk, process.execPath, '-e',
        'process.stdout.write(JSON.stringify({sdk:process.env.ASSISTANT_TEST_SDK,args:process.argv.slice(1)}))', argument], { cwd: root, encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual({ sdk: 'loaded', args: [argument] });
      expect(existsSync(path.join(root, 'injected-sdk'))).toBe(false);
      expect(existsSync(path.join(root, 'injected-argument'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('stops before launching a tool when the configured SDK cannot load', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'assistant-toolchain-'));
    try {
      expect(() => execFileSync('bash', [wrapper, path.join(root, 'missing SDK'), process.execPath,
        '-e', 'require("node:fs").writeFileSync("tool-ran", "bad")'], { cwd: root, stdio: 'pipe' })).toThrow();
      expect(existsSync(path.join(root, 'tool-ran'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
