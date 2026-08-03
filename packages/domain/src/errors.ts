/**
 * Domain errors are programming or data-integrity faults, not user-facing
 * validation. They mean an invariant the database and application layers are
 * supposed to guarantee has already been violated, so they should surface loudly
 * rather than be caught and defaulted.
 */
export class DomainError extends Error {
  public override readonly name = 'DomainError';

  public constructor(message: string) {
    super(message);
  }
}

export function assertWholeNonNegative(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError(
      `${label} must be a whole number of zero or more, received ${String(value)}`,
    );
  }
}

export function assertWholePositive(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(
      `${label} must be a whole number of one or more, received ${String(value)}`,
    );
  }
}
