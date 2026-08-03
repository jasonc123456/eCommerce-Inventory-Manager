/**
 * The placeholder landing page.
 *
 * M0 builds foundations, not features. This exists so a reviewer can confirm
 * the web tier serves, and so the layout, styling pipeline, and accessibility
 * defaults are exercised by something rather than asserted about nothing. The
 * real application starts at M1 with identity and setup.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Inventory Manager</h1>
      <p className="text-sm opacity-80">
        Foundations are in place. Setup and sign-in arrive in the next milestone.
      </p>
      <p className="text-sm opacity-60">
        Liveness is at <code>/api/health</code> and readiness at <code>/api/ready</code>.
      </p>
    </main>
  );
}
