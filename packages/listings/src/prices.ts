import type { AuditRecorder } from '@eim/audit';
import type { Database } from '@eim/db';
import {
  describeFailure,
  isSuccess,
  type ChannelAdapter,
  type ChannelEntityRef,
  type FeeLine,
} from '@eim/providers';

import type { FingerprintValue } from './fingerprint';
import { isAmount, isSameAmount, percentageDifference, subtractAmounts } from './money';
import {
  beginExecution,
  completeExecution,
  failExecution,
  proposeOperation,
  type ProposedOperation,
} from './review';

/**
 * Comparing prices, and changing one of them exactly once (sections 4, 13, 14, 30).
 *
 * Both platforms say the same thing about prices, and it is the sentence this
 * module is built around: they are "observed channel values, not canonical
 * inventory state". This application never owns a price. It can show you two of
 * them side by side, and it can carry one across when a person with
 * `change_prices` looks at both numbers and says so — once.
 *
 * Section 14 adds the rule that makes the comparison honest: "external price
 * edits refresh comparisons and are not overwritten automatically". Somebody
 * editing a price in their own shop is the normal case, not drift to be
 * corrected, so the edit changes what the comparison says rather than being
 * undone by it. The freshness window and the fingerprint are how that survives
 * contact with a confirmation screen somebody left open.
 *
 * Section 4 decides the cross-currency case, and this module does not
 * reinterpret it: "direct price copying is allowed when currencies match. Cross-
 * currency changes require a manually entered and confirmed destination amount."
 * There is no conversion here, no rate, and no default — because a rate this
 * application invented would be a rate somebody's margin quietly depended on.
 */

export interface PriceSide {
  /** Which channel this is, for the screen. */
  readonly label: string;
  readonly amount: string;
  readonly currency: string;
  readonly salePriceAmount?: string;
  readonly observedAt?: Date;
}

export interface PriceComparison {
  readonly source: PriceSide;
  readonly destination: PriceSide;
  readonly currenciesMatch: boolean;
  /** `destination - source`, only when the currencies are the same. */
  readonly difference?: string;
  /** How far the destination is from the source, to two places. */
  readonly percentageDifference?: string;
  readonly identical: boolean;
  readonly warnings: readonly string[];
}

/** Builds the side-by-side view. Reads nothing and writes nothing. */
export function comparePrices(source: PriceSide, destination: PriceSide): PriceComparison {
  const currenciesMatch = source.currency === destination.currency;
  const warnings: string[] = [];

  if (!currenciesMatch) {
    warnings.push(
      `these listings are priced in different currencies (${source.currency} and ${destination.currency}); a destination amount must be entered rather than copied`,
    );
  }

  if (destination.salePriceAmount !== undefined) {
    // Section 14 requires sale-price implications to be shown. Raising a regular
    // price that a sale price is currently undercutting changes nothing a
    // customer sees, and somebody confirming that should know it.
    warnings.push(
      `a sale price of ${destination.salePriceAmount} is currently in effect on ${destination.label} and will keep overriding the regular price`,
    );
  }

  const comparable = currenciesMatch && isAmount(source.amount) && isAmount(destination.amount);
  const identical = comparable && isSameAmount(source.amount, destination.amount);
  const percentage = comparable ? percentageDifference(destination.amount, source.amount) : null;

  return {
    source,
    destination,
    currenciesMatch,
    identical,
    ...(comparable ? { difference: subtractAmounts(source.amount, destination.amount) } : {}),
    ...(percentage === null ? {} : { percentageDifference: percentage }),
    warnings,
  };
}

export class PriceCopyRefused extends Error {
  public readonly verdict: string;

  constructor(message: string, verdict: string) {
    super(message);
    this.name = 'PriceCopyRefused';
    this.verdict = verdict;
  }
}

export interface ProposePriceCopyInput {
  readonly businessId: string;
  readonly mappingId?: string;
  readonly canonicalItemId?: string;
  /** Where the price is being read from, for the comparison. */
  readonly source: PriceSide;
  readonly destinationConnectionId: string;
  readonly destinationEntity: ChannelEntityRef;
  readonly destinationLabel: string;
  readonly adapter: ChannelAdapter;
  /**
   * The amount to set, when the currencies differ.
   *
   * Required in that case and refused in the matching case, both by section 4.
   * A field that is optional in both directions is a field somebody eventually
   * fills in with a converted number this application then has to stand behind.
   */
  readonly destinationAmount?: string;
  readonly actorUserId: string;
  readonly now?: Date;
}

