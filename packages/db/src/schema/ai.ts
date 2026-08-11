import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { businesses, users } from './tenancy';
import { reviewedOperations } from './listings';

/**
 * Typed access to the optional AI tables (sections 18, 19, 33, 34).
 *
 * `migrations/0024_ai.sql` is the source of truth. What lives only there and
 * cannot be seen from this file: every default that makes the feature off,
 * narrow, and cheap until somebody widens it, and the check constraints that
 * keep a refused attempt from recording spend it never incurred.
 */

export const aiProviderKinds = ['openai_compatible', 'ollama'] as const;
export type AiProviderKind = (typeof aiProviderKinds)[number];

export const aiProviderStatuses = ['unchecked', 'ready', 'failing'] as const;
export type AiProviderStatus = (typeof aiProviderStatuses)[number];

export const aiProviders = pgTable(
  'ai_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: aiProviderKinds }).notNull(),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    /** Section 18's first rule. Off until a person with `manage_ai` says so. */
    enabled: boolean('enabled').notNull().default(false),
    status: text('status', { enum: aiProviderStatuses }).notNull().default('unchecked'),
    requestTimeoutMs: integer('request_timeout_ms').notNull().default(30_000),
    maxOutputTokens: integer('max_output_tokens').notNull().default(800),
    imageAnalysisEnabled: boolean('image_analysis_enabled').notNull().default(false),
    retainPrompts: boolean('retain_prompts').notNull().default(false),
    monthlyRequestCap: integer('monthly_request_cap').notNull().default(200),
    monthlyTokenCap: bigint('monthly_token_cap', { mode: 'number' }).notNull().default(500_000),
    costCurrency: text('cost_currency'),
    costPerMillionInputTokens: numeric('cost_per_million_input_tokens'),
    costPerMillionOutputTokens: numeric('cost_per_million_output_tokens'),
    monthlyCostCapAmount: numeric('monthly_cost_cap_amount'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastFailureSummary: text('last_failure_summary'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('ai_providers_one_per_business').on(table.businessId)],
);

export const aiSecretTypes = ['ai_api_key'] as const;
export type AiSecretType = (typeof aiSecretTypes)[number];

export const aiProviderSecrets = pgTable('ai_provider_secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  secretType: text('secret_type', { enum: aiSecretTypes }).notNull(),
  ciphertext: text('ciphertext').notNull(),
  keyVersion: integer('key_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});

export const aiSuggestionKinds = ['draft_fields', 'kit_recipe', 'mapping_candidates'] as const;
export type AiSuggestionKind = (typeof aiSuggestionKinds)[number];

export const aiSuggestionStatuses = ['succeeded', 'malformed', 'refused', 'failed'] as const;
export type AiSuggestionStatus = (typeof aiSuggestionStatuses)[number];

/**
 * Why this application declined before anything was sent.
 *
 * Each of these is a rule from section 18 rather than an error: the feature is
 * off, the caller may not use it, the ceiling for the month is reached, or the
 * endpoint's address is no longer one this installation may reach.
 */
export const aiRefusalReasons = [
  'disabled',
  'not_configured',
  'not_permitted',
  'recent_authentication_required',
  'request_budget_spent',
  'token_budget_spent',
  'cost_budget_spent',
  'destination_refused',
] as const;
export type AiRefusalReason = (typeof aiRefusalReasons)[number];

export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: aiSuggestionKinds }).notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectReference: text('subject_reference').notNull(),
    /** Snapshots. The configuration may be edited; this row must not change. */
    providerKind: text('provider_kind', { enum: aiProviderKinds }),
    model: text('model'),
    status: text('status', { enum: aiSuggestionStatuses }).notNull(),
    refusalReason: text('refusal_reason', { enum: aiRefusalReasons }),
    failureSummary: text('failure_summary'),
    payload: jsonb('payload'),
    warnings: jsonb('warnings').notNull().default([]),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    estimatedCostAmount: numeric('estimated_cost_amount'),
    costCurrency: text('cost_currency'),
    latencyMs: integer('latency_ms'),
    imagesSent: integer('images_sent').notNull().default(0),
    retainedPrompt: text('retained_prompt'),
    retainedResponse: text('retained_response'),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    appliedOperationId: uuid('applied_operation_id').references(() => reviewedOperations.id, {
      onDelete: 'set null',
    }),
    appliedByUserId: uuid('applied_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (table) => [index('ai_suggestions_by_business').on(table.businessId, table.requestedAt)],
);

export type AiProvider = typeof aiProviders.$inferSelect;
export type AiProviderSecret = typeof aiProviderSecrets.$inferSelect;
export type AiSuggestion = typeof aiSuggestions.$inferSelect;
