import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertEnvFilePermissions, checkEnvFilePermissions } from './env-file';

function envFileWithMode(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'eim-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, 'EIM_PUBLIC_URL=https://example.com\n', 'utf8');
  chmodSync(path, mode);
  return path;
}

describe('checkEnvFilePermissions', () => {
  it('accepts an owner-only file', () => {
    expect(checkEnvFilePermissions(envFileWithMode(0o600), { enforce: true })).toStrictEqual({
      ok: true,
    });
  });

  it('rejects a group-readable file and names the fix', () => {
    const verdict = checkEnvFilePermissions(envFileWithMode(0o640), { enforce: true });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problem).toContain('chmod 600');
      expect(verdict.problem).toContain('640');
    }
  });

  it('rejects a world-readable file', () => {
    expect(checkEnvFilePermissions(envFileWithMode(0o644), { enforce: true }).ok).toBe(false);
  });

  it('never echoes the file contents in the problem message', () => {
    const verdict = checkEnvFilePermissions(envFileWithMode(0o644), { enforce: true });
    if (!verdict.ok) {
      expect(verdict.problem).not.toContain('EIM_PUBLIC_URL');
    }
  });

  it('treats a missing file as not a permission problem', () => {
    expect(checkEnvFilePermissions('/nonexistent/path/.env', { enforce: true })).toStrictEqual({
      ok: true,
    });
  });
});

describe('assertEnvFilePermissions', () => {
  it('throws in production so startup fails closed', () => {
    expect(() => {
      assertEnvFilePermissions(envFileWithMode(0o644), { enforce: true });
    }).toThrow(/Refusing to start/);
  });

  it('only reports outside production so development is not blocked', () => {
    expect(() => {
      assertEnvFilePermissions(envFileWithMode(0o644), { enforce: false });
    }).not.toThrow();
  });
});
