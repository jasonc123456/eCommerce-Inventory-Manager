/**
 * Reading a form field as a string.
 *
 * `FormData.get` returns `string | File | null`, and stringifying the `File`
 * case produces `[object Object]` — which would then be compared against a
 * token, looked up as an identifier, or emailed to somebody. Every field this
 * application reads is text, so anything else is a request that did not come
 * from one of our forms and is treated as absent.
 */
export function field(form: FormData, name: string): string {
  const value = form.get(name);

  return typeof value === 'string' ? value : '';
}

/** The same, trimmed, for anything a person typed. */
export function trimmedField(form: FormData, name: string): string {
  return field(form, name).trim();
}
