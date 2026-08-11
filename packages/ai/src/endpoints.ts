import type { AiProvider } from '@eim/db';
import {
  parseRetryAfter,
  type AiAdapter,
  type AiCapabilities,
  type AiCompletion,
  type AiRequest,
  type HttpClient,
  type HttpOutcome,
  type ProviderResult,
} from '@eim/providers';

/**
 * Talking to a real model endpoint (sections 18, 19, 34).
 *
 * Two shapes are supported because section 18 names two: "configurable
 * OpenAI-compatible HTTPS endpoint and Ollama". Unlike shipping, there is no
 * verification standing between this code and a live call — an OpenAI-compatible
 * chat completion and Ollama's chat API are published interfaces that anybody
 * can read, not a commercial contract somebody has to establish first — so these
 * adapters are real and the fake beside them exists for determinism rather than
 * for absence.
 *
 * Every request goes through the section 19 HTTP client, which means the
 * destination is revalidated, resolved, and pinned before a socket opens, the
 * body is bounded, redirects are limited and rechecked, and a private address
 * behind a public name is refused rather than fetched. Nothing in this file
 * opens a connection itself.
 *
 * Both adapters ask for JSON and neither trusts the answer. What comes back is a
 * string; `parseSuggestion` decides what it was.
 */

export interface AiEndpointOptions {
  readonly provider: AiProvider;
  /** Decrypted for this call. Null for a local endpoint that needs none. */
  readonly apiKey: string | null;
  readonly http: HttpClient;
}

export function createAiAdapter(options: AiEndpointOptions): AiAdapter {
  return options.provider.kind === 'ollama'
    ? createOllamaAdapter(options)
    : createOpenAiCompatibleAdapter(options);
}

/**
 * The OpenAI chat-completions shape, as spoken by everything that claims to be
 * compatible with it.
 *
 * "OpenAI-compatible" is a family resemblance rather than a specification, so
 * this asks for the common denominator and copes with the variations: a
 * `response_format` an endpoint may ignore, a `usage` block it may omit, and a
 * `finish_reason` that may be spelled differently or missing.
 */
function createOpenAiCompatibleAdapter(options: AiEndpointOptions): AiAdapter {
  const { provider, apiKey, http } = options;

  const capabilities: AiCapabilities = {
    kind: 'openai_compatible',
    model: provider.model,
    supportsStructuredOutput: true,
    supportsImages: true,
    reportsUsage: true,
  };

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json',
    // The credential goes in a header and nowhere else, for the same reason
    // section 14 insists on it for WooCommerce: a URL is written to access logs,
    // proxies, and this application's own request log. A header is not.
    ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
  });

  return {
    capabilities,

    async checkEndpoint() {
      const listing = await http.send({
        method: 'GET',
        url: join(provider.baseUrl, 'models'),
        headers: headers(),
        timeoutMs: provider.requestTimeoutMs,
      });

      // A gateway that does not implement the models listing is common — several
      // self-hosted front ends answer 404 or 405 there while serving completions
      // perfectly well — so a missing catalogue is not a failing endpoint. What
      // decides in that case is whether it will actually answer a question,
      // which is the only capability this application uses.
      if (listing.ok && listing.response.status < 400) {
        return { status: 'success', value: { model: provider.model } };
      }

      if (listing.ok && (listing.response.status === 404 || listing.response.status === 405)) {
        return this.complete({
          instruction: 'Reply with {"ok":true} and nothing else.',
          subject: '',
          responseSchema: { type: 'object' },
          maxOutputTokens: 16,
          timeoutMs: provider.requestTimeoutMs,
        }).then((result) =>
          result.status === 'success'
            ? { status: 'success' as const, value: { model: result.value.model } }
            : result,
        );
      }

      return failure(listing);
    },

    async complete(request: AiRequest): Promise<ProviderResult<AiCompletion>> {
      const outcome = await http.send({
        method: 'POST',
        url: join(provider.baseUrl, 'chat/completions'),
        headers: headers(),
        timeoutMs: request.timeoutMs,
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: request.instruction },
            { role: 'user', content: userContent(request) },
          ],
          max_tokens: request.maxOutputTokens,
          // Deterministic as the endpoint allows. A suggestion that differs
          // every time it is asked for is one nobody can reproduce when they
          // want to know why a listing says what it says.
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
      });

      if (!outcome.ok || outcome.response.status >= 400) {
        return failure(outcome);
      }

      const body = parseJson(outcome.response.body);
      const choice = first(read(body, 'choices'));
      const message = read(choice, 'message');
      const text = readString(message, 'content');

      if (text === null) {
        return { status: 'rejected', message: 'the endpoint returned no message content' };
      }

      const usage = read(body, 'usage');

      return {
        status: 'success',
        value: {
          text,
          model: readString(body, 'model') ?? provider.model,
          truncated: readString(choice, 'finish_reason') === 'length',
          ...optionalCount('promptTokens', readNumber(usage, 'prompt_tokens')),
          ...optionalCount('completionTokens', readNumber(usage, 'completion_tokens')),
        },
      };
    },
  };
}

