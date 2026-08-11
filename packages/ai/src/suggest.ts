import type { AuditRecorder } from '@eim/audit';
import { authorize, type BusinessPermission, type Subject } from '@eim/authz';
import { aiSuggestions, type AiProvider, type AiRefusalReason, type Database } from '@eim/db';
import { describeFailure, isSuccess, validateIntegrationUrl, type UrlPolicy } from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import { assessBudget, estimateCost, monthWindow } from './budget';
import { parseSuggestion, type Suggestion, type SuggestionKind } from './output';
import { usableProvider, type AdapterForProvider } from './providers';
import { buildRequest, type RequestPreview, type SubjectText } from './request';
import { readUsage } from './usage';

/**
 * Asking, once, on somebody's behalf (sections 12, 18, 36).
 *
 * The order of the checks is the design. Permission, then whether the feature is
 * on at all, then whether the address is still one this installation may reach,
 * then the budget — and only then is anything sent. Every refusal before the
 * send writes a row saying so and costs nothing, which is what makes a spent
 * budget legible: the history shows what was asked for, what was refused, and
 * why.
 *
 * Nothing here throws for anything a caller is expected to handle. Section 18
 * is explicit that "AI errors never prevent manual draft or recipe creation", so
 * a refusal, a dead endpoint, and an answer that is not JSON are all ordinary
 * outcomes carried back to the screen. A screen that had to catch an exception
 * to keep working would eventually not catch one.
 *
 * And nothing here applies anything. The result is a suggestion with an
 * identity; turning it into a draft is a separate call, made by a person, which
 * writes the provenance back onto this row.
 */

/**
 * Which permission each question needs.
 *
 * The permission for the work, not a permission for the model. Somebody who may
 * not propose a mapping does not get to propose one by asking a machine to, and
 * `manage_ai` deliberately is not on this list: it governs the endpoint, the
 * credential, and the spending limits — the decisions an owner makes — while
 * using the feature belongs to whoever does the work.
 */
const PERMISSION_FOR: Readonly<Record<SuggestionKind, BusinessPermission>> = {
  draft_fields: 'create_drafts',
  kit_recipe: 'propose_kit_recipes',
  mapping_candidates: 'propose_mappings',
};

export interface SuggestInput {
  readonly businessId: string;
  readonly kind: SuggestionKind;
  /** The catalogue text. Assembled by the caller, never read from here. */
  readonly subjectText: SubjectText;
  /** What was asked about, for the record: `canonical_item`, `provider_item`. */
  readonly subjectKind: string;
  readonly subjectReference: string;
  readonly subject: Subject;
  readonly actorUserId: string;
  /** Section 18: images travel only when this request asked for them. */
  readonly requestImageAnalysis?: boolean;
  readonly adapterFor: AdapterForProvider;
  readonly urlPolicy: UrlPolicy;
  readonly now?: Date;
}

export type SuggestionResult =
  | {
      readonly status: 'suggested';
      readonly suggestionId: string;
      readonly suggestion: Suggestion;
      readonly warnings: readonly string[];
      readonly preview: RequestPreview;
    }
  | {
      readonly status: 'refused';
      readonly suggestionId: string;
      readonly reason: AiRefusalReason;
      readonly detail: string;
    }
  | {
      readonly status: 'unusable';
      readonly suggestionId: string;
      readonly reason: 'malformed' | 'failed';
      readonly detail: string;
    };

