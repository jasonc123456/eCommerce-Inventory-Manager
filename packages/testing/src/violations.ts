/**
 * Asserting on database constraint violations.
 *
 * Drizzle wraps a driver error in its own, so the thrown message is
 * "Failed query: insert into ..." and the actual reason — the constraint name,
 * or the message raised by a trigger — is on `cause`. A test that asserted on
 * the outer message would pass for any failure at all, including a typo in the
 * query, which is precisely the assertion a constraint test must not make.
 */

/** Every message in the error chain, outermost first. */
export function errorChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  // Bounded, because a self-referential cause would otherwise spin forever.
  for (let depth = 0; depth < 10 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

export class ExpectedRejectionError extends Error {
  public override readonly name = 'ExpectedRejectionError';
}

/**
 * Runs an operation that must be refused, and returns the reason it was.
 *
 * Fails if the operation succeeds, which is the case worth being loud about:
 * a constraint test that silently passes because the write went through is
 * worse than no test, since it reports the protection as present.
 *
 *     expect(await refuses(() => db.insert(balances).values({ onHand: -1 })))
 *       .toMatch(/on_hand_nonnegative/);
 */
export async function refuses(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return errorChain(error).join(' | ');
  }

  throw new ExpectedRejectionError('expected the database to refuse this write, but it succeeded');
}
