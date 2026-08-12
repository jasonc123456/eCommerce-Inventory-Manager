export {
  acknowledgeAlert,
  alertsDueForReminder,
  nextReminderAt,
  openAlerts,
  openInstallationAlerts,
  raiseAlert,
  recordNotified,
  resolveAlert,
  resolveAlertsAbout,
  snoozeAlert,
  REMINDABLE_SEVERITY_RANK,
  REMINDER_GAPS_MS,
  REPEAT_REMINDER_GAP_MS,
  type RaiseAlertInput,
  type RaisedAlert,
} from './alerts';

export {
  isQuietAt,
  localMinutesOfDay,
  minutesOfDay,
  quietUntil,
  type QuietHours,
} from './quiet-hours';

export {
  bypassesQuietHours,
  permissionFor,
  routeAlert,
  BUSINESS_ALERT_PERMISSION,
  INSTALLATION_ALERT_PERMISSION,
  INVENTORY_SAFETY_KINDS,
  type Delivery,
  type NotificationChannel,
  type Recipient,
  type RoutableAlert,
  type RoutingInput,
} from './routing';

export {
  loadBusinessSettings,
  loadPreference,
  loadPreferences,
  loadQuietHours,
  savePreference,
  saveBusinessSettings,
  type NotificationSettingsInput,
  type PreferenceInput,
} from './preferences';

export type { NotificationDelivery } from '@eim/db';

export {
  claimDueDeliveries,
  deliveriesFor,
  deliveryKey,
  hasBeenNotified,
  markDelivered,
  markFailed,
  recordDeliveries,
  recordSuppressed,
  MAX_DELIVERY_ATTEMPTS,
  type RecordDeliveriesInput,
} from './dispatch';

export {
  alertPayload,
  alertSentence,
  signPayload,
  verifySignature,
  wireRequest,
  type AlertFacts,
  type AlertPayload,
  type WireRequest,
} from './payloads';

export {
  configureDestination,
  createDestinationSecretStore,
  destinationWants,
  listDestinations,
  markDestinationFailing,
  markDestinationReady,
  removeDestination,
  setDestinationEnabled,
  type ConfigureDestinationInput,
  type ConfigureOutcome,
  type DestinationSecretStore,
} from './destinations';

export { listRecipients } from './recipients';

export {
  announceNewAlerts,
  sendDueReminders,
  sendPendingEmail,
  type SweepPorts,
  type SweepResult,
} from './sweep';