export async function suggest(
  db: Database,
  audit: AuditRecorder,
  input: SuggestInput,
): Promise<SuggestionResult> {
  const now = input.now ?? new Date();
  const permission = PERMISSION_FOR[input.kind];

  const decision = authorize(input.subject, permission);
  if (!decision.allowed) {
    return refuse(
      db,
      audit,
      input,
      'not_permitted',
      `${permission} was refused: ${decision.reason}`,
    );
  }

  const provider = await usableProvider(db, input.businessId);
  if (provider === null) {
    return refuse(
      db,
      audit,
      input,
      'disabled',
      'AI assistance is not switched on for this business',
    );
  }

  // Section 19 requires the destination check "again before every connection",
  // and this is one. The stored string was validated when it was typed; what a
  // name resolves to is a fact about now.
  const verdict = validateIntegrationUrl(provider.baseUrl, input.urlPolicy);
  if (!verdict.ok) {
    return refuse(
      db,
      audit,
      input,
      'destination_refused',
      `the configured endpoint may no longer be reached: ${verdict.reason}`,
      provider,
    );
  }

  const usage = await readUsage(db, input.businessId, monthWindow(now));
  const budget = assessBudget(provider, usage);
  if (!budget.allowed) {
    return refuse(db, audit, input, budget.reason, budget.detail, provider);
  }

  const adapter = await input.adapterFor(provider.id);

  // Three switches, all of which must be on. The configuration permits images at
  // all, the endpoint accepts them, and this request asked. Section 18 requires
  // the third; the first exists so a business that never wants a photograph
  // leaving the building does not depend on nobody ticking a box.
  const includeImages =
    (input.requestImageAnalysis ?? false) &&
    provider.imageAnalysisEnabled &&
    adapter.capabilities.supportsImages;

  const { request, preview } = buildRequest(input.subjectText, {
    maxOutputTokens: provider.maxOutputTokens,
    timeoutMs: provider.requestTimeoutMs,
    includeImages,
  });

  const startedAt = Date.now();
  const completion = await adapter.complete(request);
  const latencyMs = Date.now() - startedAt;

  if (!isSuccess(completion)) {
    const detail = describeFailure(completion);
    const suggestionId = await record(db, input, provider, {
      status: 'failed',
      failureSummary: detail,
      latencyMs,
      imagesSent: request.imageUrls?.length ?? 0,
      requestedAt: now,
      ...(provider.retainPrompts ? { retainedPrompt: retainable(preview) } : {}),
    });

    await recordRequested(db, audit, input, provider, suggestionId, 'failure', { detail });

    return { status: 'unusable', suggestionId, reason: 'failed', detail };
  }

  const { promptTokens, completionTokens, model, truncated } = completion.value;
  const cost = estimateCost(provider, promptTokens ?? null, completionTokens ?? null);
  const outcome = parseSuggestion(input.kind, completion.value.text);

  const common = {
    latencyMs,
    imagesSent: request.imageUrls?.length ?? 0,
    requestedAt: now,
    model,
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(cost === null ? {} : { estimatedCostAmount: cost, costCurrency: provider.costCurrency }),
    ...(provider.retainPrompts
      ? { retainedPrompt: retainable(preview), retainedResponse: completion.value.text }
      : {}),
  };

  if (outcome.status === 'malformed') {
    // Truncation is reported separately from misbehaviour. "The model answered
    // badly" and "the ceiling was too low for this catalogue" need different
    // fixes, and only one of them is the model's fault.
    const detail = truncated
      ? `${outcome.reason}; the answer was cut off at the output limit`
      : outcome.reason;

    const suggestionId = await record(db, input, provider, {
      ...common,
      status: 'malformed',
      failureSummary: detail,
      warnings: outcome.warnings,
    });

    await recordRequested(db, audit, input, provider, suggestionId, 'failure', {
      detail,
      truncated,
    });

    return { status: 'unusable', suggestionId, reason: 'malformed', detail };
  }

  const suggestionId = await record(db, input, provider, {
    ...common,
    status: 'succeeded',
    payload: outcome.suggestion,
    warnings: outcome.warnings,
  });

  await recordRequested(db, audit, input, provider, suggestionId, 'success', {
    warnings: outcome.warnings.length,
    imagesSent: request.imageUrls?.length ?? 0,
    promptTokens: promptTokens ?? null,
    completionTokens: completionTokens ?? null,
  });

  return {
    status: 'suggested',
    suggestionId,
    suggestion: outcome.suggestion,
    warnings: outcome.warnings,
    preview,
  };
}

