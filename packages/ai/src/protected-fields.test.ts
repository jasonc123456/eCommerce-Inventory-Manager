import { describe, expect, it } from 'vitest';

import { isProtectedFieldName, scanForProtectedFields } from './protected-fields';

/**
 * Section 18's list is short and the ways a model can restate it are not, so
 * what is tested here is mostly the restating: separators, casing, nesting, and
 * the name/value shape every marketplace uses for attributes.
 */

describe('naming', () => {
  it('matches the section 18 facts however they are spelled', () => {
    for (const name of [
      'sku',
      'SKU',
      'item_sku',
      'itemSku',
      'price',
      'salePrice',
      'currency',
      'stockQuantity',
      'inventory',
      'condition',
      'returnPolicy',
      'shipping_policy',
      'paymentPolicy',
      'gtin',
      'EAN',
      'mpn',
    ]) {
      expect(isProtectedFieldName(name), name).toBe(true);
    }
  });

  it('leaves the fields a suggestion is actually for', () => {
    for (const name of ['title', 'description', 'tags', 'categoryHints', 'notes', 'reference']) {
      expect(isProtectedFieldName(name), name).toBe(false);
    }
  });
});

describe('scanning', () => {
  it('says nothing when the model stayed inside the schema', () => {
    const scan = scanForProtectedFields({ title: 'Blue widget', tags: ['widget'] });

    expect(scan.names).toEqual([]);
    expect(scan.summary).toBeNull();
  });

  it('finds a protected fact nested inside an array of objects', () => {
    const scan = scanForProtectedFields({
      title: 'Blue widget',
      variants: [{ colour: 'blue', price: '12.00' }],
    });

    expect(scan.names).toEqual(['price']);
    expect(scan.summary).toContain('price');
  });

  it('finds one hidden in a name and value pair', () => {
    const scan = scanForProtectedFields({
      itemSpecifics: [
        { name: 'Colour', value: 'Blue' },
        { name: 'Condition', value: 'New' },
      ],
    });

    expect(scan.names).toEqual(['Condition']);
  });

  it('names each fact once however often it appears', () => {
    const scan = scanForProtectedFields({
      variants: [{ price: '1' }, { price: '2' }, { price: '3' }],
    });

    expect(scan.names).toEqual(['price']);
  });

  it('stops walking rather than following an unbounded nesting', () => {
    let deep: Record<string, unknown> = { price: '9.99' };
    for (let i = 0; i < 40; i += 1) {
      deep = { inner: deep };
    }

    expect(scanForProtectedFields(deep).names).toEqual([]);
  });

  it('tolerates values that are not objects at all', () => {
    expect(scanForProtectedFields(null).names).toEqual([]);
    expect(scanForProtectedFields('a string').names).toEqual([]);
    expect(scanForProtectedFields(42).names).toEqual([]);
  });
});
