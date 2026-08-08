/**
 * The query parameter a sign-in link uses when it cannot use the fragment.
 *
 * Its own module, with no imports, for the same reason `csrf-field.ts` is: the
 * confirmation form is a client component and needs the name and nothing else.
 * Taking it from `@eim/mail` would drag nodemailer — and through it
 * `child_process` and `dns` — into the browser bundle, which does not build and
 * should not.
 *
 * `token-field.test.ts` asserts this agrees with the mail package, so the two
 * copies cannot drift into a link the page cannot read.
 */
export const TOKEN_FIELD = 't';
