import { isProtectedFieldName, scanForProtectedFields } from './protected-fields';

/**
 * What a model is allowed to have said (sections 7, 10, 18, 30).
 *
 * Section 18 requires that "structured output is required and validated against
 * deterministic destination rules". This module is the deterministic half. It
 * takes a string that a language model produced — which is to say, a string
 * about which nothing is known — and either turns it into one of exactly three
 * shapes or reports that it could not.
 *
 * Three properties are worth stating because each of them is a decision rather
 * than an implementation detail.
 *
 * *The types have no room for a protected fact.* There is no price field, no
 * SKU field, no condition, no policy. A model that returns them has not
 * defeated a check; it has returned something with nowhere to go. What survives
 * is a warning naming what was discarded, so the person reading the screen knows
 * the model had opinions this application declined to carry.
 *
 * *Nothing carries a confidence.* Section 7 fixes AI mapping candidates at "low
 * confidence" and nothing better, so a confidence field would be a place for the
 * model to disagree with the specification. Every candidate out of here is low
 * confidence because every candidate out of here is from a model.
 *
 * *Parsing is lenient about packaging and strict about content.* A fenced code
 * block or a sentence of preamble around the JSON is a formatting habit, not a
 * different answer, and refusing those would mean discarding good suggestions
 * over punctuation. What is never lenient is the shape: a field of the wrong
 * type is dropped, a quantity that is not a positive whole number is dropped,
 * and every drop is reported.
 */

export type SuggestionKind = 'draft_fields' | 'kit_recipe' | 'mapping_candidates';

/** One marketplace attribute. Never a protected fact; those are filtered out. */
export interface ItemSpecific {
  readonly name: string;
  readonly value: string;
}

/**
 * Fields for a destination draft.
 *
 * Section 18 permits "destination title, description, category, tags, and
 * marketplace-specific item details" and explaining "missing requirements".
 * Category is a hint rather than a choice: eBay's taxonomy is picked by a person
 * from a real category tree, and a model's guess is a starting point for that
 * form, not a value to store.
 */
export interface DraftFieldSuggestion {
  readonly kind: 'draft_fields';
  readonly title: string | null;
  readonly description: string | null;
  readonly categoryHints: readonly string[];
  readonly tags: readonly string[];
  readonly itemSpecifics: readonly ItemSpecific[];
  /** What the destination needs that the source did not supply. */
  readonly missingRequirements: readonly string[];
}

export interface KitComponentSuggestion {
  /** How the model referred to the component: a name, as read from the text. */
  readonly reference: string;
  /** Section 10: a positive whole number, or the component is discarded. */
  readonly requiredQuantity: number;
  readonly reason: string | null;
}

export interface KitRecipeSuggestion {
  readonly kind: 'kit_recipe';
  readonly components: readonly KitComponentSuggestion[];
  readonly notes: readonly string[];
}

export interface MappingCandidate {
  readonly reference: string;
  readonly reason: string | null;
}

export interface MappingCandidateSuggestion {
  readonly kind: 'mapping_candidates';
  readonly candidates: readonly MappingCandidate[];
}

export type Suggestion = DraftFieldSuggestion | KitRecipeSuggestion | MappingCandidateSuggestion;

export type SuggestionOutcome =
  | {
      readonly status: 'valid';
      readonly suggestion: Suggestion;
      readonly warnings: readonly string[];
    }
  | {
      readonly status: 'malformed';
      readonly reason: string;
      readonly warnings: readonly string[];
    };

/**
 * Bounds on anything a model returns.
 *
 * A suggestion is displayed on a screen and stored in a row, and both of those
 * are places where an unbounded string from an untrusted source is somebody
 * else's problem later. The limits are generous enough that a real answer is
 * never truncated and small enough that a runaway one cannot matter.
 */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4_000;
const MAX_SHORT = 120;
const MAX_REASON = 400;
const MAX_LIST = 20;
const MAX_COMPONENT_QUANTITY = 1_000;

