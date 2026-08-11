import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../components/form';
import { csrfToken } from '../../../lib/csrf';
import { identity } from '../../../lib/identity';
import { loadAiSettings } from '../../../lib/ai';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { ConfigurationForm, EndpointControls } from './ai-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'AI assistance' };

/**
 * Optional AI, and everything it is not (sections 18, 19, 21).
 *
 * The screen is arranged around section 18's opening sentence — "AI is optional
 * and disabled until configured per business" — so a business that has never
 * touched it sees an explanation and a form, never a feature quietly working.
 *
 * What is deliberately absent is a button that asks a question. A suggestion is
 * asked for on the screen where the work is happening, by somebody who holds the
 * permission for that work, and lands there as a suggestion. This screen is the
 * endpoint, the money, and the history — which is to say, the parts an owner is
 * accountable for rather than the parts a catalogue manager uses.
 */
export default async function AiPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const businesses = await identity().memberships.listBusinessesFor(db, context.user.id);
  const businessId = context.session.activeBusinessId ?? businesses[0]?.businessId ?? null;

  if (businessId === null) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">AI assistance</h1>
        <Notice tone="info">You are not a member of any business yet.</Notice>
      </main>
    );
  }

  const view = await loadAiSettings(businessId, context.user.id);
  const csrf = csrfToken(context.session);
  const { provider } = view;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">AI assistance</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/operations">
            Drafts and prices
          </Link>
          <Link className="underline" href="/mappings">
            Mappings
          </Link>
        </nav>
      </header>

      <Notice tone="info">
        Optional, off until you switch it on, and never able to publish anything. A model may
        suggest a title, a description, categories, tags, item details, kit components, and mapping
        candidates. It is never told a price, a SKU, a stock figure, a condition, a policy, or
        anything about a customer or an order, and it has nowhere to return one: a suggestion that
        contains a protected fact has that part discarded before anybody sees it.
      </Notice>

      {!view.mayManage ? (
        <Notice tone="info">
          Changing any of this needs the <code className="px-1">manage_ai</code> permission.
        </Notice>
      ) : null}

      <Card title="This month">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Suggestions</dt>
          <dd>
            {view.usage.requests}
            {provider === null ? null : ` of ${String(provider.monthlyRequestCap)}`}
          </dd>
          <dt className="text-slate-500">Tokens</dt>
          <dd>
            {view.usage.tokens}
            {provider === null ? null : ` of ${String(provider.monthlyTokenCap)}`}
          </dd>
          {provider?.monthlyCostCapAmount == null ? null : (
            <>
              <dt className="text-slate-500">Spent</dt>
              <dd>
                {view.usage.costAmount ?? '0'} of {provider.monthlyCostCapAmount}{' '}
                {provider.costCurrency}
              </dd>
            </>
          )}
        </dl>
        {view.budget !== null && !view.budget.allowed ? (
          <Notice tone="error">
            {view.budget.detail}. Nothing further will be sent until the month turns or the ceiling
            is raised.
          </Notice>
        ) : null}
      </Card>

      {provider === null ? (
        <Notice tone="info">
          No endpoint is configured, so nothing is sent anywhere and no screen offers a suggestion.
        </Notice>
      ) : (
        <Card title="The endpoint">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-500">Kind</dt>
            <dd>{provider.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible'}</dd>
            <dt className="text-slate-500">Address</dt>
            <dd className="break-all">{provider.baseUrl}</dd>
            <dt className="text-slate-500">Model</dt>
            <dd>{provider.model}</dd>
            <dt className="text-slate-500">State</dt>
            <dd>
              {provider.enabled ? 'on' : 'off'}, {provider.status}
              {provider.lastFailureSummary === null ? null : (
                <span className="text-slate-500"> — {provider.lastFailureSummary}</span>
              )}
            </dd>
            <dt className="text-slate-500">Photographs</dt>
            <dd>{provider.imageAnalysisEnabled ? 'may be sent when asked for' : 'never sent'}</dd>
            <dt className="text-slate-500">Questions kept</dt>
            <dd>{provider.retainPrompts ? 'yes, for debugging' : 'no'}</dd>
          </dl>

          {view.mayManage ? (
            <EndpointControls
              csrf={csrf}
              businessId={businessId}
              enabled={provider.enabled}
              ready={provider.status === 'ready'}
            />
          ) : null}
        </Card>
      )}

      {view.mayManage ? (
        <Card title={provider === null ? 'Configure an endpoint' : 'Change the endpoint'}>
          <ConfigurationForm
            csrf={csrf}
            businessId={businessId}
            hasCredential={view.hasCredential}
            privateHostsAllowed={view.privateHostsAllowed}
            values={{
              kind: provider?.kind ?? 'openai_compatible',
              baseUrl: provider?.baseUrl ?? '',
              model: provider?.model ?? '',
              requestTimeoutMs: provider?.requestTimeoutMs ?? 30_000,
              maxOutputTokens: provider?.maxOutputTokens ?? 800,
              monthlyRequestCap: provider?.monthlyRequestCap ?? 200,
              monthlyTokenCap: provider?.monthlyTokenCap ?? 500_000,
              imageAnalysisEnabled: provider?.imageAnalysisEnabled ?? false,
              retainPrompts: provider?.retainPrompts ?? false,
              costCurrency: provider?.costCurrency ?? '',
              costPerMillionInputTokens: provider?.costPerMillionInputTokens ?? '',
              costPerMillionOutputTokens: provider?.costPerMillionOutputTokens ?? '',
              monthlyCostCapAmount: provider?.monthlyCostCapAmount ?? '',
            }}
          />
        </Card>
      ) : null}

      {view.recent.length === 0 ? null : (
        <Card title="What has been asked">
          <ul className="flex flex-col gap-2 text-sm">
            {view.recent.map((suggestion) => (
              <li key={suggestion.id} className="flex flex-wrap gap-x-3">
                <span className="text-slate-500">{suggestion.requestedAt.toISOString()}</span>
                <span>{suggestion.kind.replace(/_/g, ' ')}</span>
                <span className="font-medium">{suggestion.status}</span>
                {suggestion.model === null ? null : (
                  <span className="text-slate-500">{suggestion.model}</span>
                )}
                {suggestion.refusalReason === null ? null : (
                  <span className="text-slate-500">
                    {suggestion.refusalReason.replace(/_/g, ' ')}
                  </span>
                )}
                {suggestion.appliedAt === null ? (
                  <span className="text-slate-500">not used</span>
                ) : (
                  <span>accepted by a person</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
