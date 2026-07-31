// Minimal ambient declaration for node:sqlite (DatabaseSync/StatementSync).
// Unflagged (no --experimental-sqlite needed) on Node 24+, flagged on Node 22
// (what CI runs) — always accessed via a dynamic `await import('node:sqlite')`
// wrapped in try/catch, so it degrades to null rather than throwing when
// unavailable. The pinned @types/node in this repo (^20.x) ships no coverage
// for this module, so this declares only the surface actually used
// (see findOpencodeSessionId() in src/web/routes/session-routes.ts).
declare module 'node:sqlite' {
  export interface DatabaseSyncOptions {
    readOnly?: boolean;
    [key: string]: unknown;
  }

  export class StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
