import type { AiAdapter, AiCapabilities, AiCompletion, AiProviderKind, AiRequest } from '../ai';
import type { ProviderFailure, ProviderResult } from '../outcomes';

/**
 * A programmable in-memory model endpoint.
 *
 * The behaviour worth rehearsing against a language model is the behaviour a
 * real one produces occasionally and cannot be asked for on demand: an answer
 * that is not JSON, an answer that is JSON but the wrong shape, an answer that
 * fills in a price nobody asked it for, an answer that arrives after the caller
 * has stopped waiting, an answer cut off at the token ceiling. Section 36's exit
 * gate for this milestone names four of those outright.
 *
 * Unlike the shipping fake, this one is not standing in for an absent
 * integration. There is a real OpenAI-compatible adapter and a real Ollama
 * adapter beside it, because those are documented open interfaces rather than a
 * commercial contract somebody has to verify first. This fake exists so the
 * rules that surround a suggestion — disabled by default, protected fields,
 * budget, timeout, review — can be tested deterministically, which a real model
 * cannot be: the same question twice is not the same answer twice.
 *
 * It also records every request, which is how the privacy claims are proven
 * rather than asserted. Section 18 requires that the model receive no
 * credentials and no customer or order detail, and a test that can read exactly
 * what was sent can say so.
 */

export interface FakeAiAdapterOptions {
  readonly kind?: AiProviderKind;
  readonly model?: string;
  readonly capabilities?: Partial<AiCapabilities>;
  /**
   * Answers, consumed in order; the last one repeats.
   *
   * An object is serialized, which is the well-behaved case. A string is
   * returned exactly as given, which is how the malformed cases are written:
   * prose instead of JSON, JSON with a trailing apology, a fenced code block.
   */
  readonly answers?: readonly (string | Readonly<Record<string, unknown>>)[];
  /** Queued failures, returned one per call before any answer. */
  readonly failures?: readonly ProviderFailure[];
  /**
   * How long the endpoint pretends to take.
   *
   * Compared against the request's own timeout rather than actually waited out,
   * so a timeout test costs no time. Nothing sleeps in here.
   */
  readonly latencyMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  /** Whether the answer is reported as cut off at the output ceiling. */
  readonly truncated?: boolean;
}

export class FakeAiAdapter implements AiAdapter {
  readonly capabilities: AiCapabilities;

  /** Every request, in full, oldest first. What was sent is assertable. */
  readonly requests: AiRequest[] = [];
  /** How many times the endpoint was checked. */
  checks = 0;

  private readonly options: FakeAiAdapterOptions;
  private readonly failures: ProviderFailure[];
  private answered = 0;

  constructor(options: FakeAiAdapterOptions = {}) {
    this.options = options;
    this.failures = [...(options.failures ?? [])];
    this.capabilities = {
      kind: options.kind ?? 'openai_compatible',
      model: options.model ?? 'fake-model',
      supportsStructuredOutput: true,
      supportsImages: true,
      reportsUsage: true,
      ...options.capabilities,
    };
  }

  checkEndpoint(): Promise<ProviderResult<{ readonly model: string }>> {
    this.checks += 1;

    const failure = this.failures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    return Promise.resolve({ status: 'success', value: { model: this.capabilities.model } });
  }

  complete(request: AiRequest): Promise<ProviderResult<AiCompletion>> {
    // Recorded before anything can refuse, because the privacy assertions are
    // about what left the application, not about what came back.
    this.requests.push(request);

    const failure = this.failures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const latencyMs = this.options.latencyMs ?? 0;
    if (latencyMs > request.timeoutMs) {
      // The shape a real timeout takes: retryable, no partial answer, and no
      // token count, because nothing was read.
      return Promise.resolve({
        status: 'unavailable',
        message: `the endpoint did not answer within ${String(request.timeoutMs)}ms`,
      });
    }

    const answers = this.options.answers ?? [{}];
    const index = Math.min(this.answered, answers.length - 1);
    this.answered += 1;
    const answer = answers[index] ?? {};

    return Promise.resolve({
      status: 'success',
      value: {
        text: typeof answer === 'string' ? answer : JSON.stringify(answer),
        model: this.capabilities.model,
        truncated: this.options.truncated ?? false,
        ...(this.capabilities.reportsUsage
          ? {
              promptTokens: this.options.promptTokens ?? 100,
              completionTokens: this.options.completionTokens ?? 40,
            }
          : {}),
      },
    });
  }
}