/**
 * Ollama's own chat API.
 *
 * Separate rather than folded into the compatible adapter behind a flag. Ollama
 * does offer an OpenAI-compatible surface, but its native one reports token
 * counts under different names, takes the response schema in `format` rather
 * than `response_format`, and is the one its documentation treats as primary.
 * Two small adapters that each say what they mean beat one that branches on a
 * boolean in six places.
 */
function createOllamaAdapter(options: AiEndpointOptions): AiAdapter {
  const { provider, http } = options;

  const capabilities: AiCapabilities = {
    kind: 'ollama',
    model: provider.model,
    supportsStructuredOutput: true,
    // Ollama takes images as base64 bytes rather than URLs, which would mean
    // this application fetching a shop's image itself and re-encoding it — a
    // second outbound request, to an address a business supplied, for the sake
    // of a feature section 18 already makes optional and off by default. Not in
    // version 1, and reported honestly rather than attempted and dropped.
    supportsImages: false,
    reportsUsage: true,
  };

  return {
    capabilities,

    async checkEndpoint() {
      const outcome = await http.send({
        method: 'GET',
        url: join(provider.baseUrl, 'api/tags'),
        headers: { accept: 'application/json' },
        timeoutMs: provider.requestTimeoutMs,
      });

      if (!outcome.ok || outcome.response.status >= 400) {
        return failure(outcome);
      }

      return { status: 'success', value: { model: provider.model } };
    },

    async complete(request: AiRequest): Promise<ProviderResult<AiCompletion>> {
      const outcome = await http.send({
        method: 'POST',
        url: join(provider.baseUrl, 'api/chat'),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        timeoutMs: request.timeoutMs,
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: request.instruction },
            { role: 'user', content: request.subject },
          ],
          // Never true. A streamed answer would arrive in pieces, and a piece of
          // an answer is a protected fact on a screen before the check that
          // removes it has run.
          stream: false,
          format: request.responseSchema,
          options: { temperature: 0, num_predict: request.maxOutputTokens },
        }),
      });

      if (!outcome.ok || outcome.response.status >= 400) {
        return failure(outcome);
      }

      const body = parseJson(outcome.response.body);
      const text = readString(read(body, 'message'), 'content');

      if (text === null) {
        return { status: 'rejected', message: 'the endpoint returned no message content' };
      }

      return {
        status: 'success',
        value: {
          text,
          model: readString(body, 'model') ?? provider.model,
          truncated: readString(body, 'done_reason') === 'length',
          ...optionalCount('promptTokens', readNumber(body, 'prompt_eval_count')),
          ...optionalCount('completionTokens', readNumber(body, 'eval_count')),
        },
      };
    },
  };
}

/**
 * The user turn, with images only when the request carried them.
 *
 * A plain string when there are none, because several compatible endpoints
 * reject the array form outright, and the array form is only needed when there
 * is something other than text to put in it.
 */
function userContent(request: AiRequest): unknown {
  const images = request.imageUrls ?? [];

  if (images.length === 0) {
    return request.subject;
  }

  return [
    { type: 'text', text: request.subject },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

/**
 * One HTTP outcome, as a provider outcome.
 *
 * The distinctions matter for the same reason they do everywhere else in this
 * application: an authorization failure must not be retried into a lockout, a
 * rate limit must be waited out, and a refused destination is a configuration
 * problem rather than a busy server.
 */
function failure(outcome: HttpOutcome): ProviderResult<never> {
  if (!outcome.ok) {
    switch (outcome.kind) {
      case 'blocked':
        return { status: 'rejected', message: `the destination was refused: ${outcome.reason}` };
      case 'timeout':
        return { status: 'unavailable', message: 'the endpoint did not answer in time' };
      case 'too_large':
        return { status: 'rejected', message: 'the endpoint returned more than will be read' };
      case 'too_many_redirects':
        return { status: 'rejected', message: 'the endpoint redirected too many times' };
      case 'transport':
        return { status: 'unavailable', message: 'the endpoint could not be reached' };
    }
  }

  const { status, headers } = outcome.response;

  if (status === 401 || status === 403) {
    return {
      status: 'unauthorized',
      requiresReauthorization: status === 403,
      message: 'the endpoint rejected the credential',
    };
  }

  if (status === 404) {
    return { status: 'not_found', message: 'the endpoint has no such model or route' };
  }

  if (status === 429) {
    return {
      status: 'rate_limited',
      retryAfterMs: parseRetryAfter(headers['retry-after'], new Date()) ?? 60_000,
    };
  }

  if (status >= 500) {
    return { status: 'unavailable', message: 'the endpoint reported an error', statusCode: status };
  }

  return { status: 'rejected', message: 'the endpoint rejected the request', code: String(status) };
}

/** Joins a stored base to a path without doubling or dropping the separator. */
function join(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function read(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function readString(value: unknown, key: string): string | null {
  const found = read(value, key);

  return typeof found === 'string' ? found : null;
}

function readNumber(value: unknown, key: string): number | null {
  const found = read(value, key);

  return typeof found === 'number' && Number.isFinite(found) ? Math.trunc(found) : null;
}

function optionalCount(key: string, value: number | null): Record<string, number> | object {
  return value === null ? {} : { [key]: value };
}
