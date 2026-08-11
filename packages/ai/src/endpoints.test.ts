import type { AiProvider } from '@eim/db';
import { isSuccess, type HttpClient, type HttpOutcome, type HttpRequest } from '@eim/providers';
import { describe, expect, it } from 'vitest';

import { createAiAdapter } from './endpoints';

/**
 * The two real endpoints, against a recorded HTTP client rather than a network.
 *
 * What is worth asserting is the translation: that a credential goes in a
 * header and never in a URL, that the two token-count spellings both land in the
 * same field, that nothing ever asks for a stream, and that each kind of refusal
 * becomes the outcome the retry policy expects.
 */

interface Recorded {
  readonly client: HttpClient;
  readonly requests: HttpRequest[];
}

function recording(responses: readonly HttpOutcome[]): Recorded {
  const requests: HttpRequest[] = [];
  let index = 0;

  return {
    requests,
    client: {
      send(request) {
        requests.push(request);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;

        return Promise.resolve(
          response ?? { ok: true, response: { status: 200, headers: {}, body: '{}', url: '' } },
        );
      },
    },
  };
}

function ok(body: unknown, status = 200): HttpOutcome {
  return {
    ok: true,
    response: { status, headers: {}, body: JSON.stringify(body), url: 'https://x.invalid' },
  };
}

const provider = (overrides: Partial<AiProvider> = {}): AiProvider =>
  ({
    kind: 'openai_compatible',
    baseUrl: 'https://models.example.invalid/v1',
    model: 'a-model',
    requestTimeoutMs: 20_000,
    maxOutputTokens: 500,
    ...overrides,
  }) as AiProvider;

const request = {
  instruction: 'Answer with JSON.',
  subject: '<<<SHOP DATA>>>\nTitle: Widget\n<<<END SHOP DATA>>>',
  responseSchema: { type: 'object' },
  maxOutputTokens: 500,
  timeoutMs: 20_000,
};

describe('an OpenAI-compatible endpoint', () => {
  it('puts the credential in a header and never in the URL', async () => {
    const recorder = recording([ok({ choices: [{ message: { content: '{}' } }] })]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: 'sk-secret',
      http: recorder.client,
    });

    await adapter.complete(request);

    expect(recorder.requests[0]?.headers?.['authorization']).toBe('Bearer sk-secret');
    expect(recorder.requests[0]?.url).not.toContain('sk-secret');
  });

  it('sends no authorization at all when there is no key', async () => {
    const recorder = recording([ok({ choices: [{ message: { content: '{}' } }] })]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recorder.client,
    });

    await adapter.complete(request);

    expect(recorder.requests[0]?.headers?.['authorization']).toBeUndefined();
  });

  it('reads the answer and the token counts', async () => {
    const recorder = recording([
      ok({
        model: 'a-model-0125',
        choices: [{ message: { content: '{"title":"Widget"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
    ]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recorder.client,
    });

    const result = await adapter.complete(request);

    expect(isSuccess(result) && result.value.text).toBe('{"title":"Widget"}');
    expect(isSuccess(result) && result.value.model).toBe('a-model-0125');
    expect(isSuccess(result) && result.value.promptTokens).toBe(120);
    expect(isSuccess(result) && result.value.truncated).toBe(false);
  });

  it('reports a cut-off answer as cut off', async () => {
    const recorder = recording([
      ok({ choices: [{ message: { content: '{"title":"Wid' }, finish_reason: 'length' }] }),
    ]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recorder.client,
    });

    const result = await adapter.complete(request);

    expect(isSuccess(result) && result.value.truncated).toBe(true);
  });

  it('copes with an endpoint that reports no usage', async () => {
    const recorder = recording([ok({ choices: [{ message: { content: '{}' } }] })]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recorder.client,
    });

    const result = await adapter.complete(request);

    expect(isSuccess(result) && result.value.promptTokens).toBeUndefined();
  });

  it('sends the text alone when there are no images', async () => {
    const recorder = recording([ok({ choices: [{ message: { content: '{}' } }] })]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recorder.client,
    });

    await adapter.complete(request);

    const body = JSON.parse(recorder.requests[0]?.body ?? '{}') as {
      messages: { content: unknown }[];
    };
    expect(typeof body.messages[1]?.content).toBe('string');
  });

  it('sends the array form when there are', async () => {
    const recorder = recording([ok({ choices: [{ message: { content: '{}' } }] })]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recorder.client,
    });

    await adapter.complete({ ...request, imageUrls: ['https://shop.invalid/a.jpg'] });

    const body = JSON.parse(recorder.requests[0]?.body ?? '{}') as {
      messages: { content: unknown }[];
    };
    expect(Array.isArray(body.messages[1]?.content)).toBe(true);
  });

  it('falls back to a real question when the models listing is not implemented', async () => {
    const recorder = recording([
      { ok: true, response: { status: 405, headers: {}, body: '', url: '' } },
      ok({ choices: [{ message: { content: '{"ok":true}' } }] }),
    ]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recorder.client,
    });

    const result = await adapter.checkEndpoint();

    expect(isSuccess(result)).toBe(true);
    expect(recorder.requests).toHaveLength(2);
    expect(recorder.requests[1]?.url).toContain('chat/completions');
  });

  it('accepts a models listing when there is one', async () => {
    const recorder = recording([ok({ data: [{ id: 'a-model' }] })]);
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recorder.client,
    });

    expect(isSuccess(await adapter.checkEndpoint())).toBe(true);
    expect(recorder.requests).toHaveLength(1);
  });
});

