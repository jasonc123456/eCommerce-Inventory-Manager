import { statSync } from 'node:fs';

/**
 * Section 19: the installation `.env` must be readable and writable only by the
 * deployment administrator, and startup rejects unsafe group or world
 * permissions in production.
 *
 * This is checked rather than fixed. Silently tightening a file's mode would
 * hide the fact that something in the deployment created it wrongly, and the
 * operator needs to know that so they can find the cause.
 */

export type EnvFileVerdict =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

export interface EnvFileCheckOptions {
  /** Only production fails closed; development merely reports. */
  readonly enforce: boolean;
}

export function checkEnvFilePermissions(
  path: string,
  options: EnvFileCheckOptions,
): EnvFileVerdict {
  let mode: number;
  let uid: number;

  try {
    const stats = statSync(path);
    mode = stats.mode;
    uid = stats.uid;
  } catch {
    // A missing file is not a permission failure. Configuration validation
    // reports missing values with far better messages than a stat error would.
    return { ok: true };
  }

  const groupAndWorldBits = mode & 0o077;
  if (groupAndWorldBits !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(3, '0');
    return {
      ok: false,
      problem:
        `${path} is mode ${octal}; it must be readable and writable only by its owner. ` +
        `Run: chmod 600 ${path}`,
    };
  }

  if (options.enforce && typeof process.getuid === 'function' && uid !== process.getuid()) {
    return {
      ok: false,
      problem: `${path} is owned by uid ${String(uid)} but this process runs as uid ${String(process.getuid())}.`,
    };
  }

  return { ok: true };
}

export function assertEnvFilePermissions(path: string, options: EnvFileCheckOptions): void {
  const verdict = checkEnvFilePermissions(path, options);
  if (!verdict.ok && options.enforce) {
    throw new Error(`Refusing to start: ${verdict.problem}`);
  }
}