export class SuggestionApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuggestionApplicationError';
  }
}

/**
 * Records that a person took a suggestion into an operation they confirmed.
 *
 * This is section 18's provenance requirement — "store the resulting draft,
 * provider/model identifier, timestamp, and approving user" — and the row
 * already holds the provider and the model, so what is added here is the person
 * and the operation.
 *
 * Nothing about this writes a draft. The draft is proposed through the
 * confirmation gate by the caller, with the model's values in the preview a
 * person reads and fingerprints; this is the note that says where those values
 * came from.
 */
export async function markSuggestionApplied(
  db: Database,
  audit: AuditRecorder,
  input: {
    readonly businessId: string;
    readonly suggestionId: string;
    readonly operationId: string;
    readonly actorUserId: string;
    readonly now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();

  const updated = await db
    .update(aiSuggestions)
    .set({
      appliedOperationId: input.operationId,
      appliedByUserId: input.actorUserId,
      appliedAt: now,
    })
    .where(
      and(
        eq(aiSuggestions.id, input.suggestionId),
        eq(aiSuggestions.businessId, input.businessId),
        eq(aiSuggestions.status, 'succeeded'),
      ),
    )
    .returning({ id: aiSuggestions.id });

  if (updated[0] === undefined) {
    throw new SuggestionApplicationError(
      'no such suggestion in this business, or it was never a valid one',
    );
  }

  await audit.record(db, {
    action: 'ai.suggestion.applied',
    result: 'success',
    businessId: input.businessId,
    targetType: 'ai_suggestion',
    targetId: input.suggestionId,
    detail: { operationId: input.operationId },
  });
}

async function refuse(
  db: Database,
  audit: AuditRecorder,
  input: SuggestInput,
  reason: AiRefusalReason,
  detail: string,
  provider?: AiProvider,
): Promise<SuggestionResult> {
  const suggestionId = await record(db, input, provider ?? null, {
    status: 'refused',
    refusalReason: reason,
    failureSummary: detail,
    requestedAt: input.now ?? new Date(),
  });

  await audit.record(db, {
    action: 'ai.suggestion.refused',
    result: 'denied',
    businessId: input.businessId,
    targetType: 'ai_suggestion',
    targetId: suggestionId,
    detail: { kind: input.kind, reason, detail },
  });

  return { status: 'refused', suggestionId, reason, detail };
}

async function record(
  db: Database,
  input: SuggestInput,
  provider: AiProvider | null,
  values: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(aiSuggestions)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      subjectKind: input.subjectKind,
      subjectReference: input.subjectReference,
      requestedByUserId: input.actorUserId,
      ...(provider === null
        ? {}
        : { providerId: provider.id, providerKind: provider.kind, model: provider.model }),
      ...values,
    } as never)
    .returning({ id: aiSuggestions.id });

  if (row === undefined) {
    throw new Error('the AI suggestion could not be recorded');
  }

  return row.id;
}

async function recordRequested(
  db: Database,
  audit: AuditRecorder,
  input: SuggestInput,
  provider: AiProvider,
  suggestionId: string,
  result: 'success' | 'failure',
  detail: Record<string, unknown>,
): Promise<void> {
  await audit.record(db, {
    action: 'ai.suggestion.requested',
    result,
    businessId: input.businessId,
    targetType: 'ai_suggestion',
    targetId: suggestionId,
    detail: {
      kind: input.kind,
      providerKind: provider.kind,
      model: provider.model,
      subject: input.subjectReference,
      ...detail,
    },
  });
}

/**
 * What a retained prompt is, when a business has asked for one.
 *
 * The preview, which is by construction exactly what was sent. Reassembling it
 * from the parts would be a second implementation of the thing being retained,
 * and section 18's default is not to keep it at all.
 */
function retainable(preview: RequestPreview): string {
  return `${preview.instruction}\n\n${preview.subject}`;
}
