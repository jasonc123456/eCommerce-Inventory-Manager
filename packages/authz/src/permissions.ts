/**
 * The complete permission catalogue (section 5, D-135).
 *
 * Every server-side authorization check names one of these identifiers. Adding a
 * permission is a deliberate change here plus a migration, never an implicit
 * consequence of adding a screen. The role templates in `roles.ts` are presets
 * over this list, not a parallel mechanism.
 */

export const BUSINESS_PERMISSIONS = [
  // Catalog and mapping
  'view_catalog',
  'view_mappings',
  'propose_mappings',
  'approve_mappings',
  'import_export_mappings',

  // Inventory
  'view_inventory',
  'adjust_inventory',
  'transfer_inventory',
  'manage_locations',
  'manage_inventory_rules',
  'view_reservations',
  'release_reservations',
  'resolve_inventory_conflicts',

  // Kits
  'propose_kit_recipes',
  'approve_kit_recipes',

  // Orders and returns
  'view_orders',
  'view_order_pii',
  'view_sales_totals',
  'confirm_restock',
  'copy_ebay_order_to_woocommerce',

  // Shipping
  'view_shipments',
  'purchase_labels',
  'void_labels',
  'manage_tracking',
  'mark_shipped',

  // Listing operations
  'create_drafts',
  'publish_listings',
  'publish_products',
  'change_prices',

  // Connections
  'view_connection_health',
  'manage_integrations',

  // Synchronization
  'view_sync_activity',
  'retry_jobs',
  'cancel_jobs',
  'run_reconciliation',
  'apply_reconciliation_repairs',
  'apply_bulk_repairs',

  // Governance
  'view_audit_logs',
  'export_data',
  'export_sensitive_data',
  'receive_critical_inventory_alerts',
  'manage_notifications',
  'manage_ai',
  'manage_business_settings',
  'manage_retention_settings',
  'manage_business_security',
  'manage_members',
  'delete_business',
] as const;

export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];

/**
 * Installation administration is a separate authority from business ownership.
 * Holding one of these never confers business membership, and a business owner
 * can never grant one.
 *
 * Backup restoration, keyring rotation, and break-glass recovery are absent by
 * design: they are deployment-host operations, and no web session should be able
 * to invoke them.
 */
export const INSTALLATION_PERMISSIONS = [
  'view_system_health',
  'manage_installation_settings',
  'view_backup_status',
  'run_backup',
  'view_update_status',
  'download_diagnostics',
  'view_installation_audit',
  'manage_installation_administrators',
] as const;

export type InstallationPermission = (typeof INSTALLATION_PERMISSIONS)[number];

/**
 * Permissions that may never be narrowed by a scoped grant.
 *
 * These either spend money, change what the public sees, alter who has access,
 * or disclose data whose sensitivity does not decrease when the subset is
 * smaller. A holder either has the whole-business grant or is denied.
 */
export const UNSCOPABLE_PERMISSIONS: ReadonlySet<BusinessPermission> = new Set([
  'purchase_labels',
  'void_labels',
  'publish_listings',
  'publish_products',
  'change_prices',
  'copy_ebay_order_to_woocommerce',
  'apply_bulk_repairs',
  'manage_integrations',
  'manage_members',
  'manage_business_security',
  'manage_business_settings',
  'manage_retention_settings',
  'export_sensitive_data',
  'delete_business',
]);

/**
 * Actions that require authentication within the previous ten minutes
 * regardless of permission (section 20, sessions and devices).
 */
export const STEP_UP_PERMISSIONS: ReadonlySet<BusinessPermission> = new Set([
  'manage_integrations',
  'publish_listings',
  'publish_products',
  'change_prices',
  'purchase_labels',
  'void_labels',
  'manage_members',
  'manage_business_security',
  'manage_retention_settings',
  'export_sensitive_data',
  'delete_business',
]);

export function isBusinessPermission(value: string): value is BusinessPermission {
  return (BUSINESS_PERMISSIONS as readonly string[]).includes(value);
}

export function isInstallationPermission(value: string): value is InstallationPermission {
  return (INSTALLATION_PERMISSIONS as readonly string[]).includes(value);
}
