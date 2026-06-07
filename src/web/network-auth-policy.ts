import { isIP } from 'node:net';

const EXPLICIT_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isExplicitlyEnabled(value: string | undefined): boolean {
  return value !== undefined && EXPLICIT_TRUE_VALUES.has(value.trim().toLowerCase());
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (isIP(normalized) === 4 && normalized.startsWith('127.')) {
    return true;
  }
  return normalized.startsWith('::ffff:127.');
}
