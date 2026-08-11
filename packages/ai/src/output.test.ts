import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseSuggestion, SUGGESTION_SCHEMAS, type SuggestionKind } from './output';

/**
 * Section 36's exit gate names "malformed-output" and "protected-field" tests
 * outright, and both live here: this is the boundary where an answer from a
 * language model stops being a string and starts being something the
 * application will show somebody.
 */

const KINDS: readonly SuggestionKind[] = ['draft_fields', 'kit_recipe', 'mapping_candidates'];

describe('malformed answers', () => {
  it('refuses prose', () => {
    const outcome = parseSuggestion('draft_fields', 'I think a good title would be "Blue widget".');

    expect(outcome.status).toBe('malformed');
  });

  it('refuses an empty answer', () => {
    expect(parseSuggestion('draft_fields', '').status).toBe('malformed');
  });

  it('refuses JSON that is not an object', () => {
    expect(parseSuggestion('draft_fields', '["a title"]').status).toBe('malformed');
    expect(parseSuggestion('draft_fields', '"a title"').status).toBe('malformed');
  });

  it('refuses an object with none of the fields asked for', () => {
    const outcome = parseSuggestion('draft_fields', '{"thoughts":"hmm"}');

    expect(outcome.status).toBe('malformed');
    expect(outcome.status === 'malformed' && outcome.reason).toContain('none of the fields');
  });

  it('never throws, whatever the model returned', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...KINDS), (text, kind) => {
        expect(() => parseSuggestion(kind, text)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('accepts JSON wrapped in a fenced block', () => {
    const outcome = parseSuggestion(
      'draft_fields',
      'Here you go:\n```json\n{"title":"Blue widget"}\n```\nHope that helps.',
    );

    expect(
      outcome.status === 'valid' &&
        outcome.suggestion.kind === 'draft_fields' &&
        outcome.suggestion.title,
    ).toBe('Blue widget');
  });

  it('accepts JSON with an apology after it', () => {
    const outcome = parseSuggestion(
      'draft_fields',
      '{"title":"Blue widget"} — sorry for the delay!',
    );

    expect(outcome.status).toBe('valid');
  });
});

describe('protected facts', () => {
  it('carries the fields asked for and drops a price the model volunteered', () => {
    const outcome = parseSuggestion(
      'draft_fields',
      JSON.stringify({ title: 'Blue widget', price: '4.99', sku: 'WID-1' }),
    );

    expect(outcome.status).toBe('valid');
    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    expect(outcome.suggestion.title).toBe('Blue widget');
    expect(Object.keys(outcome.suggestion)).not.toContain('price');
    expect(outcome.warnings.join(' ')).toContain('price');
    expect(outcome.warnings.join(' ')).toContain('sku');
  });

  it('drops an item detail whose name is a protected fact', () => {
    const outcome = parseSuggestion(
      'draft_fields',
      JSON.stringify({
        itemSpecifics: [
          { name: 'Colour', value: 'Blue' },
          { name: 'Condition', value: 'New' },
        ],
      }),
    );

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    expect(outcome.suggestion.itemSpecifics).toEqual([{ name: 'Colour', value: 'Blue' }]);
  });

  it('has nowhere to record a confidence, so a claimed one is ignored', () => {
    const outcome = parseSuggestion(
      'mapping_candidates',
      JSON.stringify({ candidates: [{ reference: 'Blue widget', confidence: 'high' }] }),
    );

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'mapping_candidates') {
      throw new Error('expected mapping candidates');
    }

    expect(outcome.suggestion.candidates[0]).toEqual({ reference: 'Blue widget', reason: null });
  });
});

describe('draft fields', () => {
  it('strips markup and control characters out of text', () => {
    const outcome = parseSuggestion(
      'draft_fields',
      JSON.stringify({ title: '<b>Blue</b> widget', description: 'A  widget.\n\nBlue.' }),
    );

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    expect(outcome.suggestion.title).toBe('Blue widget');
    expect(outcome.suggestion.description).toBe('A widget. Blue.');
  });

  it('truncates rather than storing an unbounded answer', () => {
    const outcome = parseSuggestion('draft_fields', JSON.stringify({ title: 'x'.repeat(5_000) }));

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    expect(outcome.suggestion.title?.length).toBe(200);
  });

  it('ignores a list entry that is not text', () => {
    const outcome = parseSuggestion(
      'draft_fields',
      JSON.stringify({ tags: ['widget', 42, null, { a: 1 }, 'blue'] }),
    );

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    expect(outcome.suggestion.tags).toEqual(['widget', 'blue']);
  });

  it('caps how many list entries survive', () => {
    const outcome = parseSuggestion(
      'draft_fields',
      JSON.stringify({ tags: Array.from({ length: 100 }, (_, i) => `tag-${String(i)}`) }),
    );

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    expect(outcome.suggestion.tags).toHaveLength(20);
  });

  it('keeps an explanation of what the destination still needs', () => {
    const outcome = parseSuggestion(
      'draft_fields',
      JSON.stringify({ missingRequirements: ['eBay needs a category', 'no images on the source'] }),
    );

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    expect(outcome.suggestion.missingRequirements).toHaveLength(2);
  });
});

describe('kit recipes', () => {
  it('keeps whole positive quantities and discards the rest', () => {
    const outcome = parseSuggestion(
      'kit_recipe',
      JSON.stringify({
        components: [
          { reference: 'Widget', requiredQuantity: 2 },
          { reference: 'Half a widget', requiredQuantity: 2.5 },
          { reference: 'Nothing', requiredQuantity: 0 },
          { reference: 'Owed', requiredQuantity: -1 },
          { reference: 'Absurd', requiredQuantity: 10_000 },
          { reference: 'Words', requiredQuantity: 'two' },
        ],
      }),
    );

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'kit_recipe') {
      throw new Error('expected a kit recipe');
    }

    expect(outcome.suggestion.components).toEqual([
      { reference: 'Widget', requiredQuantity: 2, reason: null },
    ]);
    expect(outcome.warnings.join(' ')).toContain('5 component(s)');
  });

  it('is malformed when nothing survives', () => {
    const outcome = parseSuggestion(
      'kit_recipe',
      JSON.stringify({ components: [{ reference: 'Widget', requiredQuantity: 0 }] }),
    );

    expect(outcome.status).toBe('malformed');
  });

  it('is malformed when there is no component list at all', () => {
    expect(parseSuggestion('kit_recipe', JSON.stringify({ notes: ['hello'] })).status).toBe(
      'malformed',
    );
  });
});