describe('Ollama', () => {
  const ollama = provider({ kind: 'ollama', baseUrl: 'http://ollama.internal:11434' });

  it('never asks for a stream', async () => {
    const recorder = recording([ok({ message: { content: '{}' } })]);
    const adapter = createAiAdapter({ provider: ollama, apiKey: null, http: recorder.client });

    await adapter.complete(request);

    const body = JSON.parse(recorder.requests[0]?.body ?? '{}') as { stream: boolean };
    expect(body.stream).toBe(false);
  });

  it('reads its own spelling of the token counts', async () => {
    const recorder = recording([
      ok({ message: { content: '{"title":"Widget"}' }, prompt_eval_count: 88, eval_count: 12 }),
    ]);
    const adapter = createAiAdapter({ provider: ollama, apiKey: null, http: recorder.client });

    const result = await adapter.complete(request);

    expect(isSuccess(result) && result.value.promptTokens).toBe(88);
    expect(isSuccess(result) && result.value.completionTokens).toBe(12);
  });

  it('says it cannot take images rather than dropping them silently', () => {
    const adapter = createAiAdapter({ provider: ollama, apiKey: null, http: recording([]).client });

    expect(adapter.capabilities.supportsImages).toBe(false);
  });

  it('checks the tag listing', async () => {
    const recorder = recording([ok({ models: [] })]);
    const adapter = createAiAdapter({ provider: ollama, apiKey: null, http: recorder.client });

    await adapter.checkEndpoint();

    expect(recorder.requests[0]?.url).toBe('http://ollama.internal:11434/api/tags');
  });
});

describe('failures', () => {
  const cases: readonly [HttpOutcome, string][] = [
    [{ ok: false, kind: 'blocked', reason: 'a private address' }, 'rejected'],
    [{ ok: false, kind: 'timeout', reason: 'slow' }, 'unavailable'],
    [{ ok: false, kind: 'transport', reason: 'refused' }, 'unavailable'],
    [{ ok: false, kind: 'too_large', reason: 'huge' }, 'rejected'],
    [{ ok: false, kind: 'too_many_redirects', reason: 'loop' }, 'rejected'],
    [ok({}, 401), 'unauthorized'],
    [ok({}, 403), 'unauthorized'],
    [ok({}, 404), 'not_found'],
    [ok({}, 429), 'rate_limited'],
    [ok({}, 400), 'rejected'],
    [ok({}, 503), 'unavailable'],
  ];

  for (const [outcome, expected] of cases) {
    it(`reports ${outcome.ok ? String(outcome.response.status) : outcome.kind} as ${expected}`, async () => {
      const adapter = createAiAdapter({
        provider: provider(),
        apiKey: null,
        http: recording([outcome]).client,
      });

      expect((await adapter.complete(request)).status).toBe(expected);
    });
  }

  it('rejects a body that is not the shape it claims', async () => {
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recording([ok({ choices: [] })]).client,
    });

    expect((await adapter.complete(request)).status).toBe('rejected');
  });

  it('rejects a body that is not JSON at all', async () => {
    const adapter = createAiAdapter({
      provider: provider(),
      apiKey: null,
      http: recording([
        { ok: true, response: { status: 200, headers: {}, body: 'gateway error', url: '' } },
      ]).client,
    });

    expect((await adapter.complete(request)).status).toBe('rejected');
  });
});
