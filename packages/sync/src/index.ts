export {
  CHANNEL_WRITE_JOB,
  beginWriteAttempt,
  blockTarget,
  enqueueChannelWrite,
  mappingSerializationKey,
  readTarget,
  recordDesiredTarget,
  recordObservation,
  refreshTargetsForItem,
  settleWriteAttempt,
  type DesiredTargetInput,
  type DesiredTargetResult,
  type TargetRow,
  type WriteSettlement,
} from './targets';

export {
  claimEvent,
  completeEvent,
  fingerprintOf,
  pruneProcessedEvents,
  type EventClaim,
  type EventIdentity,
  type EventSource,
} from './events';

export {
  ingestOrder,
  type IngestInput,
  type IngestResult,
  type LineOutcome,
  type NormalizedOrder,
  type NormalizedOrderLine,
} from './orders';

export {
  applyCancellation,
  applyFulfillment,
  applyRefund,
  confirmRestock,
  declineRestock,
  type ConfirmRestockResult,
  type LifecycleInput,
  type LifecycleResult,
  type LineEffect,
} from './lifecycle';

export {
  CHANNEL_VERIFY_JOB,
  dispatchHandlers,
  handleChannelVerify,
  handleChannelWrite,
  type DispatchDependencies,
} from './dispatch';

export { toJobFailure } from './failures';

export {
  ORDER_POLL_JOB,
  ORDER_STREAM,
  ORDER_SYNC_JOB,
  POLL_OVERLAP_MS,
  handleOrderPoll,
  handleOrderSync,
  requestOrderSync,
} from './pipeline';

export {
  DEFAULT_INTERVAL_SECONDS,
  FIXED_CADENCES,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  clampInterval,
  effectiveCadence,
  isDue,
  type Cadence,
  type CadenceInput,
  type ConnectionHealth,
  type QuotaPressure,
} from './cadence';

export {
  readSyncSettings,
  schedulableConnections,
  scheduleConnection,
  setSyncPaused,
  setTargetInterval,
  type ScheduleResult,
  type SetIntervalResult,
  type SyncSettings,
} from './schedule';

export {
  openConflict,
  reconcile,
  resolveConflict,
  type FindingSummary,
  type ReconcileInput,
  type ReconcileResult,
  type ResolveConflictResult,
} from './reconcile';

export { alertConflict, alertJobDeadLettered, alertMappingBlocked, alertOversold } from './alerts';