/**
 * The shape asked of the model, passed to endpoints that can enforce it.
 *
 * Deliberately a description rather than a validator. The endpoint may honour
 * it, ignore it, or approximate it; what decides is `parseSuggestion`, which
 * runs on the answer either way.
 */
export const SUGGESTION_SCHEMAS: Readonly<
  Record<SuggestionKind, Readonly<Record<string, unknown>>>
> = {
  draft_fields: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      categoryHints: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      itemSpecifics: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, value: { type: 'string' } },
          required: ['name', 'value'],
        },
      },
      missingRequirements: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  kit_recipe: {
    type: 'object',
    properties: {
      components: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            reference: { type: 'string' },
            requiredQuantity: { type: 'integer', minimum: 1 },
            reason: { type: 'string' },
          },
          required: ['reference', 'requiredQuantity'],
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  mapping_candidates: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { reference: { type: 'string' }, reason: { type: 'string' } },
          required: ['reference'],
        },
      },
    },
    additionalProperties: false,
  },
};

export function parseSuggestion(kind: SuggestionKind, text: string): SuggestionOutcome {
  const document = extractJson(text);

  if (document === null) {
    return {
      status: 'malformed',
      reason: 'the answer was not JSON',
      warnings: [],
    };
  }

  if (typeof document !== 'object' || Array.isArray(document)) {
    return {
      status: 'malformed',
      reason: 'the answer was JSON but not an object',
      warnings: [],
    };
  }

  const record = document as Record<string, unknown>;
  const protectedFields = scanForProtectedFields(record);
  const warnings: string[] = protectedFields.summary === null ? [] : [protectedFields.summary];

  switch (kind) {
    case 'draft_fields':
      return draftFields(record, warnings);
    case 'kit_recipe':
      return kitRecipe(record, warnings);
    case 'mapping_candidates':
      return mappingCandidates(record, warnings);
  }
}

function draftFields(record: Record<string, unknown>, warnings: string[]): SuggestionOutcome {
  const title = text(record['title'], MAX_TITLE);
  const description = text(record['description'], MAX_DESCRIPTION);
  const categoryHints = list(record['categoryHints'], MAX_SHORT);
  const tags = list(record['tags'], MAX_SHORT);
  const missingRequirements = list(record['missingRequirements'], MAX_REASON);
  const itemSpecifics = specifics(record['itemSpecifics'], warnings);

  if (
    title === null &&
    description === null &&
    categoryHints.length === 0 &&
    tags.length === 0 &&
    itemSpecifics.length === 0 &&
    missingRequirements.length === 0
  ) {
    return {
      status: 'malformed',
      reason: 'the answer had none of the fields that were asked for',
      warnings,
    };
  }

  return {
    status: 'valid',
    suggestion: {
      kind: 'draft_fields',
      title,
      description,
      categoryHints,
      tags,
      itemSpecifics,
      missingRequirements,
    },
    warnings,
  };
}

function specifics(value: unknown, warnings: string[]): readonly ItemSpecific[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: ItemSpecific[] = [];
  let dropped = 0;

  for (const entry of value.slice(0, MAX_LIST)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }

    const pair = entry as Record<string, unknown>;
    const name = text(pair['name'], MAX_SHORT);
    const specificValue = text(pair['value'], MAX_SHORT);

    // The protected-fact filter, applied where it bites hardest. An item
    // specific named "Condition" or "Price" is how a protected fact arrives
    // dressed as an ordinary attribute: the top-level keys are all innocent and
    // the fact is in the data. The scan has already named it in a warning; this
    // is what stops it being carried.
    if (name === null || specificValue === null || isProtectedFieldName(name)) {
      dropped += 1;
      continue;
    }

    out.push({ name, value: specificValue });
  }

  if (dropped > 0) {
    warnings.push(
      `${String(dropped)} item detail(s) were incomplete or named a protected fact, and were dropped`,
    );
  }

  return out;
}

