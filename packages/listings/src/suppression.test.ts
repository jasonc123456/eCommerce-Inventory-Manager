import { describe, expect, it } from 'vitest';

import {
  SUPPRESSION_TECHNIQUES,
  assessOrderCopySupport,
  type SuppressionTechnique,
} from './suppression';

/**
 * The gate section 11 asks for, and the fact that it is closed.
 *
 * "If no reliable technique exists for a version, the copy action is unavailable
 * on that version instead of shipping a known double decrement." Verification
 * V-03 has not been carried out, so nothing is verified and the action is
 * unavailable everywhere. The tests assert that as a current fact rather than an
 * aspiration, so the day somebody marks a technique verified without evidence,
 * a test says so.
 */

const verified: SuppressionTechnique = {
  name: 'mark_order_stock_reduced',
  minimumVersion: '8.0.0',
  maximumVersion: '9.9.9',
  verified: true,
  evidence: 'docs/verification/v-03.md',
};

describe('the shipped technique catalogue', () => {
  it('verifies nothing, because V-03 has not been run', () => {
    // Not a placeholder. A technique marked verified without somebody having
    // watched a real store's stock not move is how the double decrement ships.
    expect(SUPPRESSION_TECHNIQUES.every((technique) => !technique.verified)).toBe(true);
  });

  it('refuses every version by default', () => {
    for (const version of ['8.0.0', '8.9.1', '9.4.2', '10.0.0']) {
      const support = assessOrderCopySupport(version);
      expect(support.supported).toBe(false);
    }
  });

  it('says why, in terms an operator can act on', () => {
    const support = assessOrderCopySupport('9.4.2');
    expect(support.supported).toBe(false);
    if (!support.supported) {
      expect(support.reason).toMatch(/V-03/);
      expect(support.reason).toMatch(/second time/);
    }
  });
});

describe('assessOrderCopySupport', () => {
  it('permits a version a verified technique covers', () => {
    const support = assessOrderCopySupport('9.4.2', [verified]);

    expect(support.supported).toBe(true);
    if (support.supported) {
      expect(support.technique.name).toBe('mark_order_stock_reduced');
    }
  });

  it('refuses a version outside the tested range', () => {
    expect(assessOrderCopySupport('7.9.0', [verified]).supported).toBe(false);
    expect(assessOrderCopySupport('10.1.0', [verified]).supported).toBe(false);
  });

  it('compares versions numerically rather than as text', () => {
    // 8.10 is after 8.9. Sorted as strings it is before it, which would refuse
    // a store that is newer than the one that was tested.
    expect(assessOrderCopySupport('8.10.0', [verified]).supported).toBe(true);
    expect(assessOrderCopySupport('8.9.0', [verified]).supported).toBe(true);
  });

  it('treats a version it cannot parse as unsupported', () => {
    expect(assessOrderCopySupport('nightly', [verified]).supported).toBe(false);
  });

  it('refuses a store whose version is unknown', () => {
    // Without knowing the version there is no way to know whether the technique
    // works, and guessing is the one thing section 11 rules out.
    for (const version of [null, '']) {
      const support = assessOrderCopySupport(version, [verified]);
      expect(support.supported).toBe(false);
      if (!support.supported) {
        expect(support.reason).toMatch(/not known/);
      }
    }
  });

  it('picks the verified technique when an unverified one also covers the version', () => {
    const support = assessOrderCopySupport('9.0.0', [
      { name: 'create_then_transition', minimumVersion: '8.0.0', verified: false },
      verified,
    ]);

    expect(support.supported).toBe(true);
    if (support.supported) {
      expect(support.technique.verified).toBe(true);
    }
  });

  it('accepts an open-ended technique with no maximum', () => {
    const support = assessOrderCopySupport('12.0.0', [
      { name: 'mark_order_stock_reduced', minimumVersion: '8.0.0', verified: true },
    ]);

    expect(support.supported).toBe(true);
  });
});
