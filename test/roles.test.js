import { describe, it, expect } from 'vitest';
import {
  effectiveRole, can, isStaff, assignableRoles, canChangeRoleOf,
  maskName, displayName, displayPhone,
} from '../src/lib/roles.js';

describe('effectiveRole', () => {
  it('env owner wins over any DB role', () => {
    expect(effectiveRole({ role: 'customer' }, true)).toBe('owner');
  });
  it('maps legacy admin to administrator', () => {
    expect(effectiveRole({ role: 'admin' })).toBe('administrator');
  });
  it('unknown/missing roles fall back to customer', () => {
    expect(effectiveRole({ role: 'weird' })).toBe('customer');
    expect(effectiveRole(null)).toBe('customer');
  });
});

describe('capability matrix', () => {
  it('owner can do everything the others can, plus owner-only caps', () => {
    for (const cap of ['manage_admins', 'settings', 'testmode', 'approve_applications', 'refunds', 'manage_experts', 'manage_orders']) {
      expect(can('owner', cap)).toBe(true);
    }
  });
  it('administrator: both manager scopes + approvals, but not admin-management or settings', () => {
    expect(can('administrator', 'manage_experts')).toBe(true);
    expect(can('administrator', 'manage_orders')).toBe(true);
    expect(can('administrator', 'approve_applications')).toBe(true);
    expect(can('administrator', 'view_contact')).toBe(true);
    expect(can('administrator', 'manage_admins')).toBe(false);
    expect(can('administrator', 'settings')).toBe(false);
    expect(can('administrator', 'testmode')).toBe(false);
  });
  it('block_manager: experts only — no approvals, no orders, no contact', () => {
    expect(can('block_manager', 'manage_experts')).toBe(true);
    expect(can('block_manager', 'approve_applications')).toBe(false);
    expect(can('block_manager', 'manage_orders')).toBe(false);
    expect(can('block_manager', 'view_contact')).toBe(false);
    expect(can('block_manager', 'refunds')).toBe(false);
  });
  it('store_manager: orders only — no experts, no contact, no refunds', () => {
    expect(can('store_manager', 'manage_orders')).toBe(true);
    expect(can('store_manager', 'manage_experts')).toBe(false);
    expect(can('store_manager', 'view_contact')).toBe(false);
    expect(can('store_manager', 'refunds')).toBe(false);
  });
  it('experts and customers have no panel access at all', () => {
    expect(can('expert', 'panel')).toBe(false);
    expect(can('customer', 'panel')).toBe(false);
    expect(isStaff('expert')).toBe(false);
    expect(isStaff('block_manager')).toBe(true);
  });
});

describe('role management rules', () => {
  it('administrators can assign manager/expert/customer but never administrator', () => {
    expect(assignableRoles('administrator')).not.toContain('administrator');
    expect(assignableRoles('administrator')).toContain('block_manager');
    expect(assignableRoles('owner')).toContain('administrator');
  });
  it('only owners may change an administrator', () => {
    expect(canChangeRoleOf('administrator', 'administrator')).toBe(false);
    expect(canChangeRoleOf('owner', 'administrator')).toBe(true);
    expect(canChangeRoleOf('administrator', 'store_manager')).toBe(true);
    expect(canChangeRoleOf('block_manager', 'customer')).toBe(false);
  });
});

describe('masking', () => {
  it('masks last name to an initial', () => {
    expect(maskName('Jane Doe')).toBe('Jane D.');
    expect(maskName('Mary Jo van Dyke')).toBe('Mary Jo van D.');
    expect(maskName('Cher')).toBe('Cher');
    expect(maskName('')).toBe('');
  });
  it('displayName masks for managers, not administrators', () => {
    expect(displayName('store_manager', 'Jane Doe')).toBe('Jane D.');
    expect(displayName('administrator', 'Jane Doe')).toBe('Jane Doe');
  });
  it('displayPhone hides numbers below administrator', () => {
    expect(displayPhone('store_manager', '+14155551234')).toBe('🔒 hidden');
    expect(displayPhone('administrator', '+14155551234')).toBe('+14155551234');
    expect(displayPhone('owner', null)).toBe('—');
  });
});