function kitRecipe(record: Record<string, unknown>, warnings: string[]): SuggestionOutcome {
  const raw = record['components'];

  if (!Array.isArray(raw)) {
    return {
      status: 'malformed',
      reason: 'the answer listed no components',
      warnings,
    };
  }

  const components: KitComponentSuggestion[] = [];
  let dropped = 0;

  for (const entry of raw.slice(0, MAX_LIST)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    const reference = text(candidate['reference'], MAX_SHORT);
    const quantity = candidate['requiredQuantity'];

    // Section 10: "positive whole-number required quantities". A model that
    // answers 2.5 is discarded rather than rounded, because rounding invents a
    // recipe nobody proposed and the difference is a component that either runs
    // out early or never runs out at all.
    if (
      reference === null ||
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_COMPONENT_QUANTITY
    ) {
      dropped += 1;
      continue;
    }

    components.push({
      reference,
      requiredQuantity: quantity,
      reason: text(candidate['reason'], MAX_REASON),
    });
  }

  if (dropped > 0) {
    warnings.push(
      `${String(dropped)} component(s) had no name or no positive whole quantity, and were dropped`,
    );
  }

  if (components.length === 0) {
    return {
      status: 'malformed',
      reason: 'no component in the answer had both a name and a positive whole quantity',
      warnings,
    };
  }

  return {
    status: 'valid',
    suggestion: { kind: 'kit_recipe', components, notes: list(record['notes'], MAX_REASON) },
    warnings,
  };
}

function mappingCandidates(record: Record<string, unknown>, warnings: string[]): SuggestionOutcome {
  const raw = record['candidates'];

  if (!Array.isArray(raw)) {
    return { status: 'malformed', reason: 'the answer listed no candidates', warnings };
  }

  const candidates: MappingCandidate[] = [];
  let dropped = 0;

  for (const entry of raw.slice(0, MAX_LIST)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1;
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    const reference = text(candidate['reference'], MAX_SHORT);

    if (reference === null) {
      dropped += 1;
      continue;
    }

    candidates.push({ reference, reason: text(candidate['reason'], MAX_REASON) });
  }

  if (dropped > 0) {
    warnings.push(`${String(dropped)} candidate(s) named nothing, and were dropped`);
  }

  if (candidates.length === 0) {
    return { status: 'malformed', reason: 'no candidate in the answer named anything', warnings };
  }

  return { status: 'valid', suggestion: { kind: 'mapping_candidates', candidates }, warnings };
}

/**
 * A string, made safe to store and to display.
 *
 * Markup is removed rather than escaped. Section 19 permits an allowlist
 * sanitizer for listing HTML that a *seller* wrote; this is text a model wrote,
 * and there is no case where a suggestion needs a tag in it. Removing them here
 * means the value is plain text everywhere afterwards, rather than something
 * every later screen has to remember to treat carefully.
 */
function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const cleaned = value
    .replace(/<[^>]*>/g, ' ')
    // Control characters, which arrive from a model far more often than they
    // should and turn a log line into something a terminal interprets.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) {
    return null;
  }

  return cleaned.length <= limit ? cleaned : cleaned.slice(0, limit).trimEnd();
}

function list(value: unknown, limit: number): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: string[] = [];

  for (const entry of value.slice(0, MAX_LIST)) {
    const cleaned = text(entry, limit);
    if (cleaned !== null) {
      out.push(cleaned);
    }
  }

  return out;
}

/**
 * Finds the JSON in an answer that may be wrapped in something else.
 *
 * Three attempts, in order of how well-behaved the model was: the whole string,
 * the contents of a fenced code block, and the span from the first brace to the
 * last. The third is the one that reads as risky and is not: whatever it finds
 * still has to parse as JSON and then survive the shape checks above, so the
 * worst case is a malformed verdict arriving a few microseconds later.
 */
function extractJson(text_: string): unknown {
  const attempts = [text_.trim(), fenced(text_), braced(text_)];

  for (const attempt of attempts) {
    if (attempt === null || attempt.length === 0) {
      continue;
    }

    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

function fenced(value: string): string | null {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);

  return match?.[1]?.trim() ?? null;
}

function braced(value: string): string | null {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');

  return start === -1 || end <= start ? null : value.slice(start, end + 1);
}
