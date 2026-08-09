import { decryptSecret, encryptSecret, type Keyring } from '@eim/crypto';
import { shippingAccountSecrets, type Database, type ShippingSecretType } from '@eim/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Custody of a shipping account's API key (sections 19, 34).
 *
 * The same rules as every other provider credential in this application, and
 * for the same reasons: the caller asks for "the key for this account" and gets
 * a string, never a ciphertext, never a key version, and never an opportunity to
 * write a plaintext key into a column. The encryption context binds each
 * ciphertext to the business, the account, and the kind of key, so a ciphertext
 * moved between rows fails to decrypt rather than quietly authenticating as
 * somebody else's postage account.
 *
 * A separate store from `@eim/integrations`' rather than a shared one, because
 * the rows live in a different table with a foreign key to a different parent.
 * Merging them would mean two nullable parent columns and a check that exactly
 * one is set — a shape in which neither reference is properly enforced, and one
 * that reads to whoever finds it as something nobody meant.
 *
 * What is shared is the thing worth sharing: `@eim/crypto` does the encryption,
 * so there is one implementation of the envelope and one place where the
 * keyring is understood.
 */

export interface ShippingAccountRef {
  readonly businessId: string;
  readonly accountId: string;
}

export interface PutShippingSecret extends ShippingAccountRef {
  readonly secretType: ShippingSecretType;
  readonly value: string;
  readonly now?: Date;
}

export interface ShippingSecretDescription {
  readonly id: string;
  readonly keyVersion: number;
  readonly createdAt: Date;
}

export interface ShippingSecretStore {
  /** Stores a key, retiring whatever it replaces, in one transaction. */
  put(input: PutShippingSecret): Promise<string>;
  /** The current key, or null when the account has none. */
  read(account: ShippingAccountRef, secretType: ShippingSecretType): Promise<string | null>;
  /** What is known about the current key, without decrypting it. */
  describe(
    account: ShippingAccountRef,
    secretType: ShippingSecretType,
  ): Promise<ShippingSecretDescription | null>;
  /** Retires the current key without storing a replacement. */
  retire(account: ShippingAccountRef, secretType: ShippingSecretType): Promise<void>;
}

export interface ShippingSecretStoreOptions {
  readonly db: Database;
  readonly keyring: Keyring;
}

/** Which secret a provider's key is stored as. One key per provider. */
export function secretTypeFor(provider: 'easypost' | 'easyship'): ShippingSecretType {
  return provider === 'easypost' ? 'easypost_api_key' : 'easyship_api_key';
}

export function createShippingSecretStore(
  options: ShippingSecretStoreOptions,
): ShippingSecretStore {
  const { db, keyring } = options;

  const contextFor = (account: ShippingAccountRef, secretType: ShippingSecretType) => ({
    businessId: account.businessId,
    resource: `shipping_account:${account.accountId}`,
    secretType,
  });

  const current = (account: ShippingAccountRef, secretType: ShippingSecretType) =>
    db
      .select()
      .from(shippingAccountSecrets)
      .where(
        and(
          eq(shippingAccountSecrets.accountId, account.accountId),
          eq(shippingAccountSecrets.businessId, account.businessId),
          eq(shippingAccountSecrets.secretType, secretType),
          isNull(shippingAccountSecrets.retiredAt),
        ),
      )
      .limit(1);

  return {
    async put(input) {
      const now = input.now ?? new Date();
      const ciphertext = encryptSecret(keyring, contextFor(input, input.secretType), input.value);

      // One transaction, because the partial unique index permits exactly one
      // unretired key per account. Retiring and inserting separately would leave
      // a window in which the account has no credential at all, and postage
      // bought in that window would fail for a reason nobody could reconstruct.
      return db.transaction(async (tx) => {
        await tx
          .update(shippingAccountSecrets)
          .set({ retiredAt: now })
          .where(
            and(
              eq(shippingAccountSecrets.accountId, input.accountId),
              eq(shippingAccountSecrets.secretType, input.secretType),
              isNull(shippingAccountSecrets.retiredAt),
            ),
          );

        const [row] = await tx
          .insert(shippingAccountSecrets)
          .values({
            businessId: input.businessId,
            accountId: input.accountId,
            secretType: input.secretType,
            ciphertext,
            keyVersion: keyring.active().version,
          })
          .returning({ id: shippingAccountSecrets.id });

        if (row === undefined) {
          throw new Error('the shipping credential could not be stored');
        }

        return row.id;
      });
    },

    async read(account, secretType) {
      const [row] = await current(account, secretType);

      if (row === undefined) {
        return null;
      }

      // Not wrapped in a try. A ciphertext that will not decrypt means the
      // keyring is wrong or the row has been moved, and both must stop the
      // caller rather than look like "no key configured yet".
      return decryptSecret(keyring, contextFor(account, secretType), row.ciphertext);
    },

    async describe(account, secretType) {
      const [row] = await current(account, secretType);

      return row === undefined
        ? null
        : { id: row.id, keyVersion: row.keyVersion, createdAt: row.createdAt };
    },

    async retire(account, secretType) {
      await db
        .update(shippingAccountSecrets)
        .set({ retiredAt: new Date() })
        .where(
          and(
            eq(shippingAccountSecrets.accountId, account.accountId),
            eq(shippingAccountSecrets.businessId, account.businessId),
            eq(shippingAccountSecrets.secretType, secretType),
            isNull(shippingAccountSecrets.retiredAt),
          ),
        );
    },
  };
}
