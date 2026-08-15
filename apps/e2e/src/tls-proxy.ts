import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TLS in front of the application under test (sections 19, 23, 25).
 *
 * The browser tier runs the production build, and section 19 requires
 * `EIM_PUBLIC_URL` to be HTTPS in production — the configuration loader refuses
 * to start otherwise. That refusal is correct and is not something to work
 * around with a test-only exemption, because an exemption is a branch that
 * decides whether a security rule applies, and a branch like that can be taken
 * in the wrong place.
 *
 * So the tier terminates TLS instead, which is also the shape production runs
 * in: the application there listens on plain HTTP behind a proxy that holds the
 * certificate. Running the same way here means the tier exercises the forwarded
 * headers that shape produces rather than pretending they do not exist.
 *
 * The certificate is generated on first use and is self-signed, so the suite
 * sets `ignoreHTTPSErrors`. That is the one thing this does not prove; real
 * certificate handling belongs to the deployment, not to the application.
 */

const LISTEN_PORT = 3443;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 3100;

const here = dirname(fileURLToPath(import.meta.url));
const certificateDirectory = join(here, '..', '.tls');
const keyPath = join(certificateDirectory, 'key.pem');
const certificatePath = join(certificateDirectory, 'cert.pem');

function ensureCertificate(): { key: Buffer; cert: Buffer } {
  if (!existsSync(keyPath) || !existsSync(certificatePath)) {
    mkdirSync(certificateDirectory, { recursive: true });

    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '3650',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ]);
  }

  return { key: readFileSync(keyPath), cert: readFileSync(certificatePath) };
}

const credentials = ensureCertificate();

const server = createHttpsServer(credentials, (incoming, outgoing) => {
  const forwarded = {
    ...incoming.headers,
    // What a terminator is for. The application reads these to know the scheme
    // and the address it was actually reached on; section 19's client-address
    // resolution and the secure-cookie decision both depend on them being here.
    'x-forwarded-proto': 'https',
    'x-forwarded-host': incoming.headers.host ?? `localhost:${String(LISTEN_PORT)}`,
    'x-forwarded-for': incoming.socket.remoteAddress ?? '127.0.0.1',
  };

  const upstream = httpRequest(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: incoming.method ?? 'GET',
      path: incoming.url ?? '/',
      headers: forwarded,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );

  upstream.on('error', () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { 'content-type': 'text/plain' });
    }
    outgoing.end('the application under test did not answer');
  });

  incoming.pipe(upstream);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.warn(`tls terminator listening on https://localhost:${String(LISTEN_PORT)}`);
});
