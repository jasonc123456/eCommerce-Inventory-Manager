import { describe, expect, it } from 'vitest';

import { FakeAiAdapter } from './fake-ai-adapter';
import { isSuccess } from '../outcomes';
import type { AiRequest } from '../ai';

/**
 * What is worth asserting about a fixture is the behaviour the suite built on
 * top of it will treat as real: that a request is recorded exactly as sent, that
 * a timeout looks like a timeout rather than an empty answer, and that a
 * misbehaving model is reproducible on demand.
 */

const request: AiRequest = {
  instruction: 'Suggest a title.',
  subject: 'A blue widget, 40mm.',
  responseSchema: { title: 'string' },
  maxOutputTokens: 400,
  timeoutMs: 20_000,
};

describe('answers', () => {
  it('serializes an object and returns a string untouched', async () => {
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }, 'not json at all'] });

    const first = await adapter.complete(request);
    const second = await adapter.complete(request);

    expect(isSuccess(first) && first.value.text).toBe('{"title":"Blue widget"}');
    expect(isSuccess(second) && second.value.text).toBe('not json at all');
  });

  it('repeats the last answer once the queue is exhausted', async () => {
    const adapter = new FakeAiAdapter({ answers: [{ title: 'only one' }] });

    await adapter.complete(request);
    const again = await adapter.complete(request);

    expect(isSuccess(again) && again.value.text).toBe('{"title":"only one"}');
  });

  it('reports usage only when the endpoint claims to', async () => {
    const reporting = await new FakeAiAdapter({ completionTokens: 12 }).complete(request);
    const silent = await new FakeAiAdapter({
      capabilities: { reportsUsage: false },
    }).complete(request);

    expect(isSuccess(reporting) && reporting.value.completionTokens).toBe(12);
    expect(isSuccess(silent) && silent.value.completionTokens).toBeUndefined();
  });
});

describe('failures', () => {
  it('reports a slower endpoint than the request allows as unavailable', async () => {
    const adapter = new FakeAiAdapter({ latencyMs: 30_000 });

    const result = await adapter.complete(request);

    expect(result.status).toBe('unavailable');
  });

  it('answers normally when the endpoint is inside the timeout', async () => {
    const adapter = new FakeAiAdapter({ latencyMs: 500, answers: [{ title: 'in time' }] });

    expect(isSuccess(await adapter.complete(request))).toBe(true);
  });

  it('records the request even when the call fails', async () => {
    const adapter = new FakeAiAdapter({
      failures: [{ status: 'unauthorized', requiresReauthorization: false, message: 'bad key' }],
    });

    const result = await adapter.complete(request);

    expect(result.status).toBe('unauthorized');
    expect(adapter.requests).toHaveLength(1);
  });
});

describe('recording', () => {
  it('keeps the instruction and the subject apart, as they were sent', async () => {
    const adapter = new FakeAiAdapter();

    await adapter.complete(request);

    expect(adapter.requests[0]?.instruction).toBe('Suggest a title.');
    expect(adapter.requests[0]?.subject).toBe('A blue widget, 40mm.');
  });

  it('records that no images were sent when none were offered', async () => {
    const adapter = new FakeAiAdapter();

    await adapter.complete(request);

    expect(adapter.requests[0]?.imageUrls).toBeUndefined();
  });
});
