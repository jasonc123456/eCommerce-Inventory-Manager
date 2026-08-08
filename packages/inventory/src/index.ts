export {
  DEFAULT_CONSUMPTION_MODE,
  DEFAULT_SAFETY_STOCK,
  defaultSettings,
  readSettings,
  updateSettings,
  type InventorySettings,
  type SettingsChange,
  type SettingsReader,
  type SettingsUpdateResult,
  type SettingsWriter,
} from './settings';

export {
  archiveLocation,
  createLocation,
  linkLocationToChannel,
  listLocations,
  readLocationAddress,
  setLocationAddress,
  unlinkLocationFromChannel,
  updateLocation,
  type ArchiveLocationResult,
  type CreateLocationInput,
  type CreateLocationResult,
  type LinkLocationResult,
  type LocationReader,
  type LocationSummary,
  type LocationWriter,
  type PostalAddress,
  type SetAddressResult,
  type UpdateLocationInput,
  type UpdateLocationResult,
} from './locations';

export {
  createCanonicalItem,
  listCanonicalItems,
  readItemBalances,
  setItemLocationSettings,
  updateCanonicalItem,
  type CanonicalItemSummary,
  type CreateItemInput,
  type CreateItemResult,
  type ItemLocationSettings,
  type ItemReader,
  type ItemWriter,
  type ResolvedItemLocation,
  type SetItemLocationResult,
  type UpdateItemInput,
  type UpdateItemResult,
} from './items';

export { isCheckViolation, isUniqueViolation } from './errors';
