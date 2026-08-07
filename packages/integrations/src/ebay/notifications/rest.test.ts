import { describe, expect, it } from 'vitest';

import { identifierFrom, objectArray, parseJsonObject, stringField } from './rest';

/**
 * Reading eBay's REST answers.
 *
 * Every case here is a response that parses as JSON and means nothing: a proxy
 * error page, a login redirect with a 200, an array where an object was
 * documented. Each one is a successful `JSON.parse` and each one, read
 * charitably, becomes `undefined` flowing somewhere it will be mistaken for an
 * answer.
 */

describe('parseJsonObject', () => {
  it('reads an object', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('refuses everything that is not one', () => {
    for (const body of ['', 'not json', '<html>', '[]', '[{"a":1}]', 'null', '42', '"text"']) {
      expect(parseJsonObject(body)).toBeNull();
    }
  });
});

describe('objectArray', () => {
  it('reads the array under a key', () => {
    expect(objectArray({ topics: [{ topicId: 'A' }] }, 'topics')).toEqual([{ topicId: 'A' }]);
  });

  it('drops entries that are not objects rather than passing them on', () => {
    expect(objectArray({ topics: [{ a: 1 }, 'text', null, 7, []] }, 'topics')).toEqual([{ a: 1 }]);
  });

  it('reads an absent or wrongly-typed key as empty', () => {
    expect(objectArray({ topics: 'nope' }, 'topics')).toEqual([]);
    expect(objectArray({}, 'topics')).toEqual([]);
    expect(objectArray(null, 'topics')).toEqual([]);
  });
});

describe('stringField', () => {
  it('reads a non-empty string and nothing else', () => {
    expect(stringField({ a: 'value' }, 'a')).toBe('value');
    expect(stringField({ a: '' }, 'a')).toBeUndefined();
    expect(stringField({ a: 7 }, 'a')).toBeUndefined();
    expect(stringField({}, 'a')).toBeUndefined();
    expect(stringField(undefined, 'a')).toBeUndefined();
  });
});

describe('identifierFrom', () => {
  it('prefers the identifier in the body', () => {
    expect(identifierFrom('{"destinationId":"dest-1"}', {}, 'destinationId')).toBe('dest-1');
  });

  it('falls back to the Location header, in either casing', () => {
    // A registration whose identifier was not captured is unmanageable
    // afterwards: it cannot be updated, re-enabled, or removed on disconnect.
    expect(
      identifierFrom('{}', { location: 'https://api.ebay.com/v1/destination/dest-2' }, 'x'),
    ).toBe('dest-2');

    expect(identifierFrom('{}', { Location: '/v1/destination/dest-3' }, 'x')).toBe('dest-3');
  });

  it('ignores a query string on the location', () => {
    expect(identifierFrom('{}', { location: '/v1/destination/dest-4?v=2' }, 'x')).toBe('dest-4');
  });

  it('returns nothing when neither place names it', () => {
    expect(identifierFrom('{}', {}, 'destinationId')).toBeUndefined();
    expect(identifierFrom('not json', {}, 'destinationId')).toBeUndefined();
    expect(identifierFrom('{}', { location: '' }, 'destinationId')).toBeUndefined();
    expect(identifierFrom('{}', { location: '///' }, 'destinationId')).toBeUndefined();
  });
});
