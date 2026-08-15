import { PILOT_DURATION_DAYS } from '@eim/pilot';
import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../components/form';
import { csrfToken } from '../../../lib/csrf';
import { loadInstallationSubject } from '../../../lib/health';
import { identity } from '../../../lib/identity';
import { loadPilot } from '../../../lib/pilot';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { ClassifyForm, DrillForm, EnrollmentControls, StageForm } from './pilot-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Pilot' };

/**
 * How the controlled pilot is going (sections 1, 21, 36).
 *
 * The screen is laid out in the order the questions get asked. What stage are we
 * at, and how long has it run. Are changes arriving fast enough. Which of
 * section 1's eight criteria are met, and what to do about the ones that are
 * not. Then the two lists that need a person: oversales nobody has classified,
 * and the writes the stage gate withheld.
 *
 * Three things this screen deliberately does not do.
 *
 * It never rounds in the pilot's favour. An empty window is `undemonstrated`,
 * not met; a criterion with no evidence says so; and the overall verdict is
 * false until every one of them is met and the thirty days are up.
 *
 * It shows exclusions beside the figure they were excluded from. Any percentage
 * survives contact with enough exclusions, and a reader who cannot see them
 * cannot disagree with them.
 *
 * It has no button that declares the pilot passed.
 */
