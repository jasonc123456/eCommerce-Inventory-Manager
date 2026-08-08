import { reviewedOperationKinds } from '@eim/db';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { assessFreshness, reviewWindowFor, sourceAgeMs } from './freshness';

/**
 * How long a review stays valid (sections 3, 13, 14, 30).
 *
 * The rule worth proving is one-directional: a stale read is never reported as
 * fresh. Reporting a fresh read as stale costs somebody a second look at a
 * screen; the other way round applies a price, a publication, or a restock to
 * numbers nobody saw.
 */

const MINUTE = 60_000;
const base = new Date('2026-03-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);

describe('reviewWindowFor', () => {
  it('has a window for every kind of operation', () => {
    for (const kind of reviewedOperationKinds) {
      const window = reviewWindowFor(kind);
      expect(window.sourceMaxAgeMs).toBeGreaterThan(0);
      expect(window.proposalTtlMs).toBeGreaterThan(0);
    }
  });

  it('never lets a source read outlive the proposal that carries it', () => {
    // A proposal that can be confirmed after its own values have gone stale is
    // a proposal whose freshness rule does nothing.
    for (const kind of reviewedOperationKinds) {
      const window = reviewWindowFor(kind);
      expect(window.sourceMaxAgeMs).toBeLessThanOrEqual(window.proposalTtlMs);
    }
  });

  it('gives the volatile things the shortest windows', () => {
    // A price and a quantity can both change while somebody is reading about
    // them. A product's title cannot, in any way that matters.
    expect(reviewWindowFor('price_copy').sourceMaxAgeMs).toBeLessThan(
      reviewWindowFor('draft_create').sourceMaxAgeMs,
    );
    expect(reviewWindowFor('restock_to_live').sourceMaxAgeMs).toBeLessThan(
      reviewWindowFor('draft_create').sourceMaxAgeMs,
    );
  });
});

describe('assessFreshness', () => {
  const window = { sourceMaxAgeMs: 5 * MINUTE };

  it('passes a proposal read moments ago', () => {
    expect(
      assessFreshness({
        sourceObservedAt: at(0),
        ...window,
        expiresAt: at(15 * MINUTE),
        now: at(MINUTE),
      }),
    ).toBe('fresh');
  });

  it('refuses a read older than the window', () => {
    expect(
      assessFreshness({
        sourceObservedAt: at(0),
        ...window,
        expiresAt: at(15 * MINUTE),
        now: at(5 * MINUTE + 1),
      }),
    ).toBe('stale_source');
  });

  it('accepts a read at exactly the window', () => {
    // A window described as five minutes that refuses at five minutes is a
    // window nobody can reason about.
    expect(
      assessFreshness({
        sourceObservedAt: at(0),
        ...window,
        expiresAt: at(15 * MINUTE),
        now: at(5 * MINUTE),
      }),
    ).toBe('fresh');
  });

  it('reports expiry ahead of staleness when both apply', () => {
    // The two arrive together in the ordinary case, and expiry is the one the
    // reader can act on: propose it again.
    expect(
      assessFreshness({
        sourceObservedAt: at(0),
        ...window,
        expiresAt: at(15 * MINUTE),
        now: at(20 * MINUTE),
      }),
    ).toBe('expired');
  });

  it('expires at the instant it says it does', () => {
    expect(
      assessFreshness({
        sourceObservedAt: at(15 * MINUTE),
        ...window,
        expiresAt: at(15 * MINUTE),
        now: at(15 * MINUTE),
      }),
    ).toBe('expired');
  });

  it('does not extend the window for a provider clock running ahead', () => {
    // A read stamped in the future is skew, not evidence. It must not buy the
    // proposal extra life.
    expect(
      assessFreshness({
        sourceObservedAt: at(30 * MINUTE),
        ...window,
        expiresAt: at(15 * MINUTE),
        now: at(MINUTE),
      }),
    ).toBe('fresh');
  });

  it('never calls a read fresh once it is past the window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 * MINUTE }),
        fc.integer({ min: 1, max: 30 * MINUTE }),
        (elapsedMs, maxAgeMs) => {
          const verdict = assessFreshness({
            sourceObservedAt: at(0),
            sourceMaxAgeMs: maxAgeMs,
            // Far enough out that expiry never masks the staleness answer.
            expiresAt: at(1_000 * MINUTE),
            now: at(elapsedMs),
          });
          expect(verdict).toBe(elapsedMs > maxAgeMs ? 'stale_source' : 'fresh');
        },
      ),
    );
  });
});

describe('sourceAgeMs', () => {
  it('measures backwards from now', () => {
    expect(sourceAgeMs(at(0), at(90_000))).toBe(90_000);
  });

  it('floors a read from the future at zero rather than reporting it negative', () => {
    expect(sourceAgeMs(at(90_000), at(0))).toBe(0);
  });
});
