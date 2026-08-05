import { describe, expect, it } from 'vitest';

import { field, trimmedField } from './forms';

/**
 * Reading form fields.
 *
 * The case that matters is the file upload. `FormData.get` returns
 * `string | File | null`, and `String(someFile)` is `[object Object]` — which
 * would then be compared against a token, looked up as an identifier, or
 * emailed to somebody. Every field this application reads is text, so anything
 * else is a request that did not come from one of our forms.
 */

const form = (entries: Record<string, string | File>): FormData => {
  const data = new FormData();

  for (const [name, value] of Object.entries(entries)) {
    data.set(name, value);
  }

  return data;
};

describe('field', () => {
  it('returns a text value unchanged', () => {
    expect(field(form({ email: ' a@example.invalid ' }), 'email')).toBe(' a@example.invalid ');
  });

  it('returns empty for a field that is not present', () => {
    expect(field(form({}), 'missing')).toBe('');
  });

  it('returns empty for a file rather than stringifying it', () => {
    const uploaded = form({ token: new File(['contents'], 'token.txt') });

    expect(field(uploaded, 'token')).toBe('');
    expect(field(uploaded, 'token')).not.toContain('object');
  });

  it('keeps a value that only looks empty', () => {
    expect(field(form({ code: '00000000' }), 'code')).toBe('00000000');
    expect(field(form({ code: '0' }), 'code')).toBe('0');
  });
});

describe('trimmedField', () => {
  it('trims what a person typed', () => {
    expect(trimmedField(form({ email: '  a@example.invalid \n' }), 'email')).toBe(
      'a@example.invalid',
    );
  });

  it('is empty for whitespace, a file, and an absent field alike', () => {
    expect(trimmedField(form({ name: '   ' }), 'name')).toBe('');
    expect(trimmedField(form({ name: new File([''], 'x') }), 'name')).toBe('');
    expect(trimmedField(form({}), 'name')).toBe('');
  });
});
