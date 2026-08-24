// Staff role system. Pure module (no I/O) so the whole permission matrix is
// unit-testable.
//
// Hierarchy (each row is a superset of nothing — capabilities are explicit):
//   owner          — env ADMIN_TELEGRAM_IDS; everything, incl. managing
//                    Administrators, fees/flags, test mode.
//   administrator  — Block Manager + Store Manager powers, plus application
//                    approvals, refunds, payouts, catalog, broadcast, reports,
//                    and promoting users to manager/expert roles. Sees full
//                    contact info (phone). Cannot manage other Administrators.
//   block_manager  — manages Block Experts: edit any expert's schedule, rate,
//                    base address, active flag; assign/handle bookings. No
//                    application approvals, no orders, masked contact.
//   store_manager  — manages store orders: view orders + crypto payment
//                    status, dispatch. Sees what fulfilment needs (delivery
//                    address, first name + last initial, Telegram handle) —
//                    no phone numbers. Telegram-first by design.
//   expert         — a Block Expert (self-service portal only, no panel).
//   customer       — everyone else.
//
// Legacy DB value 'admin' is treated as 'administrator'.

export const STAFF_ROLES = ['owner', 'administrator', 'block_manager', 'store_manager'];

const CAPS = {
  owner: new Set([
    'panel', 'view_users', 'view_contact',
    'manage_experts', 'manage_orders',
    'approve_applications', 'refunds', 'payouts',
    'manage_roles', 'manage_admins',
    'catalog', 'settings', 'broadcast', 'reports', 'testmode',
  ]),
  administrator: new Set([
    'panel', 'view_users', 'view_contact',
    'manage_experts', 'manage_orders',
    'approve_applications', 'refunds', 'payouts',
    'manage_roles',
    'catalog', 'broadcast', 'reports',
  ]),
  block_manager: new Set(['panel', 'view_users', 'manage_experts']),
  store_manager: new Set(['panel', 'view_users', 'manage_orders']),
  expert: new Set(),
  customer: new Set(),
};

// Resolve a user's effective role. Owners are defined by env (isOwner), which
// wins regardless of DB role; legacy 'admin' rows count as administrator.
export function effectiveRole(user, isOwner = false) {
  if (isOwner) return 'owner';
  const role = user?.role;
  if (role === 'admin') return 'administrator';
  return CAPS[role] ? role : 'customer';
}

export function can(role, cap) {
  return CAPS[role]?.has(cap) || false;
}

export function isStaff(role) {
  return STAFF_ROLES.includes(role);
}

// Which roles an actor may assign. Administrators can hand out the manager
// and expert roles (and demote to customer); only Owners touch Administrators.
export function assignableRoles(actorRole) {
  if (actorRole === 'owner') return ['administrator', 'block_manager', 'store_manager', 'expert', 'customer'];
  if (actorRole === 'administrator') return ['block_manager', 'store_manager', 'expert', 'customer'];
  return [];
}

// May `actorRole` change the role of someone currently holding `targetRole`?
// (Demoting an Administrator is owner-only, same as promoting one.)
export function canChangeRoleOf(actorRole, targetRole) {
  if (!can(actorRole, 'manage_roles')) return false;
  if (targetRole === 'administrator' || targetRole === 'owner') return actorRole === 'owner';
  return true;
}

// "Jane Doe" → "Jane D." for staff without the view_contact capability.
export function maskName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(' ')} ${parts[parts.length - 1][0]}.`;
}

// Display a name respecting the viewer's contact capability.
export function displayName(role, fullName) {
  return can(role, 'view_contact') ? String(fullName || '') : maskName(fullName);
}

// Display a phone number respecting the viewer's contact capability.
// Telegram-first: staff coordinate in-bot; only administrator+ see phones.
export function displayPhone(role, phone) {
  if (!phone) return '—';
  return can(role, 'view_contact') ? phone : '🔒 hidden';
}

export const ROLE_LABELS = {
  owner: 'Owner',
  administrator: 'Administrator',
  block_manager: 'Block Manager',
  store_manager: 'Store Manager',
  expert: 'Block Expert',
  customer: 'Customer',
  admin: 'Administrator', // legacy
};
