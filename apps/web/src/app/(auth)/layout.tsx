import type { ReactNode } from 'react';

/**
 * The shell every unauthenticated screen shares.
 *
 * Nothing is loaded from anywhere else: section 19 forbids analytics and
 * third-party resources on authentication and callback pages, and a page that
 * fetched a font would also be reporting when somebody was signing in.
 */
export default function AuthenticationLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
      {children}
    </main>
  );
}
