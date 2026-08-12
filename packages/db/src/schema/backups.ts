import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Typed access to the backup history (section 23).
 *
 * `migrations/0030_backup_runs.sql` is the source of truth. The checks it
 * carries are the ones a script could otherwise skip in a hurry: a success has
 * an artifact and a checksum, a failure says why, and a run that is still going
 * has no completion time.
 *
 * Nothing here can help decrypt a backup, and that is deliberate. Backups
 * encrypt to a public key whose private half lives off this host (D-143); a
 * table that held anything more would defeat the control it exists to record.
 */

export const backupKinds = ['daily', 'weekly', 'monthly', 'pre_upgrade', 'manual'] as const;
export type BackupKind = (typeof backupKinds)[number];

export const backupOutcomes = ['running', 'succeeded', 'failed'] as const;
export type BackupOutcome = (typeof backupOutcomes)[number];

export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: backupKinds }).notNull(),
    outcome: text('outcome', { enum: backupOutcomes }).notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    artifactName: text('artifact_name'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Over the encrypted artifact, so it verifies the file an operator has. */
    sha256: text('sha256'),
    failureReason: text('failure_reason'),
    /** Section 23's quarterly drill, recorded against the artifact restored. */
    restoreVerifiedAt: timestamp('restore_verified_at', { withTimezone: true }),
    restoreNotes: text('restore_notes'),
  },
  (table) => [index('backup_runs_recent').on(table.startedAt)],
);

export type BackupRun = typeof backupRuns.$inferSelect;
