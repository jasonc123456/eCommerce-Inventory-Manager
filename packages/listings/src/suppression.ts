/**
 * Whether a copied order can be kept from decrementing the shop twice
 * (section 11, verification V-03).
 *
 * This module is a gate rather than a feature, and it is currently closed.
 *
 * Section 11 permits the manual eBay-to-WooCommerce order copy and then attaches
 * a condition to it that is easy to skim past and impossible to work around:
 * creating the copy in a qualifying status makes WooCommerce run its own stock
 * reduction, on top of the projection the original eBay sale already wrote. The
 * canonical ledger is unaffected — it committed once, on the channel the sale
 * actually happened on — but the store's own numbers drop twice. The paragraph
 * ends by deciding what to do about that, in terms this module implements
 * literally: "the exact supported suppression technique for the tested
 * WooCommerce versions is proven under V-03 before the action is enabled; if no
 * reliable technique exists for a version, the copy action is unavailable on
 * that version instead of shipping a known double decrement."
 *
 * V-03 has not been carried out. It requires a real WooCommerce of each
 * supported version, orders placed against it, and the stock behaviour observed
 * — none of which can be inferred from documentation, and all of which changes
 * between minor releases of WooCommerce. So every technique below is recorded
 * with `verified: false`, and the copy action refuses on every version.
 *
 * That refusal is the correct behaviour, not a placeholder. The alternative is
 * an action that quietly halves a shopkeeper's stock figures, and the whole
 * mechanism around it exists to prevent exactly that class of thing. Turning it
 * on is a deliberate edit to this table with evidence attached, made by somebody
 * who has run the verification — which is a change a reviewer can see, rather
 * than a flag somebody set.
 */

export interface SuppressionTechnique {
  /** How this store is asked to avoid its own reduction. */
  readonly name: string;
  /** Which WooCommerce versions it was tested against, inclusive. */
  readonly minimumVersion: string;
  readonly maximumVersion?: string;
  /**
   * Whether V-03 has actually been run for this technique and version range.
   *
   * A comment claiming a technique works is not verification. Until somebody has
   * created an order against a real store of this version and observed that the
   * stock did not move, this stays false and the action stays unavailable.
   */
  readonly verified: boolean;
  /** Where the evidence lives, once there is any. */
  readonly evidence?: string;
}

/**
 * The techniques worth testing when V-03 is run, and their status.
 *
 * Listed rather than left empty so that the verification has something concrete
 * to test and so a reader can see what was considered. None is in use.
 */
export const SUPPRESSION_TECHNIQUES: readonly SuppressionTechnique[] = [
  {
    // Create the order in a non-qualifying status, then transition it, which on
    // some versions does not re-run the reduction. Plausible and version-
    // sensitive, which is exactly the kind of thing that has to be measured.
    name: 'create_then_transition',
    minimumVersion: '8.0.0',
    verified: false,
  },
  {
    // WooCommerce marks an order as having had its stock reduced. Setting that
    // marker before the transition is the technique most often cited; whether it
    // is honoured through the REST API, and on which versions, is the question.
    name: 'mark_order_stock_reduced',
    minimumVersion: '8.0.0',
    verified: false,
  },
];

export type OrderCopySupport =
  | { readonly supported: true; readonly technique: SuppressionTechnique }
  | { readonly supported: false; readonly reason: string };

/** Compares dotted versions numerically, so 8.10 is after 8.9 rather than before. */
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10));
  const b = right.split('.').map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const first = a[index] ?? 0;
    const second = b[index] ?? 0;
    if (Number.isNaN(first) || Number.isNaN(second)) {
      return Number.NaN;
    }
    if (first !== second) {
      return first < second ? -1 : 1;
    }
  }

  return 0;
}

function covers(technique: SuppressionTechnique, version: string): boolean {
  const atLeast = compareVersions(version, technique.minimumVersion);
  if (Number.isNaN(atLeast) || atLeast < 0) {
    return false;
  }
  if (technique.maximumVersion === undefined) {
    return true;
  }
  const atMost = compareVersions(version, technique.maximumVersion);
  return !Number.isNaN(atMost) && atMost <= 0;
}

/**
 * Whether the copy action may be offered for a store of this version.
 *
 * The catalogue is a parameter so a test can supply a verified technique and
 * exercise the path that runs when V-03 has been done. The default is the real
 * table, which refuses.
 */
export function assessOrderCopySupport(
  wooVersion: string | null,
  techniques: readonly SuppressionTechnique[] = SUPPRESSION_TECHNIQUES,
): OrderCopySupport {
  if (wooVersion === null || wooVersion === '') {
    return {
      supported: false,
      reason:
        'this store’s WooCommerce version is not known, and the copy cannot be made safe without knowing it',
    };
  }

  const applicable = techniques.filter((technique) => covers(technique, wooVersion));
  if (applicable.length === 0) {
    return {
      supported: false,
      reason: `no stock-reduction suppression technique has been tested against WooCommerce ${wooVersion}`,
    };
  }

  const verified = applicable.find((technique) => technique.verified);
  if (verified === undefined) {
    return {
      supported: false,
      reason: `stock-reduction suppression has not been verified against WooCommerce ${wooVersion} (verification V-03), so copying an order here would decrement this store’s figures a second time`,
    };
  }

  return { supported: true, technique: verified };
}