describe('mapping candidates', () => {
  it('keeps a candidate with a reason', () => {
    const outcome = parseSuggestion(
      'mapping_candidates',
      JSON.stringify({
        candidates: [
          { reference: 'Blue widget 40mm', reason: 'same size and colour' },
          { reason: 'no name at all' },
        ],
      }),
    );

    if (outcome.status !== 'valid' || outcome.suggestion.kind !== 'mapping_candidates') {
      throw new Error('expected mapping candidates');
    }

    expect(outcome.suggestion.candidates).toEqual([
      { reference: 'Blue widget 40mm', reason: 'same size and colour' },
    ]);
    expect(outcome.warnings.join(' ')).toContain('1 candidate(s)');
  });

  it('is malformed when the list is missing', () => {
    expect(parseSuggestion('mapping_candidates', '{}').status).toBe('malformed');
  });
});

describe('the schema offered to the endpoint', () => {
  it('describes one shape per suggestion kind', () => {
    for (const kind of KINDS) {
      expect(SUGGESTION_SCHEMAS[kind]).toBeDefined();
      expect(SUGGESTION_SCHEMAS[kind]['additionalProperties']).toBe(false);
    }
  });

  it('never asks the model for a protected fact', () => {
    const described = JSON.stringify(SUGGESTION_SCHEMAS).toLowerCase();

    // `requiredQuantity` is not on this list and is not an exception to it. A
    // recipe quantity is how many of a component make one kit — a statement
    // about the kit's composition, which section 10 has a person approve — and
    // not a statement about how many are in stock, which is what section 18
    // protects.
    for (const fact of ['price', 'sku', 'currency', 'condition', 'policy', 'stock', 'inventory']) {
      expect(described, fact).not.toContain(fact);
    }
  });
});