export interface ProposedPriceCopy extends ProposedOperation {
  readonly comparison: PriceComparison;
  readonly newAmount: string;
  readonly fees: readonly FeeLine[];
  readonly totalFees?: string;
  readonly warnings: readonly string[];
}

/**
 * Reads the destination price, compares, quotes the fees, and records a
 * proposal.
 *
 * The read happens here rather than being passed in, and that is the point of
 * the whole module: the comparison somebody confirms must be against what the
 * channel says now, not against what an import saw last night.
 */
export async function proposePriceCopy(
  db: Database,
  audit: AuditRecorder,
  input: ProposePriceCopyInput,
): Promise<ProposedPriceCopy> {
  const observedAt = input.now ?? new Date();
  const observation = await input.adapter.listingOperations?.readPrice?.(input.destinationEntity);

  if (observation === undefined) {
    throw new PriceCopyRefused('this channel does not expose prices', 'unsupported');
  }
  if (!isSuccess(observation)) {
    throw new PriceCopyRefused(describeFailure(observation), 'provider');
  }

  const destination: PriceSide = {
    label: input.destinationLabel,
    amount: observation.value.amount,
    currency: observation.value.currency,
    ...(observation.value.salePriceAmount === undefined
      ? {}
      : { salePriceAmount: observation.value.salePriceAmount }),
    observedAt,
  };

  const comparison = comparePrices(input.source, destination);
  const newAmount = resolveNewAmount(comparison, input.destinationAmount);

  if (comparison.currenciesMatch && isSameAmount(newAmount, destination.amount)) {
    // Nothing to agree to. Offering a confirmation that changes nothing trains
    // people to confirm without reading, which is the failure this whole
    // mechanism exists to prevent.
    throw new PriceCopyRefused('this price is already what it would be changed to', 'no_change');
  }

  const write = {
    entity: input.destinationEntity,
    amount: newAmount,
    currency: destination.currency,
    idempotencyKey: `price:${input.businessId}:${input.destinationEntity.externalId}:${String(observedAt.getTime())}`,
  };

  const quote = await input.adapter.listingOperations?.previewPriceChange?.(write);
  if (quote === undefined) {
    throw new PriceCopyRefused(
      'this channel cannot quote the fee impact of a price',
      'unsupported',
    );
  }
  if (!isSuccess(quote)) {
    throw new PriceCopyRefused(describeFailure(quote), 'provider');
  }
  if (quote.value.blockers.length > 0) {
    throw new PriceCopyRefused(
      `the provider would refuse this price: ${quote.value.blockers.join('; ')}`,
      'blocked',
    );
  }

  const decisive: FingerprintValue = {
    entity: input.destinationEntity.externalId,
    variation: input.destinationEntity.variationId ?? null,
    from: destination.amount,
    to: newAmount,
    currency: destination.currency,
    // Both are part of what is being agreed to. A sale price that appeared since
    // the screen was drawn changes what the customer will actually pay, and fees
    // are AC-10's own words.
    salePrice: destination.salePriceAmount ?? null,
    fees: quote.value.fees.map((fee) => ({
      label: fee.label,
      amount: fee.amount,
      currency: fee.currency,
    })),
  };

  const proposal = await proposeOperation(db, {
    businessId: input.businessId,
    kind: 'price_copy',
    subjectKey: `price:${input.destinationEntity.externalId}${
      input.destinationEntity.variationId === undefined
        ? ''
        : `:${input.destinationEntity.variationId}`
    }`,
    requiredPermission: 'change_prices',
    preview: {
      source: input.source,
      destination,
      newAmount,
      difference: comparison.difference,
      percentageDifference: comparison.percentageDifference,
      fees: quote.value.fees,
      totalFees: quote.value.totalAmount,
      warnings: [...comparison.warnings, ...quote.value.warnings],
    },
    decisive,
    sourceObservedAt: observedAt,
    proposedByUserId: input.actorUserId,
    idempotencyKey: write.idempotencyKey,
    destinationConnectionId: input.destinationConnectionId,
    externalReference: input.destinationEntity.externalId,
    ...(input.mappingId === undefined ? {} : { mappingId: input.mappingId }),
    ...(input.canonicalItemId === undefined ? {} : { canonicalItemId: input.canonicalItemId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  await audit.record(db, {
    action: 'listing.operation.proposed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: proposal.operationId,
    detail: {
      kind: 'price_copy',
      from: destination.amount,
      to: newAmount,
      currency: destination.currency,
    },
  });

  return {
    ...proposal,
    comparison,
    newAmount,
    fees: quote.value.fees,
    ...(quote.value.totalAmount === undefined ? {} : { totalFees: quote.value.totalAmount }),
    warnings: [...comparison.warnings, ...quote.value.warnings],
  };
}

/**
 * Which number is being written, and whether the caller was allowed to choose it.
 *
 * Section 4 permits a direct copy only when the currencies match, and requires a
 * manually entered amount when they do not. Both halves are refusals: supplying
 * an amount in the matching case would let a screen quietly substitute a
 * different number for the one it was comparing.
 */
function resolveNewAmount(comparison: PriceComparison, supplied: string | undefined): string {
  if (comparison.currenciesMatch) {
    if (supplied !== undefined && !isSameAmount(supplied, comparison.source.amount)) {
      throw new PriceCopyRefused(
        'these listings share a currency, so the source price is copied directly rather than typed',
        'amount_not_permitted',
      );
    }
    return comparison.source.amount;
  }

  if (supplied === undefined) {
    throw new PriceCopyRefused(
      'these listings are priced in different currencies, so a destination amount must be entered',
      'amount_required',
    );
  }
  if (!isAmount(supplied)) {
    throw new PriceCopyRefused(`${supplied} is not an amount`, 'amount_invalid');
  }

  return supplied;
}

export interface ExecutePriceCopyInput {
  readonly businessId: string;
  readonly operationId: string;
  readonly adapter: ChannelAdapter;
}

export interface AppliedPriceCopy {
  readonly amount: string;
  readonly currency: string;
  readonly unchanged: boolean;
}

/** Writes the one price a person confirmed. */
export async function executePriceCopy(
  db: Database,
  audit: AuditRecorder,
  input: ExecutePriceCopyInput,
): Promise<AppliedPriceCopy> {
  const operation = await beginExecution(db, input);
  if (operation === null) {
    throw new PriceCopyRefused(
      'this price change has not been confirmed, or has already run',
      'state',
    );
  }

  const preview = operation.preview as {
    newAmount?: unknown;
    destination?: { currency?: unknown };
  };
  const amount = preview.newAmount;
  const currency = preview.destination?.currency;
  const externalId = operation.externalReference;

  if (typeof amount !== 'string' || typeof currency !== 'string' || externalId === null) {
    await failExecution(db, { ...input, summary: 'the confirmed operation is incomplete' });
    throw new PriceCopyRefused('the confirmed operation is incomplete', 'state');
  }

  const result = await input.adapter.listingOperations?.writePrice?.({
    entity: { externalId },
    amount,
    currency,
    idempotencyKey: operation.idempotencyKey,
  });

  if (result === undefined) {
    await failExecution(db, { ...input, summary: 'this channel cannot write prices' });
    throw new PriceCopyRefused('this channel cannot write prices', 'unsupported');
  }
  if (!isSuccess(result)) {
    await failExecution(db, { ...input, summary: describeFailure(result) });
    throw new PriceCopyRefused(describeFailure(result), 'provider');
  }

  await completeExecution(db, {
    ...input,
    outcome: {
      amount: result.value.amount,
      currency: result.value.currency,
      unchanged: result.value.unchanged,
    },
  });

  await audit.record(db, {
    action: 'listing.price.changed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: input.operationId,
    detail: {
      externalId,
      amount: result.value.amount,
      currency: result.value.currency,
      unchanged: result.value.unchanged,
    },
  });

  return {
    amount: result.value.amount,
    currency: result.value.currency,
    unchanged: result.value.unchanged,
  };
}
