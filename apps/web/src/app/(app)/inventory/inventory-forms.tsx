'use client';

import type { InventorySettings, ItemProjection, LocationSummary } from '@eim/inventory';
import { useActionState } from 'react';

import {
  applyAdjustmentAction,
  archiveLocationAction,
  createItemAction,
  createLocationAction,
  previewAdjustmentAction,
  transferStockAction,
  updateInventorySettingsAction,
  updateLocationAction,
  type InventoryFormState,
} from '../../actions/inventory';
import { Button, Field, Notice, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';

/**
 * The forms behind the inventory screens (sections 8, 9, 21).
 *
 * Adjusting stock is two steps, and the split is the point. Section 8 requires
 * every affected channel, location, and kit to be previewed before a change is
 * confirmed, and a preview is not a line of small print above a button — the
 * numbers have to be on the screen before the button that acts on them exists.
 * So `AdjustForm` previews into the same state it later applies from, and the
 * confirm button is not rendered until there is something to confirm.
 */

const IDLE: InventoryFormState = { status: 'idle' };

function Message({ state }: { state: InventoryFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>;
}

export function SettingsForm({
  csrf,
  businessId,
  settings,
}: {
  csrf: string;
  businessId: string;
  settings: InventorySettings;
}) {
  const [state, action, pending] = useActionState(updateInventorySettingsAction, IDLE);

  return (
    <form action={action} className="mt-4 flex flex-col gap-3 border-t border-neutral-200 pt-4">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />
      <Message state={state} />
      <Field label="Default safety stock" hint="Units withheld from sale at every location.">
        <TextInput
          name="defaultSafetyStock"
          type="number"
          min={0}
          defaultValue={settings.defaultSafetyStock}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="splitFulfillment" defaultChecked={settings.splitFulfillment} />
        Allow one order to draw on several locations
      </label>
      <Button type="submit" disabled={pending}>
        Save rules
      </Button>
    </form>
  );
}

export function CreateItemForm({ csrf, businessId }: { csrf: string; businessId: string }) {
  const [state, action, pending] = useActionState(createItemAction, IDLE);

  return (
    <form action={action} className="mt-4 flex flex-col gap-3 border-t border-neutral-200 pt-4">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />
      <Message state={state} />
      <Field label="SKU" hint="Searchable, and correctable later. It is never the item's identity.">
        <TextInput name="sku" required maxLength={128} />
      </Field>
      <Field label="Name">
        <TextInput name="name" required />
      </Field>
      <Button type="submit" disabled={pending}>
        Add item
      </Button>
    </form>
  );
}

export function LocationForms({
  csrf,
  businessId,
  locations,
}: {
  csrf: string;
  businessId: string;
  locations: readonly LocationSummary[];
}) {
  const [createState, createAction, creating] = useActionState(createLocationAction, IDLE);
  const [updateState, updateAction, updating] = useActionState(updateLocationAction, IDLE);
  const [archiveState, archiveAction, archiving] = useActionState(archiveLocationAction, IDLE);

  return (
    <div className="flex flex-col gap-6">
      <form action={createAction} className="flex flex-col gap-3">
        <input type="hidden" name={CSRF_FIELD} value={csrf} />
        <input type="hidden" name="businessId" value={businessId} />
        <Message state={createState} />
        <Field label="Code" hint="Written on the shelf. It cannot be changed afterwards.">
          <TextInput name="code" required maxLength={64} />
        </Field>
        <Field label="Name">
          <TextInput name="name" required />
        </Field>
        <Field label="Priority" hint="Lower is chosen first when an order is allocated.">
          <TextInput name="priority" type="number" min={0} max={10000} defaultValue={100} />
        </Field>
        <Button type="submit" disabled={creating}>
          Add location
        </Button>
      </form>

      {locations.length === 0 ? null : (
        <div className="flex flex-col gap-4 border-t border-neutral-200 pt-4">
          <Message state={updateState} />
          <Message state={archiveState} />
          {locations.map((location) => (
            <div key={location.id} className="flex flex-wrap items-end gap-3 text-sm">
              <form action={updateAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name={CSRF_FIELD} value={csrf} />
                <input type="hidden" name="businessId" value={businessId} />
                <input type="hidden" name="locationId" value={location.id} />
                <span className="font-mono">{location.code}</span>
                <Field label="Name">
                  <TextInput name="name" defaultValue={location.name} />
                </Field>
                <Field label="Priority">
                  <TextInput
                    name="priority"
                    type="number"
                    min={0}
                    max={10000}
                    defaultValue={location.priority}
                  />
                </Field>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="isActive" defaultChecked={location.isActive} />
                  Active
                </label>
                <Button type="submit" disabled={updating}>
                  Save
                </Button>
              </form>
              <form action={archiveAction}>
                <input type="hidden" name={CSRF_FIELD} value={csrf} />
                <input type="hidden" name="businessId" value={businessId} />
                <input type="hidden" name="locationId" value={location.id} />
                <Button type="submit" variant="secondary" disabled={archiving}>
                  Archive
                </Button>
              </form>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdjustForm({
  csrf,
  businessId,
  canonicalItemId,
  locations,
}: {
  csrf: string;
  businessId: string;
  canonicalItemId: string;
  locations: readonly { readonly locationId: string; readonly code: string }[];
}) {
  const [previewState, previewAction, previewing] = useActionState(previewAdjustmentAction, IDLE);
  const [applyState, applyAction, applying] = useActionState(applyAdjustmentAction, IDLE);

  return (
    <div className="flex flex-col gap-4">
      <form action={previewAction} className="flex flex-col gap-3">
        <input type="hidden" name={CSRF_FIELD} value={csrf} />
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="canonicalItemId" value={canonicalItemId} />
        <Message state={previewState} />
        <Field label="Location">
          <select
            name="locationId"
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            {locations.map((location) => (
              <option key={location.locationId} value={location.locationId}>
                {location.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Change">
          <select
            name="mode"
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="absolute">There are this many</option>
            <option value="delta">Change by this many</option>
          </select>
        </Field>
        <Field label="Quantity">
          <TextInput name="quantity" type="number" required />
        </Field>
        <Button type="submit" variant="secondary" disabled={previewing}>
          Preview
        </Button>
      </form>

      {previewState.projection === undefined ? null : (
        <ProjectionTable projection={previewState.projection} />
      )}

      {previewState.proposed === undefined ? null : (
        <form action={applyAction} className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <input type="hidden" name="businessId" value={businessId} />
          {/* The change that was shown, not whatever is still typed above. */}
          <input
            type="hidden"
            name="canonicalItemId"
            value={previewState.proposed.canonicalItemId}
          />
          <input type="hidden" name="locationId" value={previewState.proposed.locationId} />
          <input type="hidden" name="mode" value="delta" />
          <input type="hidden" name="quantity" value={previewState.proposed.quantityDelta} />
          <Message state={applyState} />
          <p className="text-sm text-neutral-600">
            Confirming will change that location by {previewState.proposed.quantityDelta}.
          </p>
          <Field label="Reason" hint="Section 8 admits no adjustment without one.">
            <TextInput name="reason" required />
          </Field>
          <Button type="submit" disabled={applying}>
            Apply adjustment
          </Button>
        </form>
      )}
    </div>
  );
}

export function TransferForm({
  csrf,
  businessId,
  canonicalItemId,
  locations,
}: {
  csrf: string;
  businessId: string;
  canonicalItemId: string;
  locations: readonly { readonly locationId: string; readonly code: string }[];
}) {
  const [state, action, pending] = useActionState(transferStockAction, IDLE);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="canonicalItemId" value={canonicalItemId} />
      <Message state={state} />
      <Field label="From">
        <select
          name="fromLocationId"
          className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
        >
          {locations.map((location) => (
            <option key={location.locationId} value={location.locationId}>
              {location.code}
            </option>
          ))}
        </select>
      </Field>
      <Field label="To">
        <select
          name="toLocationId"
          className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
        >
          {locations.map((location) => (
            <option key={location.locationId} value={location.locationId}>
              {location.code}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Units">
        <TextInput name="quantity" type="number" min={1} required />
      </Field>
      <Field label="Reason">
        <TextInput name="reason" />
      </Field>
      <Button type="submit" disabled={pending}>
        Transfer
      </Button>
    </form>
  );
}

/** Section 8's dry run, on the screen: locations, channels, and kits. */
export function ProjectionTable({ projection }: { projection: ItemProjection }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-neutral-600">
        Available to sell would go from {projection.availableToSell} to{' '}
        {projection.projectedAvailableToSell}.
      </p>

      <table className="w-full text-left">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1">Location</th>
            <th className="py-1">On hand</th>
            <th className="py-1">Reserved</th>
            <th className="py-1">Withheld</th>
            <th className="py-1">Available</th>
          </tr>
        </thead>
        <tbody>
          {projection.locations.map((location) => (
            <tr key={location.locationId} className="border-t border-neutral-200">
              <td className="py-1 font-mono">{location.code}</td>
              <td className="py-1">
                {location.onHand}
                {location.projectedOnHand === location.onHand
                  ? null
                  : ` → ${String(location.projectedOnHand)}`}
              </td>
              <td className="py-1">{location.reserved}</td>
              <td className="py-1">{location.safetyStock}</td>
              <td className="py-1">
                {location.availableToSell}
                {location.projectedAvailableToSell === location.availableToSell
                  ? null
                  : ` → ${String(location.projectedAvailableToSell)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {projection.channels.length === 0 ? (
        <p className="text-neutral-600">No channel sells this item yet.</p>
      ) : (
        <table className="w-full text-left">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-1">Channel</th>
              <th className="py-1">Store shows</th>
              <th className="py-1">Would advertise</th>
              <th className="py-1">Writes?</th>
            </tr>
          </thead>
          <tbody>
            {projection.channels.map((channel) => (
              <tr key={channel.mappingId} className="border-t border-neutral-200">
                <td className="py-1">
                  {channel.provider} <span className="font-mono">{channel.externalId}</span>
                </td>
                <td className="py-1">{channel.channelQuantity ?? '—'}</td>
                <td className="py-1">
                  {channel.currentTarget}
                  {channel.projectedTarget === channel.currentTarget
                    ? null
                    : ` → ${String(channel.projectedTarget)}`}
                </td>
                <td className="py-1 text-neutral-600">
                  {channel.suppressed
                    ? 'held back to preserve the backorder count'
                    : (channel.notWritableBecause ?? 'yes')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {projection.affectedKits.length === 0 ? null : (
        <p className="text-neutral-600">
          Kits recalculated by this change:{' '}
          {projection.affectedKits.map((kit) => kit.sku).join(', ')}.
        </p>
      )}
    </div>
  );
}
