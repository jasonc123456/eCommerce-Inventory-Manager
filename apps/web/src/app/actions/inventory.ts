'use server';

import { type AuditAction } from '@eim/audit';
import { authorize, type BusinessPermission } from '@eim/authz';
import {
  activateMapping,
  applyAdjustment,
  approveMapping,
  archiveLocation,
  archiveMapping,
  createCanonicalItem,
  createLocation,
  pauseMapping,
  previewActivation,
  projectItem,
  proposeMapping,
  transferStock,
  updateLocation,
  updateSettings,
  type ActivationPreview,
  type ItemProjection,
} from '@eim/inventory';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { field, trimmedField } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

/**
 * Locations, stock, and mappings, from the browser (sections 7, 8, 9, 21).
 *
 * Every action does the same four things in the same order: resolve the session,
 * resolve the subject in the business named by the form, ask `authorize`, and
 * only then act. The business identifier is never trusted — the subject is
 * loaded *for that business*, so naming one you are not a member of produces a
 * subject of null and a denial.
 *
 * The permissions differ per action on purpose, because section 5 separates
 * them: proposing a mapping and approving one are different grants, as are
 * adjusting stock and moving it between locations. A screen that checked one
 * coarse "inventory" permission would quietly hand an operator the approval
 * authority the catalogue deliberately withheld.
 *
 * Nothing here writes to a provider. Activating a mapping makes future writes
 * permitted; it does not perform one.
 */

export interface InventoryFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
  /** Section 8's dry run, shown before a change is confirmed. */
  readonly projection?: ItemProjection;
  /** Section 7's activation preview. */
  readonly preview?: ActivationPreview;
  /**
   * The change the projection was computed for, carried back so the confirm
   * step applies exactly what was shown rather than whatever is still typed in
   * the fields.
   */
  readonly proposed?: {
    readonly canonicalItemId: string;
    readonly locationId: string;
    readonly quantityDelta: number;
  };
}

async function requirePermission(
  permission: BusinessPermission,
  businessId: string,
  form: FormData,
): Promise<
  | { readonly ok: true; readonly userId: string; readonly record: RecordAudit }
  | { readonly ok: false; readonly message: string }
> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    await context.audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId,
      detail: { permission, reason: 'not_a_member' },
    });

    return { ok: false, message: 'You are not a member of that business.' };
  }

  const decision = authorize(subject, permission);

  if (!decision.allowed) {
    await context.audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId,
      detail: { permission, reason: decision.reason },
    });

    return { ok: false, message: 'You do not have permission to do that in this business.' };
  }

  // Checked last, once the session it is derived from is in hand: a missing
  // token is not a decision about permission, it is a request that did not come
  // from this application's own form.
  assertCsrf(form, context.session);

  return {
    ok: true,
    userId: context.user.id,
    record: async (action, detail) => {
      await context.audit.record(db, { action, result: 'success', businessId, detail });
    },
  };
}

type RecordAudit = (action: AuditAction, detail: Record<string, unknown>) => Promise<void>;

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export async function createLocationAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('manage_locations', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const priority = Number.parseInt(trimmedField(form, 'priority'), 10);
  const result = await createLocation(db, {
    businessId,
    code: field(form, 'code'),
    name: field(form, 'name'),
    description: trimmedField(form, 'description') || null,
    ...(Number.isNaN(priority) ? {} : { priority }),
  });

  if (result.outcome === 'code_taken') {
    return { status: 'error', message: 'A location already uses that code.' };
  }
  if (result.outcome === 'invalid') {
    return { status: 'error', message: capitalize(result.reason) };
  }

  await guard.record('inventory.location.created', { locationId: result.locationId });
  revalidatePath('/inventory/locations');

  return { status: 'done', message: 'Location created.' };
}

