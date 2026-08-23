/** @fileoverview Trusted per-recipient payload selection for legacy session-order invalidations. */
import type { SessionOrderProjectionChange } from '../tab-layout-service.js';
import type { AuthUser } from '../types.js';

export function sessionOrderPayloadFor(
  identity: AuthUser | undefined,
  change: SessionOrderProjectionChange
): { order: string[] } | undefined {
  if (!identity || identity.role === 'admin') {
    return change.globalChanged ? { order: [...change.globalOrder] } : undefined;
  }
  const order = change.changedOwnerOrders[identity.username];
  return order ? { order: [...order] } : undefined;
}
