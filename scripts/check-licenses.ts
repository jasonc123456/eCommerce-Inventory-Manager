/**
 * Dependency licence compatibility (section 24, D-100).
 *
 * This project is AGPL-3.0-only. That is a strong copyleft licence, and it can
 * only be offered honestly if every dependency permits it: a single dependency
 * under a licence that AGPL cannot absorb makes the distributed combination
 * unlicensable, which is a defect in the release rather than a matter of taste.
 *
 * The check runs against `pnpm licenses list`, which reports what is actually
 * in the lockfile rather than what any manifest claims to want.
 *
 * Two deliberate choices about strictness:
 *
 *   The allowlist is of permissive and weak-copyleft licences that AGPL-3.0 can
 *   incorporate. Anything unrecognized fails rather than passing, because the
 *   failure mode of a permissive default is a licence violation nobody notices
 *   until somebody asks for the source.
 *
 *   Unknown or absent licence metadata also fails. "No licence declared" is not
 *   permission; it is the absence of permission.
 */

import { execFileSync } from 'node:child_process';

/**
 * Licences that AGPL-3.0-only can incorporate.
 *
 * MPL-2.0 is here because it is file-level copyleft: it obliges publication of
 * changes to its own files and does not reach into the combined work.
 * LGPL likewise. GPL-2.0-only is deliberately absent — it is famously
 * incompatible with GPL-3.0 and therefore with AGPL-3.0.
 */
const ALLOWED = new Set([
  '0BSD',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/**
 * Packages accepted despite an unrecognized licence string, each with a reason.
 *
 * Every entry is a decision somebody made and can be asked about later. An
 * empty list is the healthy state.
 */
const REVIEWED_EXCEPTIONS: Readonly<Record<string, string>> = {};

interface LicenseEntry {
  readonly name: string;
  readonly versions?: readonly string[];
  readonly license?: string;
}

function collect(): Map<string, LicenseEntry[]> {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod', '--recursive'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const parsed = JSON.parse(raw) as Record<string, LicenseEntry[]>;
  return new Map(Object.entries(parsed));
}

/**
 * Splits an SPDX expression into the licences it offers a choice between.
 *
 * A dual licence such as "MIT OR Apache-2.0" is satisfied if either side is
 * acceptable, because the recipient picks. "MIT AND X" is not: both apply, so
 * both must be acceptable. Treating them the same would quietly accept a
 * licence this project cannot use.
 */
function alternatives(expression: string): string[] {
  const normalized = expression.replace(/[()]/g, ' ').trim();

  if (/\bAND\b/i.test(normalized)) {
    // Every term of a conjunction must pass, so return them all and let the
    // caller require all of them.
    return normalized.split(/\s+AND\s+/i).map((part) => part.trim());
  }

  return normalized.split(/\s+OR\s+/i).map((part) => part.trim());
}

function isAcceptable(expression: string): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0 || /^(unknown|unlicensed|see license)/i.test(trimmed)) {
    return false;
  }

  const parts = alternatives(trimmed);

  return /\bAND\b/i.test(trimmed)
    ? parts.every((part) => ALLOWED.has(part))
    : parts.some((part) => ALLOWED.has(part));
}

function main(): void {
  const byLicense = collect();
  const problems: string[] = [];

  for (const [license, packages] of byLicense) {
    if (isAcceptable(license)) {
      continue;
    }

    for (const entry of packages) {
      const reason = REVIEWED_EXCEPTIONS[entry.name];
      if (reason !== undefined) {
        console.warn(`allowed by review: ${entry.name} (${license}) — ${reason}`);
        continue;
      }
      problems.push(`${entry.name} @ ${(entry.versions ?? []).join(', ')} is ${license}`);
    }
  }

  if (problems.length > 0) {
    console.error(
      'These dependencies are under licences that AGPL-3.0-only cannot incorporate,\n' +
        'or that declare no licence at all:\n',
    );
    for (const problem of problems.sort()) {
      console.error(`  ${problem}`);
    }
    console.error(
      '\nReplace the dependency, or add a reviewed exception with a reason in\n' +
        'scripts/check-licenses.ts. Do not widen the allowlist without reading the licence.',
    );
    process.exitCode = 1;
    return;
  }

  const total = [...byLicense.values()].reduce((count, entries) => count + entries.length, 0);
  console.warn(
    `${String(total)} production dependencies across ${String(byLicense.size)} licences, all compatible with AGPL-3.0-only.`,
  );
}

main();
