import { BUSINESS_PERMISSIONS, type BusinessPermission } from './permissions';

/**
 * Role templates from the section 20 matrix.
 *
 * A template is a starting set, not a ceiling: owners customize per-user grants
 * on top of it. Cells the matrix marks "Yes with explicit grant" are deliberately
 * absent here, because the whole point of that wording is that the permission
 * does not arrive with the role.
 *
 * Owner is not listed. Owners hold every business permission implicitly and
 * cannot have one removed, so materializing an Owner set would create a second
 * source of truth that could drift from the catalogue.
 */
export type RoleTemplateName = 'manager' | 'operator' | 'viewer';

const VIEWER: readonly BusinessPermission[] = [
  'view_catalog',
  'view_mappings',
  'view_inventory',
  'view_reservations',
  'view_shipments',
  'view_sync_activity',
  'view_connection_health',
];

const OPERATOR: readonly BusinessPermission[] = [
  ...VIEWER,
  'view_orders',
  'adjust_inventory',
  'transfer_inventory',
  'propose_mappings',
  'propose_kit_recipes',
  'resolve_inventory_conflicts',
  'create_drafts',
  'confirm_restock',
  // Retry is normally assigned scoped by connection. The template grants the
  // permission; the scope is chosen when the membership is created.
  'retry_jobs',
];

const MANAGER: readonly BusinessPermission[] = [
  ...OPERATOR,
  'view_order_pii',
  'view_sales_totals',
  'approve_mappings',
  'approve_kit_recipes',
  'import_export_mappings',
  'manage_locations',
  'manage_inventory_rules',
  'release_reservations',
  'apply_bulk_repairs',
  'purchase_labels',
  'void_labels',
  'manage_tracking',
  'mark_shipped',
  // "Cancel jobs or manage global reconciliation" is "Yes with explicit grant"
  // for Manager, so cancel_jobs, run_reconciliation, and
  // apply_reconciliation_repairs are deliberately absent from this template.
  'view_audit_logs',
  'export_data',
  'receive_critical_inventory_alerts',
  'manage_notifications',
];

export const ROLE_TEMPLATES: Readonly<Record<RoleTemplateName, readonly BusinessPermission[]>> = {
  viewer: VIEWER,
  operator: OPERATOR,
  manager: MANAGER,
};

/** Every business permission, which is what an owner effectively holds. */
export function ownerPermissions(): readonly BusinessPermission[] {
  return BUSINESS_PERMISSIONS;
}
