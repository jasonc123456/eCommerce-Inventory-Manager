/**
 * What may become a draft on the other platform (sections 2, 3, 6, 30).
 *
 * Section 6's matrix is a decision table, and this is that table. It is here
 * rather than inline at a call site for the reason every decision table ends up
 * in its own module: the interesting rows are the refusals, and a refusal spread
 * across four call sites is a refusal that will be missing from one of them.
 *
 * The distinction the table turns on is between *excluded* and *ineligible*, and
 * it is not pedantry. An excluded type is one this application could convert and
 * deliberately does not in version 1 — eBay multi-variation listings, WooCommerce
 * variable products, auctions — so the honest message names the version, and the
 * answer may change later. An ineligible type is one where the conversion has no
 * meaning at all: a parent-level variable product exposes no per-variation
 * quantity to write, an ended eBay listing is not a listing to copy but a
 * relisting decision. Telling somebody "not yet" when the answer is "not ever"
 * wastes their afternoon; telling them "never" when the answer is "not yet"
 * loses a feature they were promised.
 *
 * Nothing here decides whether a conversion is a good idea, only whether it is
 * possible. Whether the resulting draft is worth publishing is what the review
 * is for.
 */

export type DraftPlatform = 'ebay' | 'woocommerce';

/** The WooCommerce product types section 6 has an opinion about. */
export type WooProductType =
  'simple' | 'variable' | 'variation' | 'grouped' | 'external' | 'bundle' | 'preorder';

export interface WooDraftSource {
  readonly platform: 'woocommerce';
  readonly productType: WooProductType;
  /** WooCommerce's own `manage_stock`, at whichever level this record is. */
  readonly managesStock: boolean;
  /**
   * True when a variable product holds its stock at the parent and its
   * variations inherit. Section 6 as amended by D-131 makes this ineligible:
   * there is no per-variation quantity to write, so there is nothing to map.
   */
  readonly stockManagedAtParent?: boolean;
  readonly virtual?: boolean;
  readonly downloadable?: boolean;
  readonly backordersEnabled?: boolean;
}

export type EbayListingFormat = 'fixed_price' | 'auction';
export type EbayListingState = 'active' | 'out_of_stock' | 'ended';

export interface EbayDraftSource {
  readonly platform: 'ebay';
  readonly format: EbayListingFormat;
  /** One for a single-SKU listing; more for a multi-variation one. */
  readonly variationCount: number;
  readonly state: EbayListingState;
}

/** A kit this application owns. It has no channel entity to convert from. */
export interface KitDraftSource {
  readonly platform: 'kit';
}

export type DraftSource = WooDraftSource | EbayDraftSource | KitDraftSource;

export type DraftEligibilityVerdict = 'eligible' | 'excluded' | 'ineligible';

export interface DraftEligibility {
  readonly verdict: DraftEligibilityVerdict;
  /** Plain language, written to be shown to the person who asked. */
  readonly reason: string;
  /** Things that are true and worth saying even when the answer is yes. */
  readonly warnings: readonly string[];
}

const ELIGIBLE: DraftEligibility = {
  verdict: 'eligible',
  reason: 'this can be converted to a draft on the other platform',
  warnings: [],
};

function excluded(reason: string): DraftEligibility {
  return { verdict: 'excluded', reason, warnings: [] };
}

function ineligible(reason: string): DraftEligibility {
  return { verdict: 'ineligible', reason, warnings: [] };
}

function withWarnings(base: DraftEligibility, warnings: readonly string[]): DraftEligibility {
  return warnings.length === 0 ? base : { ...base, warnings };
}

export function assessDraftEligibility(source: DraftSource): DraftEligibility {
  switch (source.platform) {
    case 'woocommerce':
      return assessWooCommerce(source);
    case 'ebay':
      return assessEbay(source);
    case 'kit':
      // Section 10: "an app-native kit may create a normal simple WooCommerce
      // draft or single-SKU fixed-price eBay unpublished offer. The destination
      // sees one sellable item; the component recipe remains internal."
      return withWarnings(ELIGIBLE, [
        'the destination will see one ordinary item; the recipe stays inside this application',
      ]);
  }
}

