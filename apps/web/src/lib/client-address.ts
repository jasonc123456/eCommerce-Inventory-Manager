/**
 * Working out who is actually asking (section 19).
 *
 * "Trust forwarded headers only from configured reverse-proxy networks."
 * Getting this wrong in either direction is a real failure: trust nothing and
 * every rate limit applies to the proxy rather than the caller, so one attacker
 * exhausts everyone's budget; trust everything and a caller sets
 * `X-Forwarded-For: 1.2.3.4` and gets a fresh budget per request.
 *
 * Next.js gives a route handler headers, not the socket's peer address, so the
 * peer cannot be checked directly. The standard technique works without it:
 * walk `X-Forwarded-For` from the right, discarding entries that are in the
 * configured proxy networks, and take the first one that is not. Each proxy
 * appends the address it saw, so the rightmost entries are the ones our own
 * infrastructure added and can vouch for; everything to the left of the first
 * untrusted address was supplied by somebody we have no reason to believe.
 *
 * With no configured networks the header is ignored entirely, which is correct
 * for a deployment that nothing proxies.
 */

export interface AddressResolution {
  /** The caller's address, or null when it cannot be established. */
  readonly address: string | null;
  /** True when the value came from a forwarded header we chose to trust. */
  readonly forwarded: boolean;
}

export function resolveClientAddress(
  headers: Headers,
  trustedProxyCidrs: readonly string[],
): AddressResolution {
  if (trustedProxyCidrs.length === 0) {
    return { address: null, forwarded: false };
  }

  const forwardedFor = headers.get('x-forwarded-for');

  if (forwardedFor === null || forwardedFor.length === 0) {
    return { address: null, forwarded: false };
  }

  const hops = forwardedFor
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of [...hops].reverse()) {
    const hop = normalizeAddress(entry);

    if (hop === null) {
      // An unparseable entry means the chain cannot be reasoned about beyond
      // this point, and guessing past it is how a spoofed value gets through.
      return { address: null, forwarded: false };
    }

    if (!isWithinAny(hop, trustedProxyCidrs)) {
      return { address: hop, forwarded: true };
    }
  }

  // Every hop was one of our own proxies, which happens for a request that
  // originated inside the trusted network.
  return { address: null, forwarded: false };
}

/**
 * Strips a port and the IPv6 brackets, and unwraps an IPv4-mapped IPv6 address.
 *
 * `::ffff:203.0.113.4` and `203.0.113.4` are the same host, and a CIDR check
 * that treated them as different would silently stop matching the moment a
 * proxy was reconfigured to listen on IPv6.
 */
export function normalizeAddress(value: string): string | null {
  let candidate = value.trim();

  if (candidate.startsWith('[')) {
    const close = candidate.indexOf(']');
    if (close === -1) {
      return null;
    }
    candidate = candidate.slice(1, close);
  } else if (candidate.split(':').length === 2) {
    // IPv4 with a port. Counting colons rather than looking for one, because
    // `::ffff:203.0.113.4` also contains both a dot and a colon and truncating
    // it at the first colon leaves nothing at all.
    candidate = candidate.slice(0, candidate.indexOf(':'));
  }

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(candidate);
  if (mapped?.[1] !== undefined) {
    candidate = mapped[1];
  }

  return isIpv4(candidate) || isIpv6(candidate) ? candidate.toLowerCase() : null;
}

export function isWithinAny(address: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => isWithin(address, cidr));
}

/**
 * Whether an address falls inside a CIDR block.
 *
 * A bare address without a prefix length is treated as a single host, so
 * `192.168.0.8` and `192.168.0.8/32` mean the same thing. Operators write both.
 */
export function isWithin(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.trim().split('/');
  const addressBits = toBits(address);
  const networkBits = network === undefined ? null : toBits(network);

  if (addressBits === null || networkBits === null) {
    return false;
  }

  // Comparing an IPv4 address against an IPv6 network is not a match, and it is
  // not an error either: a deployment may list both families.
  if (addressBits.length !== networkBits.length) {
    return false;
  }

  const prefix = prefixText === undefined ? addressBits.length : Number(prefixText);

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > addressBits.length) {
    return false;
  }

  return addressBits.slice(0, prefix) === networkBits.slice(0, prefix);
}

function toBits(address: string): string | null {
  const normalized = normalizeAddress(address);

  if (normalized === null) {
    return null;
  }

  if (isIpv4(normalized)) {
    return normalized
      .split('.')
      .map((octet) => Number(octet).toString(2).padStart(8, '0'))
      .join('');
  }

  const groups = expandIpv6(normalized);

  return groups === null
    ? null
    : groups.map((group) => group.toString(2).padStart(16, '0')).join('');
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');

  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function isIpv6(value: string): boolean {
  return expandIpv6(value) !== null;
}

/**
 * Expands an IPv6 address to its eight groups.
 *
 * Handles the `::` abbreviation and the trailing-IPv4 form, both of which
 * appear in real forwarded headers.
 */
function expandIpv6(value: string): number[] | null {
  if (!value.includes(':')) {
    return null;
  }

  let text = value;
  const trailingIpv4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);

  if (trailingIpv4 !== null) {
    const embedded = trailingIpv4[1] ?? '';

    if (!isIpv4(embedded)) {
      return null;
    }

    const [a = 0, b = 0, c = 0, d = 0] = embedded.split('.').map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, trailingIpv4.index)}${high}:${low}`;
  }

  const halves = text.split('::');

  if (halves.length > 2) {
    return null;
  }

  const parse = (part: string): number[] | null => {
    if (part.length === 0) {
      return [];
    }

    const groups: number[] = [];

    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) {
        return null;
      }
      groups.push(Number.parseInt(group, 16));
    }

    return groups;
  };

  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];

  if (head === null || tail === null) {
    return null;
  }

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const missing = 8 - head.length - tail.length;

  return missing < 0 ? null : [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}
