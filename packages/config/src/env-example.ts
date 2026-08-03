import { FIELD_METADATA, FIELD_ORDER, type FieldMeta } from './fields';
import type { ConfigKey } from './schema';

/**
 * Renders `.env.example` from the schema and its metadata.
 *
 * Section 27 requires the configuration reference to be generated from the
 * validated schema rather than hand-maintained. `pnpm env:check` compares the
 * committed file against this output and fails when they diverge, so a new
 * setting cannot ship undocumented.
 */

const HEADER = `# Installation configuration for eCommerce Inventory Manager.
#
# GENERATED FILE. Edit packages/config/src/schema.ts and packages/config/src/fields.ts,
# then run: pnpm env:check --write
#
# Copy to the deployment root as .env, fill in real values, and restrict it:
#   cp .env.example /path/to/deployment/.env && chmod 600 /path/to/deployment/.env
#
# The real .env lives at the deployment root, outside this repository (D-092).
# Never commit a filled-in copy. Every value marked "secret" below must never
# appear in logs, exports, diagnostics, screenshots, or the web UI.
`;

function renderField(key: ConfigKey, meta: FieldMeta): string {
  const sensitivity = meta.sensitivity === 'public' ? '' : ` [${meta.sensitivity}]`;
  const requirement = meta.requiredInProduction ? ' [required in production]' : '';
  const banner = `#${sensitivity}${requirement}`.trimEnd();

  return [
    banner,
    ...wrap(meta.description, 76).map((line) => `# ${line}`),
    `${key}=${meta.example}`,
  ].join('\n');
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

export function renderEnvExample(): string {
  const body = FIELD_ORDER.map((key) => renderField(key, FIELD_METADATA[key])).join('\n\n');
  return `${HEADER}\n${body}\n`;
}