function assessWooCommerce(source: WooDraftSource): DraftEligibility {
  switch (source.productType) {
    case 'simple': {
      const warnings: string[] = [];

      if (!source.managesStock) {
        // Convertible, but the resulting mapping cannot synchronize until
        // WooCommerce is managing a number. Section 6: "numeric stock management
        // required for live sync".
        warnings.push(
          'WooCommerce is not managing stock for this product, so the draft can be created but the mapping will not synchronize quantities until it is',
        );
      }
      if (source.virtual === true || source.downloadable === true) {
        warnings.push(
          'a virtual or downloadable product synchronizes quantities only while WooCommerce stock management is enabled',
        );
      }
      if (source.backordersEnabled === true) {
        // Section 6: allowed with warning. The two platforms disagree about what
        // zero means, and the person converting should know before they publish.
        warnings.push(
          'this product accepts backorders; eBay cannot, so the eBay listing will clamp to zero when physical availability reaches zero',
        );
      }

      return withWarnings(ELIGIBLE, warnings);
    }

    case 'variable':
      if (source.stockManagedAtParent === true) {
        return ineligible(
          'this variable product manages stock at the parent, so no variation exposes a quantity to write; enable variation-level stock management first',
        );
      }
      return excluded(
        'variable products are excluded from draft conversion in version 1; convert the variations individually or create the destination listing by hand',
      );

    case 'variation':
      // A single variation is inventory-eligible and mappable, but converting
      // one in isolation produces a destination listing detached from its
      // siblings — which is the multi-variation case section 6 excludes,
      // arriving one row at a time.
      return excluded(
        'a single variation cannot be converted on its own in version 1; multi-variation drafts are excluded',
      );

    case 'grouped':
      return ineligible(
        'a grouped product owns no inventory of its own; convert its child products instead',
      );

    case 'external':
      return ineligible(
        'an external or affiliate product is not sold from this store, so there is no inventory to carry to a draft',
      );

    case 'bundle':
      return ineligible(
        'third-party bundle and composite products are not interpreted in version 1; their component behaviour is plugin-specific',
      );

    case 'preorder':
      return ineligible(
        'plugin-based preorder products are unsupported; their availability rules are not modelled here',
      );
  }
}

function assessEbay(source: EbayDraftSource): DraftEligibility {
  // Order matters. An ended auction should be told it has ended rather than
  // that auctions are excluded, because ending is the fact that changed and
  // relisting is the workflow they need.
  if (source.state === 'ended') {
    return ineligible(
      'this listing has ended; ending is never undone by a draft, and relisting is a separate decision',
    );
  }

  if (source.format === 'auction') {
    // Section 3, non-goal 11: auction draft creation is excluded from version 1.
    return excluded(
      'auction listings are excluded from draft conversion in version 1; their quantity behaviour is read-only',
    );
  }

  if (source.variationCount > 1) {
    // Section 3, non-goal 12.
    return excluded(
      'multi-variation listings are excluded from draft conversion in version 1; every variation would have to be carried across together',
    );
  }

  if (source.state === 'out_of_stock') {
    // Convertible. The eBay listing being out of stock says nothing about
    // whether a WooCommerce draft of it is worth making, and section 6 keeps
    // out-of-stock listings "retained and writable".
    return withWarnings(ELIGIBLE, [
      'this listing is currently out of stock on eBay; the draft carries its fields, not its availability',
    ]);
  }

  return ELIGIBLE;
}

/** Whether a verdict permits going on to build a draft. */
export function mayConvert(eligibility: DraftEligibility): boolean {
  return eligibility.verdict === 'eligible';
}