export async function updateLocationAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('manage_locations', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const locationId = field(form, 'locationId');
  const priority = Number.parseInt(trimmedField(form, 'priority'), 10);
  const result = await updateLocation(db, {
    businessId,
    locationId,
    ...(trimmedField(form, 'name') === '' ? {} : { name: field(form, 'name') }),
    ...(Number.isNaN(priority) ? {} : { priority }),
    isActive: form.get('isActive') === 'on',
  });

  if (result.outcome === 'not_found') {
    return { status: 'error', message: 'That location no longer exists.' };
  }
  if (result.outcome === 'invalid') {
    return { status: 'error', message: capitalize(result.reason) };
  }

  await guard.record('inventory.location.updated', { locationId });
  revalidatePath('/inventory/locations');

  return { status: 'done', message: 'Location updated.' };
}

export async function archiveLocationAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('manage_locations', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const locationId = field(form, 'locationId');
  const result = await archiveLocation(db, { businessId, locationId });

  if (result.outcome === 'holds_stock') {
    return {
      status: 'error',
      message: `That location still holds stock for ${String(result.items)} item${result.items === 1 ? '' : 's'}. Transfer them out first, so the units end up somewhere rather than nowhere.`,
    };
  }
  if (result.outcome === 'not_found') {
    return { status: 'error', message: 'That location no longer exists.' };
  }

  await guard.record('inventory.location.archived', { locationId });
  revalidatePath('/inventory/locations');

  return { status: 'done', message: 'Location archived. Its code is free to be used again.' };
}

export async function updateInventorySettingsAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('manage_inventory_rules', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const defaultSafetyStock = Number.parseInt(trimmedField(form, 'defaultSafetyStock'), 10);
  const result = await updateSettings(db, {
    businessId,
    ...(Number.isNaN(defaultSafetyStock) ? {} : { defaultSafetyStock }),
    splitFulfillment: form.get('splitFulfillment') === 'on',
  });

  if (result.outcome === 'invalid') {
    return { status: 'error', message: capitalize(result.reason) };
  }

  await guard.record('inventory.settings.updated', {
    defaultSafetyStock: result.settings.defaultSafetyStock,
    splitFulfillment: result.settings.splitFulfillment,
  });
  revalidatePath('/inventory');

  return { status: 'done', message: 'Inventory settings saved.' };
}

// ---------------------------------------------------------------------------
// Items and stock
// ---------------------------------------------------------------------------

export async function createItemAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('manage_inventory_rules', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const result = await createCanonicalItem(db, {
    businessId,
    sku: field(form, 'sku'),
    name: field(form, 'name'),
  });

  if (result.outcome === 'sku_taken') {
    return { status: 'error', message: 'An item in this business already uses that SKU.' };
  }
  if (result.outcome === 'invalid') {
    return { status: 'error', message: capitalize(result.reason) };
  }

  await guard.record('inventory.item.created', { canonicalItemId: result.canonicalItemId });
  revalidatePath('/inventory');

  return { status: 'done', message: 'Item created.' };
}

/**
 * Section 8's dry run: what the change would do, before it is confirmed.
 *
 * Deliberately a separate action from applying it. A single call with a "really
 * do it" flag is one typo away from doing it for real.
 */
export async function previewAdjustmentAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('adjust_inventory', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const canonicalItemId = field(form, 'canonicalItemId');
  const locationId = field(form, 'locationId');
  const quantity = Number.parseInt(field(form, 'quantity'), 10);

  if (Number.isNaN(quantity)) {
    return { status: 'error', message: 'Enter a whole number of units.' };
  }

  const quantityDelta =
    field(form, 'mode') === 'absolute'
      ? await deltaForAbsolute(businessId, canonicalItemId, locationId, quantity)
      : quantity;

  const projection = await projectItem(db, {
    businessId,
    canonicalItemId,
    hypothetical: [{ locationId, quantityDelta }],
  });

  if (projection === null) {
    return { status: 'error', message: 'That item no longer exists.' };
  }

  return {
    status: 'idle',
    projection,
    proposed: { canonicalItemId, locationId, quantityDelta },
  };
}

