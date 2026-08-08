'use client';

import type { MappingStatus } from '@eim/db';
import { useActionState } from 'react';

import {
  activateMappingAction,
  approveMappingAction,
  archiveMappingAction,
  pauseMappingAction,
  previewActivationAction,
  type InventoryFormState,
} from '../../actions/inventory';
import { Button, Field, Notice, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';

/**
 * Approving, previewing, activating, and pausing one mapping (section 7).
 *
 * Activation is deliberately behind a preview. Section 7 will not let a mapping
 * start until an operator has seen the quantities, the caps, the variation
 * completeness and the conflicts, and blocks outright while the store and the
 * ledger disagree — so the activate form does not exist until the preview has
 * been fetched, and the initialization choice only appears when there is a
 * disagreement to resolve.
 */

const IDLE: InventoryFormState = { status: 'idle' };

function Message({ state }: { state: InventoryFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>;
}

export function MappingControls({
  csrf,
  businessId,
  mappingId,
  status,
  mayApprove,
}: {
  csrf: string;
  businessId: string;
  mappingId: string;
  status: MappingStatus;
  mayApprove: boolean;
}) {
  const [approveState, approveAction, approving] = useActionState(approveMappingAction, IDLE);
  const [previewState, previewAction, previewing] = useActionState(previewActivationAction, IDLE);
  const [activateState, activateAction, activating] = useActionState(activateMappingAction, IDLE);
  const [pauseState, pauseAction, pausing] = useActionState(pauseMappingAction, IDLE);
  const [archiveState, archiveAction, archiving] = useActionState(archiveMappingAction, IDLE);

  const hidden = (
    <>
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="mappingId" value={mappingId} />
    </>
  );

  const preview = previewState.preview;

  return (
    <div className="flex flex-col gap-3">
      <Message state={approveState} />
      <Message state={previewState} />
      <Message state={activateState} />
      <Message state={pauseState} />
      <Message state={archiveState} />

      <div className="flex flex-wrap items-end gap-2">
        {status === 'draft' && mayApprove ? (
          <form action={approveAction} className="flex items-end gap-2">
            {hidden}
            <Field label="Reason">
              <TextInput name="reason" placeholder="checked against the store" />
            </Field>
            <Button type="submit" disabled={approving}>
              Approve
            </Button>
          </form>
        ) : null}

        {status === 'approved' || status === 'paused' ? (
          <form action={previewAction}>
            {hidden}
            <Button type="submit" variant="secondary" disabled={previewing}>
              Preview activation
            </Button>
          </form>
        ) : null}

        {status === 'active' && mayApprove ? (
          <form action={pauseAction} className="flex items-end gap-2">
            {hidden}
            <Field label="Reason">
              <TextInput name="reason" required placeholder="investigating a discrepancy" />
            </Field>
            <Button type="submit" variant="secondary" disabled={pausing}>
              Pause
            </Button>
          </form>
        ) : null}

        {status !== 'archived' && mayApprove ? (
          <form action={archiveAction}>
            {hidden}
            <Button type="submit" variant="secondary" disabled={archiving}>
              Archive
            </Button>
          </form>
        ) : null}
      </div>

      {preview?.mappingId !== mappingId ? null : (
        <div className="flex flex-col gap-3 rounded border border-neutral-200 p-3 text-sm">
          <p>
            <span className="font-mono">{preview.sku}</span> would advertise{' '}
            <strong>{preview.outboundTarget}</strong> on{' '}
            <span className="font-mono">{preview.externalId}</span>, from {preview.availableToSell}{' '}
            available across {preview.locations.length} location
            {preview.locations.length === 1 ? '' : 's'}.
            {preview.channelQuantity === null
              ? ''
              : ` The store currently shows ${String(preview.channelQuantity)}.`}
          </p>

          {preview.variations === null ? null : (
            <p className="text-neutral-600">
              {preview.variations.mapped} of {preview.variations.total} variations on this listing
              are mapped.
              {preview.variations.unmapped.length === 0
                ? ''
                : ` Missing: ${preview.variations.unmapped
                    .map((variation) => variation.sku ?? variation.externalId)
                    .join(', ')}.`}
            </p>
          )}

          {preview.blockers.length === 0 ? null : (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-amber-700">
              {preview.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          )}

          {mayApprove ? (
            <form action={activateAction} className="flex flex-col gap-3">
              {hidden}
              {preview.quantitiesDisagree ? (
                <>
                  <Field
                    label="Which figure is authoritative?"
                    hint="Section 7 blocks activation until this is answered."
                  >
                    <select
                      name="initialization"
                      className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                    >
                      <option value="canonical">This ledger — the store will be corrected</option>
                      <option value="channel">The store — the ledger will be adjusted</option>
                      <option value="explicit">Neither — I counted</option>
                    </select>
                  </Field>
                  <Field label="Counted quantity" hint="Only used when neither figure is right.">
                    <TextInput name="startingQuantity" type="number" min={0} />
                  </Field>
                  {preview.locations.length > 1 ? (
                    <Field label="At which location?">
                      <select
                        name="locationId"
                        className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                      >
                        {preview.locations.map((location) => (
                          <option key={location.locationId} value={location.locationId}>
                            {location.code}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                </>
              ) : (
                <input type="hidden" name="initialization" value="canonical" />
              )}
              <Button type="submit" disabled={activating}>
                Activate
              </Button>
            </form>
          ) : null}
        </div>
      )}
    </div>
  );
}