export default async function PilotPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const memberships = await identity().memberships.listBusinessesFor(db, context.user.id);
  const businessId = context.session.activeBusinessId ?? memberships[0]?.businessId ?? null;

  if (businessId === null) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Pilot</h1>
        <Notice tone="info">You are not a member of any business yet.</Notice>
      </main>
    );
  }

  const view = await loadPilot(businessId, context.user.id);

  if (view === null) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Pilot</h1>
        <Notice tone="info">You do not have permission to see synchronization activity.</Notice>
      </main>
    );
  }

  const csrf = csrfToken(context.session);
  const { report, slo } = { report: view.report, slo: view.report.slo };
  const admin = await loadInstallationSubject(db, context.user.id);
  const mayRecordDrill = admin?.permissions.has('manage_installation_settings') === true;

  const elapsed = report.elapsedDays === null ? null : Math.floor(report.elapsedDays);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Pilot</h1>
        <p className="text-sm text-slate-500">
          {elapsed === null
            ? 'Not started — nothing has been written to a provider yet'
            : `Day ${String(elapsed)} of ${String(PILOT_DURATION_DAYS)}`}
        </p>
      </header>

      <Notice tone={report.passes ? 'info' : 'error'}>
        {report.passes
          ? 'Every section 1 criterion is met and the thirty days are up. This pilot supports a version 1 release.'
          : report.durationMet
            ? 'The thirty days are up, but not every criterion is met. The list below says which.'
            : `This pilot has not yet run its ${String(PILOT_DURATION_DAYS)} days. Criteria already met stay met; the rest are below.`}
      </Notice>

      <Card title="Stage">
        <div className="flex flex-col gap-3 text-sm">
          <p>
            <span className="font-semibold">{report.stage.stage}</span>
            {report.stage.cohortLimit === null
              ? null
              : ` — up to ${String(report.stage.cohortLimit)} mappings`}
            {report.stage.stage === 'full'
              ? ' — every mapping is written'
              : ` — ${String(report.stage.enrolled)} enrolled`}
          </p>
          {report.stage.note === null ? null : (
            <p className="text-slate-600 dark:text-slate-400">{report.stage.note}</p>
          )}
          {view.mayStage ? (
            <StageForm
              csrf={csrf}
              businessId={businessId}
              stage={report.stage.stage}
              cohortLimit={report.stage.cohortLimit}
            />
          ) : (
            <p className="text-slate-600 dark:text-slate-400">
              Changing the stage needs permission to manage integrations.
            </p>
          )}
        </div>
      </Card>

      <Card title="Getting there in time">
        <div className="flex flex-col gap-2 text-sm">
          <p>
            {slo.attainment === null
              ? 'Nothing has settled in this window yet.'
              : `${(slo.attainment * 100).toFixed(1)}% of ${String(slo.met + slo.missed)} changes reached their channel within two minutes.`}
          </p>
          <p className="text-slate-600 dark:text-slate-400">
            {slo.p50Ms === null
              ? 'No latency to report.'
              : `Half arrived within ${formatMs(slo.p50Ms)}, 95% within ${formatMs(slo.p95Ms)}, 99% within ${formatMs(slo.p99Ms)}.`}
          </p>
          <p className="text-slate-600 dark:text-slate-400">
            {String(slo.pending)} still outstanding, {String(slo.superseded)} overtaken by a newer
            change, {String(slo.outOfScope)} out of scope (imports and reconciliations).
          </p>

          {/* Beside the figure, never behind a click. A percentage computed
              after discarding whatever missed it will always be 100%. */}
          {slo.excluded === 0 ? (
            <p className="text-slate-600 dark:text-slate-400">Nothing was excluded.</p>
          ) : (
            <div className="flex flex-col gap-1">
              <p>{String(slo.excluded)} excluded from the figure above, for these reasons:</p>
              <ul className="list-disc pl-5">
                {slo.exclusions.map((exclusion) => (
                  <li key={exclusion.reason}>
                    {exclusion.reason} — {String(exclusion.samples)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>

      <Card title="The version 1 bar">
        <ul className="flex flex-col gap-3 text-sm">
          {report.criteria.map((criterion) => (
            <li key={criterion.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-3">
                {/* The verdict is a word as well as a colour. WCAG 1.4.1, and
                    also the difference between "not met" and "nobody has
                    checked" is the whole reason there are three verdicts. */}
                <span
                  className={
                    criterion.verdict === 'not_met'
                      ? 'font-semibold text-red-800 dark:text-red-200'
                      : criterion.verdict === 'undemonstrated'
                        ? 'font-semibold text-amber-800 dark:text-amber-200'
                        : 'font-semibold'
                  }
                >
                  {criterion.verdict === 'met'
                    ? 'met'
                    : criterion.verdict === 'not_met'
                      ? 'not met'
                      : 'undemonstrated'}
                </span>
                <span>{criterion.statement}</span>
              </div>
              <p className="text-slate-600 dark:text-slate-400">{criterion.detail}</p>
              {criterion.nextStep === '' ? null : <p>{criterion.nextStep}</p>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Oversales waiting for a verdict">
        {view.incidents.length === 0 ? (
          <Notice tone="info">
            Nothing has been filed. An oversale files itself here when one happens; whether it was a
            defect is a judgement nobody can compute.
          </Notice>
        ) : (
          <ul className="flex flex-col gap-4 text-sm">
            {view.incidents.map((incident) => (
              <li key={incident.id} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-semibold">{incident.classification}</span>
                  <span>{incident.kind}</span>
                  <span className="text-slate-500">{incident.detectedAt.toISOString()}</span>
                </div>
                <p>{incident.summary}</p>
                {incident.finding === null ? null : (
                  <p className="text-slate-600 dark:text-slate-400">{incident.finding}</p>
                )}
                {incident.classification === 'unreviewed' && view.mayClassify ? (
                  <ClassifyForm csrf={csrf} businessId={businessId} incidentId={incident.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {report.stage.stage === 'full' ? null : (
        <Card title="What the stage held back">
          {view.withheld.length === 0 ? (
            <Notice tone="info">
              Nothing has been withheld yet. While a stage is narrower than the catalogue, every
              write it stops is recorded here with the quantity it would have sent — which is what
              this list is for: seeing what the system wants to do before letting it.
            </Notice>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {view.withheld.map((row) => (
                <li key={`${row.mappingId}-${row.withheldAt.toISOString()}`}>
                  <span className="font-semibold">{row.title ?? row.mappingId}</span>{' '}
                  <span>
                    would have been set to {String(row.intendedQuantity)}
                    {row.observedQuantity === null
                      ? ''
                      : `, and the channel holds ${String(row.observedQuantity)}`}
                  </span>{' '}
                  <span className="text-slate-500">
                    {row.withheldAt.toISOString()} — {row.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {view.enrollable.length === 0 ? null : (
        <Card title="Mappings">
          <ul className="flex flex-col gap-2 text-sm">
            {view.enrollable.map((row) => (
              <li key={row.mappingId} className="flex flex-wrap items-center gap-3">
                <span className={row.enrolled ? 'font-semibold' : ''}>
                  {row.title ?? row.mappingId}
                </span>
                <span className="text-slate-500">{row.enrolled ? 'in the pilot' : 'withheld'}</span>
                {view.mayStage ? (
                  <EnrollmentControls
                    csrf={csrf}
                    businessId={businessId}
                    mappingId={row.mappingId}
                    enrolled={row.enrolled}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Drills">
        <div className="flex flex-col gap-3 text-sm">
          {view.drills.length === 0 ? (
            <p className="text-slate-600 dark:text-slate-400">
              None recorded. Two of section 1’s criteria — recovering from a 24-hour outage, and
              installing cleanly from the documentation — leave no trace a query can find, so they
              are recorded by whoever performs them.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {view.drills.map((drill) => (
                <li key={drill.id}>
                  <span className="font-semibold">{drill.succeeded ? 'worked' : 'failed'}</span>{' '}
                  <span>{drill.kind}</span>{' '}
                  <span className="text-slate-500">{drill.performedAt.toISOString()}</span>
                  <p className="text-slate-600 dark:text-slate-400">{drill.summary}</p>
                </li>
              ))}
            </ul>
          )}
          {mayRecordDrill ? <DrillForm csrf={csrf} /> : null}
        </div>
      </Card>
    </main>
  );
}

/** Milliseconds as something a person reads without counting zeroes. */
function formatMs(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }

  return value < 1000
    ? `${String(value)}ms`
    : value < 60_000
      ? `${(value / 1000).toFixed(1)}s`
      : `${(value / 60_000).toFixed(1)} minutes`;
}