export async function applyAdjustmentAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('adjust_inventory', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const canonicalItemId = field(form, 'canonicalItemId');
  const quantity = Number.parseInt(field(form, 'quantity'), 10);
  const reason = trimmedField(form, 'reason');

  if (Number.isNaN(quantity)) {
    return { status: 'error', message: 'Enter a whole number of units.' };
  }
  if (reason === '') {
    return { status: 'error', message: 'Say why the quantity is changing. Section 8 requires it.' };
  }

  const result = await applyAdjustment(db, {
    businessId,
    canonicalItemId,
    locationId: field(form, 'locationId'),
    // Always a signed change: it is what the preview displayed, and section 8's
    // absolute figure was turned into one against the balance at preview time.
    change: { mode: 'delta', quantityDelta: quantity },
    reason,
    actorUserId: guard.userId,
  });

  if (result.outcome === 'insufficient') {
    const [shortfall] = result.shortfalls;

    return {
      status: 'error',
      message: `That would take the location ${String(shortfall?.short ?? 0)} unit${shortfall?.short === 1 ? '' : 's'} below zero. Stock is never negative; a shortage is recorded separately.`,
    };
  }
  if (result.outcome === 'unchanged') {
    return { status: 'done', message: 'That is already the recorded quantity. Nothing changed.' };
  }
  if (result.outcome !== 'adjusted') {
    return {
      status: 'error',
      message:
        result.outcome === 'invalid' ? capitalize(result.reason) : 'That item no longer exists.',
    };
  }

  await guard.record('inventory.adjusted', { canonicalItemId, entryId: result.entryId });
  revalidatePath(`/inventory/${canonicalItemId}`);

  return { status: 'done', message: `Adjusted. The location now holds ${String(result.onHand)}.` };
}

