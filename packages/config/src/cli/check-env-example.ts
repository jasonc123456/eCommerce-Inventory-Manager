#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderEnvExample } from '../env-example';

/**
 * Keeps the committed `.env.example` identical to what the field specifications
 * describe. Run with `--write` to regenerate after changing a field.
 *
 * This runs in the fast CI tier, so an undocumented setting fails the build
 * rather than being discovered by an operator at deployment time.
 */

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../../../.env.example');
const expected = renderEnvExample();

if (process.argv.includes('--write')) {
  writeFileSync(target, expected, 'utf8');
  console.warn(`Wrote ${target}`);
  process.exit(0);
}

let actual: string;
try {
  actual = readFileSync(target, 'utf8');
} catch {
  console.error(`.env.example is missing at ${target}. Run: pnpm env:check --write`);
  process.exit(1);
}

if (actual !== expected) {
  console.error(
    '.env.example does not match packages/config/src/fields.ts.\n' +
      'The configuration reference is generated from the schema (section 27).\n' +
      'Run: pnpm env:check --write',
  );
  process.exit(1);
}

console.warn('.env.example matches the configuration schema.');
