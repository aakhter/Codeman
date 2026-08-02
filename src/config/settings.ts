/**
 * @fileoverview Safe normalization for persisted settings.json values.
 *
 * JSON itself may validly contain null, arrays, or primitives. Codeman settings
 * require an object, so malformed persisted values fall back to an empty object
 * at each settings-consumer boundary.
 */

export function normalizeSettingsObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