export async function transferStockAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('transfer_inventory', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const canonicalItemId = field(form, 'canonicalItemId');
  const quantity = Number.parseInt(field(form, 'quantity'), 10);

  if (Number.isNaN(quantity)) {
    return { status: 'error', message: 'Enter a whole number of units.' };
  }

  const result = await transferStock(db, {
    businessId,
    canonicalItemId,
    fromLocationId: field(form, 'fromLocationId'),
    toLocationId: field(form, 'toLocationId'),
    quantity,
    reason: trimmedField(form, 'reason') || null,
    actorUserId: guard.userId,
  });

  if (result.outcome === 'insufficient') {
    return { status: 'error', message: 'The source location does not hold that many units.' };
  }
  if (result.outcome === 'invalid') {
    return { status: 'error', message: capitalize(result.reason) };
  }

  await guard.record('inventory.transferred', { canonicalItemId, quantity });
  revalidatePath(`/inventory/${canonicalItemId}`);

  return { status: 'done', message: 'Transferred.' };
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

export async function proposeMappingAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('propose_mappings', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const result = await proposeMapping(db, {
    businessId,
    connectionId: field(form, 'connectionId'),
    providerItemId: field(form, 'providerItemId'),
    canonicalItemId: field(form, 'canonicalItemId'),
    // `getAll` yields files as well as strings; only the strings are location
    // identifiers, and a file here is a malformed request rather than a choice.
    locationIds: form.getAll('locationIds').filter((value) => typeof value === 'string'),
    createdByUserId: guard.userId,
  });

  if (result.outcome === 'entity_already_mapped') {
    return {
      status: 'error',
      message:
        'That channel entity already belongs to a canonical item. Archive the existing mapping first.',
    };
  }
  if (result.outcome === 'invalid') {
    return { status: 'error', message: capitalize(result.reason) };
  }

  await guard.record('inventory.mapping.proposed', { mappingId: result.mappingId });
  revalidatePath('/mappings');

  return { status: 'done', message: 'Mapping proposed. It synchronizes nothing until approved.' };
}

export async function approveMappingAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('approve_mappings', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const mappingId = field(form, 'mappingId');
  const result = await approveMapping(db, {
    businessId,
    mappingId,
    approvedByUserId: guard.userId,
    reason: trimmedField(form, 'reason') || null,
  });

  if (result.outcome === 'not_found') {
    return { status: 'error', message: 'That mapping no longer exists.' };
  }
  if (result.outcome === 'not_approvable') {
    return { status: 'error', message: `That mapping is already ${result.status}.` };
  }

  await guard.record('inventory.mapping.approved', { mappingId });
  revalidatePath('/mappings');

  return { status: 'done', message: 'Approved. Review the preview, then activate it.' };
}

/** Section 7's preview: everything that must be seen before a mapping goes live. */
export async function previewActivationAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('view_mappings', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const result = await previewActivation(db, { businessId, mappingId: field(form, 'mappingId') });

  return result.outcome === 'not_found'
    ? { status: 'error', message: 'That mapping no longer exists.' }
    : { status: 'idle', preview: result.preview };
}

export async function activateMappingAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('approve_mappings', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const mappingId = field(form, 'mappingId');
  const source = field(form, 'initialization');
  const quantity = Number.parseInt(trimmedField(form, 'startingQuantity'), 10);
  const locationId = trimmedField(form, 'locationId');

  const result = await activateMapping(db, {
    businessId,
    mappingId,
    actorUserId: guard.userId,
    initialization:
      source === 'channel'
        ? { from: 'channel', ...(locationId === '' ? {} : { locationId }) }
        : source === 'explicit'
          ? {
              from: 'explicit',
              quantity: Number.isNaN(quantity) ? 0 : quantity,
              ...(locationId === '' ? {} : { locationId }),
            }
          : { from: 'canonical' },
  });

  if (result.outcome === 'blocked') {
    return { status: 'error', message: result.blockers.map(capitalize).join(' ') };
  }
  if (result.outcome === 'not_approved') {
    return { status: 'error', message: 'A mapping is approved before it is activated.' };
  }
  if (result.outcome !== 'activated') {
    return {
      status: 'error',
      message:
        result.outcome === 'invalid' ? capitalize(result.reason) : 'That mapping no longer exists.',
    };
  }

  await guard.record('inventory.mapping.activated', {
    mappingId,
    outboundTarget: result.outboundTarget,
  });
  revalidatePath('/mappings');

  return {
    status: 'done',
    message: `Active. This channel will be told to advertise ${String(result.outboundTarget)}.`,
  };
}

export async function pauseMappingAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('approve_mappings', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const mappingId = field(form, 'mappingId');
  const reason = trimmedField(form, 'reason');

  if (reason === '') {
    return {
      status: 'error',
      message:
        'Say why it is paused. A mapping that has silently stopped looks like one that works.',
    };
  }

  const result = await pauseMapping(db, {
    businessId,
    mappingId,
    reason,
    actorUserId: guard.userId,
  });

  if (result.outcome === 'not_found') {
    return { status: 'error', message: 'That mapping no longer exists.' };
  }
  if (result.outcome === 'not_active') {
    return { status: 'error', message: `That mapping is ${result.status}, not active.` };
  }

  await guard.record('inventory.mapping.paused', { mappingId, reason });
  revalidatePath('/mappings');

  return { status: 'done', message: 'Paused. Nothing will be written to this channel entity.' };
}

export async function archiveMappingAction(
  _previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const guard = await requirePermission('approve_mappings', businessId, form);

  if (!guard.ok) {
    return { status: 'error', message: guard.message };
  }

  const mappingId = field(form, 'mappingId');
  const result = await archiveMapping(db, {
    businessId,
    mappingId,
    reason: trimmedField(form, 'reason') || null,
    actorUserId: guard.userId,
  });

  if (result.outcome === 'not_found') {
    return { status: 'error', message: 'That mapping no longer exists.' };
  }

  await guard.record('inventory.mapping.archived', { mappingId });
  revalidatePath('/mappings');

  return {
    status: 'done',
    message: 'Archived. Its history is kept, and the channel entity can be mapped again.',
  };
}

async function deltaForAbsolute(
  businessId: string,
  canonicalItemId: string,
  locationId: string,
  quantity: number,
): Promise<number> {
  const { db } = runtime();
  const projection = await projectItem(db, { businessId, canonicalItemId });
  const here = projection?.locations.find((location) => location.locationId === locationId);

  return quantity - (here?.onHand ?? 0);
}

function capitalize(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
