import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';

import type { Resolver, Transport, TransportResponse } from './client';

/**
 * The socket layer, and nothing else.
 *
 * Separated from `client.ts` so that the part which decides what may be reached
 * is testable without a network and the part which opens the connection is
 * small enough to read in one sitting. Everything security-relevant is in the
 * other file; what remains here is Node's HTTP client with three constraints
 * bolted on — a pinned address, a byte ceiling, and a timeout.
 *
 * Not covered by the unit suite, by the same reasoning that excludes the mail
 * transport: exercising it means a real listening socket, and what would be
 * asserted is that Node can make a request.
 */

export const nodeResolver: Resolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });

  return results.map((result) => result.address);
};

/**
 * The real transport.
 *
 * `lookup` is overridden to return the address that was already validated,
 * which is what closes the window between checking a name and connecting to it.
 * Node still performs TLS verification against the hostname, so pinning the
 * address does not weaken certificate checking.
 */
export const nodeTransport: Transport = async (request) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const secure = request.url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;

    const outbound: ClientRequest = send(
      {
        protocol: request.url.protocol,
        hostname: request.url.hostname.replace(/^\[|\]$/g, ''),
        port: request.url.port === '' ? (secure ? 443 : 80) : Number(request.url.port),
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method,
        headers: request.headers,
        timeout: request.timeoutMs,
        servername: secure ? request.url.hostname : undefined,
        lookup: (_hostname, _opts, callback) => {
          const family = request.address.includes(':') ? 6 : 4;

          // The callback shape differs between `all: true` and the default, and
          // Node's types describe the union rather than which one it will use.
          (callback as (error: Error | null, address: string, family: number) => void)(
            null,
            request.address,
            family,
          );
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let length = 0;
        let truncated = false;

        response.on('data', (chunk: Buffer) => {
          length += chunk.length;

          if (length > request.maxBytes) {
            truncated = true;
            response.destroy();
            return;
          }

          chunks.push(chunk);
        });

        response.on('close', () => {
          if (!truncated) {
            return;
          }

          resolve({
            status: response.statusCode ?? 0,
            headers: flatten(response.headers),
            body: '',
            truncated: true,
          });
        });

        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: flatten(response.headers),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    outbound.on('timeout', () => {
      outbound.destroy(Object.assign(new Error('timed out'), { code: 'EIM_TIMEOUT' }));
    });

    outbound.on('error', reject);

    if (request.body !== undefined) {
      outbound.write(request.body);
    }

    outbound.end();
  });

function flatten(headers: IncomingMessage['headers']): Record<string, string> {
  const flat: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      flat[name.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      // Set-Cookie is the only header Node hands back as an array, and joining
      // with a comma is what every other client does with it.
      flat[name.toLowerCase()] = value.join(', ');
    }
  }

  return flat;
}
