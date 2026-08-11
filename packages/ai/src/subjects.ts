import { canonicalItems, providerItems, type Database } from '@eim/db';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';

import type { DraftSubjectText, KitSubjectText, MappingSubjectText } from './request';

/**
 * Turning shop records into the text a model is shown (sections 7, 10, 11, 18).
 *
 * This module is where the privacy claim becomes checkable rather than
 * aspirational. Every field a model ever sees is selected here, by name, from
 * two tables — the canonical catalogue and the imported channel mirror — and
 * neither of those holds a buyer, an address, or an order. The milestone 7 exit
 * gate asserts that no order table is reachable from this package at all, which
 * is a statement about these queries.
 *
 * Two omissions are on purpose and are the same omission twice.
 *
 * *No identifiers leave.* Components and candidates are offered by name. An
 * identifier handed to a model comes back looking authoritative, and a caller
 * that trusted a returned identifier would be letting the model choose the row
 * rather than suggest the answer. A returned name has to be matched against the
 * catalogue by the person reading it, which is exactly what sections 7 and 10
 * require: every mapping needs approval, and only an administrator saves a
 * recipe.
 *
 * *No prices, quantities, or SKUs leave.* Not because a model would misuse them
 * — because it would repeat them, and a repeated fact reads on screen as a
 * suggested one. `provider_items` carries all three; none is selected.
 */

export interface DraftSubjectInput {
  readonly businessId: string;
  readonly canonicalItemId: string;
  readonly destination: 'ebay' | 'woocommerce';
  /** Anything the destination needs that the source cannot supply. */
  readonly missingFields?: readonly string[];
  /** Image addresses from the source record, for a request that asked. */
  readonly imageUrls?: readonly string[];
}

export class SubjectNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubjectNotFound';
  }
}

/** The catalogue text for one item being turned into a draft. */
export async function draftSubjectFor(
  db: Database,
  input: DraftSubjectInput,
): Promise<DraftSubjectText> {
  const rows = await db
    .select({ name: canonicalItems.name, description: canonicalItems.description })
    .from(canonicalItems)
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        eq(canonicalItems.id, input.canonicalItemId),
      ),
    )
    .limit(1);

  const item = rows[0];
  if (item === undefined) {
    throw new SubjectNotFound('no such item in this business');
  }

  return {
    kind: 'draft_fields',
    destination: input.destination,
    title: item.name,
    ...(item.description === null ? {} : { description: item.description }),
    ...(input.missingFields === undefined ? {} : { missingFields: input.missingFields }),
    ...(input.imageUrls === undefined ? {} : { imageUrls: input.imageUrls }),
  };
}

export interface KitSubjectInput {
  readonly businessId: string;
  readonly kitCanonicalItemId: string;
  /** How many candidate components to offer. Bounded so a prompt stays small. */
  readonly limit?: number;
}

/**
 * The kit, and the components a business actually has.
 *
 * Offering the catalogue is what makes the answer usable: a model asked to
 * invent components invents plausible ones that nobody stocks, and a person then
 * has to work out which of them exist. Offering names it can choose from turns
 * the question into a matching exercise, which is the kind a model is good at
 * and a person can check quickly.
 */
export async function kitSubjectFor(db: Database, input: KitSubjectInput): Promise<KitSubjectText> {
  const rows = await db
    .select({ name: canonicalItems.name, description: canonicalItems.description })
    .from(canonicalItems)
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        eq(canonicalItems.id, input.kitCanonicalItemId),
      ),
    )
    .limit(1);

  const kit = rows[0];
  if (kit === undefined) {
    throw new SubjectNotFound('no such kit in this business');
  }

  const components = await db
    .select({ name: canonicalItems.name })
    .from(canonicalItems)
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        // A kit is not a component of another kit (section 10: a kit has no
        // independent stock), and neither is the kit itself.
        eq(canonicalItems.isKit, false),
        eq(canonicalItems.isActive, true),
        isNull(canonicalItems.deletedAt),
        ne(canonicalItems.id, input.kitCanonicalItemId),
      ),
    )
    .orderBy(asc(canonicalItems.name))
    .limit(input.limit ?? 100);

  return {
    kind: 'kit_recipe',
    title: kit.name,
    ...(kit.description === null ? {} : { description: kit.description }),
    availableComponents: components.map((component) => component.name),
  };
}

export interface MappingSubjectInput {
  readonly businessId: string;
  readonly providerItemId: string;
  readonly limit?: number;
}

/**
 * A channel listing, and the shop items it might be.
 *
 * The listing's title travels and its SKU, price, and quantity do not. Section 7
 * already treats an exact SKU match as a suggestion the application makes for
 * itself, deterministically and without a model; asking a model to look at a SKU
 * would be asking it to redo, unreliably, something already done reliably.
 */
export async function mappingSubjectFor(
  db: Database,
  input: MappingSubjectInput,
): Promise<MappingSubjectText> {
  const rows = await db
    .select({ title: providerItems.title })
    .from(providerItems)
    .where(
      and(
        eq(providerItems.businessId, input.businessId),
        eq(providerItems.id, input.providerItemId),
      ),
    )
    .limit(1);

  const entity = rows[0];
  if (entity === undefined) {
    throw new SubjectNotFound('no such channel entity in this business');
  }

  const candidates = await db
    .select({ name: canonicalItems.name })
    .from(canonicalItems)
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        eq(canonicalItems.isActive, true),
        isNull(canonicalItems.deletedAt),
      ),
    )
    .orderBy(asc(canonicalItems.name))
    .limit(input.limit ?? 100);

  return {
    kind: 'mapping_candidates',
    channelEntityTitle: entity.title ?? '(the channel record has no title)',
    candidateItems: candidates.map((candidate) => candidate.name),
  };
}
