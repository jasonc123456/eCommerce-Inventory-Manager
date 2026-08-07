import { decryptSecret, encryptSecret, type Keyring } from '@eim/crypto';
import { connectionSecrets, type Database } from '@eim/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Custody of the credentials a connection holds (section 19).
 *
 * Everything here exists so that the rest of the application can hold a
 * connection without holding its secrets. A caller asks for "the current
 * refresh token for this connection" and gets a string; it never sees a
 * ciphertext, never chooses a key version, and never has an opportunity to
 * write a plaintext token to a column.
 *
 * The encryption context binds each ciphertext to the business, the connection,
 * and the kind of secret. That binding is checked on decryption, so a ciphertext
 * moved between rows — by a bug, by a restored backup, by somebody with database
 * access — fails to decrypt rather than quietly authenticating as the wrong
 * account.
 *
 * Rotation overlaps rather than replaces (section 14). A replacement is written
 * and proven before the old value is retired, so a rotation interrupted halfway
 * leaves a connection with a working credential rather than none.
 */

export type ConnectionSecretType = (typeof connectionSecrets.$inferSelect)['secretType'];

export interface SecretStore {
  /** Stores a value, retiring whatever it replaces. */
  put(input: PutSecret): Promise<string>;
  /** The current value, or null when there is none. */
  read(
    connection: ConnectionRef,
    secretType: ConnectionSecretType,
    scope?: string,
  ): Promise<string | null>;
  /** The current value with what is known about it, without decrypting. */
  describe(
    connection: ConnectionRef,
    secretType: ConnectionSecretType,
    scope?: string,
  ): Promise<SecretDescription | null>;
  /** Retires the current value without storing a replacement. */
  retire(
    connection: ConnectionRef,
    secretType: ConnectionSecretType,
    scope?: string,
  ): Promise<void>;
}

export interface ConnectionRef {
  readonly businessId: string;
  readonly connectionId: string;
}

export interface PutSecret extends ConnectionRef {
  readonly secretType: ConnectionSecretType;
  /**
   * Which of several secrets of this kind this is.
   *
   * Every kind but one has exactly one live value per connection, and leaves
   * this unset. A webhook secret does not: section 14 requires a distinct secret
   * per managed registration, and a rotation deliberately has two live at once
   * for the same topic. The scope is the registration, not the topic, for
   * exactly that reason.
   */
  readonly scope?: string | undefined;
  readonly value: string;
  readonly expiresAt?: Date | undefined;
  readonly now?: Date;
}

export interface SecretDescription {
  readonly id: string;
  readonly keyVersion: number;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface SecretStoreOptions {
  readonly db: Database;
  readonly keyring: Keyring;
}

export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const { db, keyring } = options;

  // The scope is part of the encryption context, not just of the lookup. A
  // ciphertext moved from one webhook's row to another's — by a bug, by a
  // restored backup, by somebody with database access — then fails to decrypt
  // rather than quietly signing as the wrong registration.
  const contextFor = (
    connection: ConnectionRef,
    secretType: ConnectionSecretType,
    scope: string | undefined,
  ) => ({
    businessId: connection.businessId,
    resource:
      scope === undefined
        ? `connection:${connection.connectionId}`
        : `connection:${connection.connectionId}/${scope}`,
    secretType,
  });

  const current = (
    connection: ConnectionRef,
    secretType: ConnectionSecretType,
    scope: string | undefined,
  ) =>
    db
      .select()
      .from(connectionSecrets)
      .where(
        and(
          eq(connectionSecrets.connectionId, connection.connectionId),
          eq(connectionSecrets.businessId, connection.businessId),
          eq(connectionSecrets.secretType, secretType),
          scope === undefined
            ? isNull(connectionSecrets.secretScope)
            : eq(connectionSecrets.secretScope, scope),
          isNull(connectionSecrets.retiredAt),
        ),
      )
      .limit(1);

  return {
    async put(input) {
      const now = input.now ?? new Date();
      const ciphertext = encryptSecret(
        keyring,
        contextFor(input, input.secretType, input.scope),
        input.value,
      );

      // One transaction, because the partial unique index permits exactly one
      // unretired secret of each kind: retiring and inserting separately would
      // leave a window where a concurrent write could take the slot, and a
      // window where the connection has no credential at all.
      return db.transaction(async (tx) => {
        await tx
          .update(connectionSecrets)
          .set({ retiredAt: now })
          .where(
            and(
              eq(connectionSecrets.connectionId, input.connectionId),
              eq(connectionSecrets.secretType, input.secretType),
              input.scope === undefined
                ? isNull(connectionSecrets.secretScope)
                : eq(connectionSecrets.secretScope, input.scope),
              isNull(connectionSecrets.retiredAt),
            ),
          );

        const [row] = await tx
          .insert(connectionSecrets)
          .values({
            businessId: input.businessId,
            connectionId: input.connectionId,
            secretType: input.secretType,
            secretScope: input.scope ?? null,
            ciphertext,
            keyVersion: keyring.active().version,
            expiresAt: input.expiresAt ?? null,
          })
          .returning({ id: connectionSecrets.id });

        if (row === undefined) {
          throw new Error('the credential could not be stored');
        }

        return row.id;
      });
    },

    async read(connection, secretType, scope) {
      const [row] = await current(connection, secretType, scope);

      if (row === undefined) {
        return null;
      }

      // Not wrapped in a try: a ciphertext that will not decrypt means the
      // keyring is wrong or the row has been moved, and both are conditions
      // that must stop the caller rather than look like "no credential yet".
      return decryptSecret(keyring, contextFor(connection, secretType, scope), row.ciphertext);
    },

    async describe(connection, secretType, scope) {
      const [row] = await current(connection, secretType, scope);

      return row === undefined
        ? null
        : {
            id: row.id,
            keyVersion: row.keyVersion,
            expiresAt: row.expiresAt,
            createdAt: row.createdAt,
          };
    },

    async retire(connection, secretType, scope) {
      await db
        .update(connectionSecrets)
        .set({ retiredAt: new Date() })
        .where(
          and(
            eq(connectionSecrets.connectionId, connection.connectionId),
            eq(connectionSecrets.businessId, connection.businessId),
            eq(connectionSecrets.secretType, secretType),
            scope === undefined
              ? isNull(connectionSecrets.secretScope)
              : eq(connectionSecrets.secretScope, scope),
            isNull(connectionSecrets.retiredAt),
          ),
        );
    },
  };
}
