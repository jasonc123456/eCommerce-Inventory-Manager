'use client';

/**
 * The last-resort error boundary.
 *
 * Replaces the root layout entirely when rendering it fails, so it has to
 * supply its own html and body elements.
 *
 * Nothing about the error is shown. Section 19 keeps internal detail out of
 * responses, and an unhandled exception message is the least curated string in
 * the application: it may carry a query, a path, or a provider payload. The
 * digest is Next.js's own stable hash, safe to display, and it is what lets an
 * operator find the matching log line.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main
          style={{ fontFamily: 'system-ui, sans-serif', margin: '4rem auto', maxWidth: '32rem' }}
        >
          <h1>Something went wrong</h1>
          <p>The error has been recorded. Try again, or check the application logs.</p>
          {error.digest === undefined ? null : (
            <p>
              Reference: <code>{error.digest}</code>
            </p>
          )}
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
