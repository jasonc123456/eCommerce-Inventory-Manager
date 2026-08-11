import { decryptSecret, encryptSecret, type Keyring } from '@eim/crypto';
import { aiProviderSecrets, type Database } from '@eim/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Custody of a business's model API key (sections 18, 19).
 *
 * Section 19 lists "cloud AI provider API credentials" among the encrypted
 * per-business values, and the rules are the ones every other provider
 * credential in this application follows: the caller asks for "the key for this
 * configuration" and gets a string or nothing, the encryption context binds the
 * ciphertext to the business, the configuration, and the kind of secret, and a
 * ciphertext moved between rows fails to decrypt rather than quietly
 * authenticating as somebody else.
 *
 * A local Ollama usually has no key at all, which is why every path here treats
 * "no credential" as an ordinary answer rather than an error. That is also the
 * shape section 18 describes: "cloud models use business-supplied API keys;
 * local Ollama normally uses its URL".
 */

export interface AiProviderRef {
  readonly businessId: string;
  readonly providerId: string;
}

export interface PutAiSecret extends AiProviderRef {
  readonly value: string;
  readonly now?: Date;
}

export interface AiSecretDescription {
  readonly id: string;
  readonly keyVersion: number;
  readonly createdAt: Date;
}

export interface AiSecretStore {
  /** Stores a key, retiring whatever it replaces, in one transaction. */
  put(input: PutAiSecret): Promise<string>;
  /** The current key, or null when the configuration has none. */
  read(provider: AiProviderRef): Promise<string | null>;
  /** What is known about the current key, without decrypting it. */
  describe(provider: AiProviderRef): Promise<AiSecretDescription | null>;
  /** Retires the current key without storing a replacement. */
  retire(provider: AiProviderRef): Promise<void>;
}

export interface AiSecretStoreOptions {
  readonly db: Database;
  readonly keyring: Keyring;
}

export function createAiSecretStore(options: AiSecretStoreOptions): AiSecretStore {
  const { db, keyring } = options;

  const contextFor = (provider: AiProviderRef) => ({
    businessId: provider.businessId,
    resource: `ai_provider:${provider.providerId}`,
    secretType: 'ai_api_key' as const,
  });

  const current = (provider: AiProviderRef) =>
    db
      .select()
      .from(aiProviderSecrets)
      .where(
        and(
          eq(aiProviderSecrets.providerId, provider.providerId),
          eq(aiProviderSecrets.businessId, provider.businessId),
          eq(aiProviderSecrets.secretType, 'ai_api_key'),
          isNull(aiProviderSecrets.retiredAt),
        ),
      )
      .limit(1);

  return {
    async put(input) {
      const now = input.now ?? new Date();
      const ciphertext = encryptSecret(keyring, contextFor(input), input.value);

      // One transaction, because the partial unique index permits exactly one
      // unretired key per configuration. Retiring and inserting separately would
      // leave a window with no credential at all, and a suggestion asked for in
      // that window would fail for a reason nobody could reconstruct.
      return db.transaction(async (tx) => {
        await tx
          .update(aiProviderSecrets)
          .set({ retiredAt: now })
          .where(
            and(
              eq(aiProviderSecrets.providerId, input.providerId),
              eq(aiProviderSecrets.secretType, 'ai_api_key'),
              isNull(aiProviderSecrets.retiredAt),
            ),
          );

        const [row] = await tx
          .insert(aiProviderSecrets)
          .values({
            businessId: input.businessId,
            providerId: input.providerId,
            secretType: 'ai_api_key',
            ciphertext,
            keyVersion: keyring.active().version,
          })
          .returning({ id: aiProviderSecrets.id });

        if (row === undefined) {
          throw new Error('the AI credential could not be stored');
        }

        return row.id;
      });
    },

    async read(provider) {
      const [row] = await current(provider);

      if (row === undefined) {
        return null;
      }

      // Not wrapped in a try. A ciphertext that will not decrypt means the
      // keyring is wrong or the row has been moved, and both must stop the
      // caller rather than look like "this endpoint needs no key".
      return decryptSecret(keyring, contextFor(provider), row.ciphertext);
    },

    async describe(provider) {
      const [row] = await current(provider);

      return row === undefined
        ? null
        : { id: row.id, keyVersion: row.keyVersion, createdAt: row.createdAt };
    },

    async retire(provider) {
      await db
        .update(aiProviderSecrets)
        .set({ retiredAt: new Date() })
        .where(
          and(
            eq(aiProviderSecrets.providerId, provider.providerId),
            eq(aiProviderSecrets.businessId, provider.businessId),
            eq(aiProviderSecrets.secretType, 'ai_api_key'),
            isNull(aiProviderSecrets.retiredAt),
          ),
        );
    },
  };
}
