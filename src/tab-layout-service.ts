/**
 * @fileoverview Owner-scoped authoritative tab-layout coordination.
 *
 * This is the single mutation boundary between the pure layout model, persisted
 * state, live sessions, saved webviews, and SSE. Lifecycle callers describe one
 * completed server action; this service performs at most one versioned write.
 */
import type { StateStore } from './state-store.js';
import { mergeSessionOrder, normalizeSessionOrder } from './session-order.js';
import { applyLegacySessionRank, recomposeGlobalSessionOrder } from './tab-layout-legacy-order.js';
import {
  flattenOwnerSessionOrder,
  materializeOrphans,
  normalizeTabLayout,
  TabLayoutValidationError,
  validateTabLayout,
  type TabLayout,
  type TabRef,
  type TabRefMetadata,
} from './tab-layout.js';
import {
  normalizeOrMigrateOwnerTabLayout,
  SINGLE_USER_LAYOUT_OWNER,
  type TabLayoutSessionRecord,
  type TabLayoutWebviewRecord,
} from './tab-layout-persistence.js';
import { SseEvent } from './web/sse-events.js';

export interface TabLayoutSessionLike {
  id: string;
  owner?: string;
  createdAt: number;
  parentSessionId?: string;
}

interface TabLayoutServiceDeps {
  store: Pick<
    StateStore,
    'getTabLayout' | 'getTabLayouts' | 'getSessions' | 'getSessionOrder' | 'commitTabLayoutProjection'
  >;
  sessions: ReadonlyMap<string, TabLayoutSessionLike>;
  readWebviews(): Promise<readonly TabLayoutWebviewRecord[]>;
  broadcast(event: string, data: unknown): void;
  broadcastSessionOrder(change: SessionOrderProjectionChange): void;
  now?: () => string;
}

export type TabLayoutPutResult = { status: 'updated'; layout: TabLayout } | { status: 'conflict'; layout: TabLayout };

export interface LegacyOrderActor {
  owner: string;
  isAdmin: boolean;
}

export interface SessionOrderProjectionChange {
  changedOwnerOrders: Record<string, string[]>;
  globalOrder: string[];
  globalChanged: boolean;
}

export interface LegacyOrderPutResult extends SessionOrderProjectionChange {
  order: string[];
}

export interface RemovedTabLayoutSession {
  id: string;
  owner?: string;
}

interface PreparedOwnerLayout {
  current: TabLayout | null;
  authoritative: TabLayout;
  metadata: TabRefMetadata[];
  needsReconciliationCommit: boolean;
}

interface OwnerProjectionPublication {
  owner: string;
  previous: TabLayout | null;
  next: TabLayout;
  metadata: readonly TabRefMetadata[];
  excludedSessionIds?: ReadonlySet<string>;
}

const ownerOf = (record: { owner?: string }): string => record.owner ?? SINGLE_USER_LAYOUT_OWNER;
const refKey = (ref: Pick<TabRef, 'kind' | 'id'>): string => `${ref.kind}\u0000${ref.id}`;
const sameLayout = (a: TabLayout, b: TabLayout): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export class TabLayoutService {
  private restorationState: 'pending' | 'complete' | 'failed' | 'skipped' = 'pending';
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(private readonly deps: TabLayoutServiceDeps) {}

  private async withOwner<T>(owner: string, task: () => Promise<T>): Promise<T> {
    const previous = this.ownerQueues.get(owner) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.ownerQueues.set(owner, tail);
    try {
      return await run;
    } finally {
      if (this.ownerQueues.get(owner) === tail) this.ownerQueues.delete(owner);
    }
  }

  /** Acquire multiple owner queues in stable order so overlapping bulk cleanups cannot deadlock. */
  private async withOwners<T>(owners: readonly string[], task: () => Promise<T>, index = 0): Promise<T> {
    if (index >= owners.length) return task();
    return this.withOwner(owners[index], () => this.withOwners(owners, task, index + 1));
  }

  markRestorationComplete(): void {
    this.restorationState = 'complete';
  }

  markRestorationFailed(): void {
    this.restorationState = 'failed';
  }

  markRestorationSkipped(): void {
    this.restorationState = 'skipped';
  }

  assertDeletionReady(): void {
    if (this.restorationState === 'complete' || this.restorationState === 'skipped') return;
    throw new Error(`Tab layout restoration is ${this.restorationState}; destructive deletion is unavailable`);
  }

  /** Repair/migrate every owner visible after startup restoration. */
  async reconcileAfterRestoration(): Promise<void> {
    if (this.restorationState !== 'complete') return;
    const { persisted, live } = this.sessionRecords();
    const webviews = await this.deps.readWebviews();
    const owners = new Set<string>();
    for (const record of [...persisted, ...live, ...webviews]) owners.add(ownerOf(record));
    for (const owner of owners) await this.get(owner);
  }

  private sessionRecords(): { persisted: TabLayoutSessionRecord[]; live: TabLayoutSessionRecord[] } {
    const persisted = Object.entries(this.deps.store.getSessions()).map(([id, record]) => ({
      id,
      owner: record.owner,
      createdAt: record.createdAt,
      parentSessionId: record.parentSessionId,
    }));
    const live = [...this.deps.sessions.values()].map((record) => ({
      id: record.id,
      owner: record.owner,
      createdAt: record.createdAt,
      parentSessionId: record.parentSessionId,
    }));
    return { persisted, live };
  }

  private async facts(owner: string): Promise<{
    persisted: TabLayoutSessionRecord[];
    live: TabLayoutSessionRecord[];
    webviews: readonly TabLayoutWebviewRecord[];
    metadata: TabRefMetadata[];
  }> {
    const { persisted, live } = this.sessionRecords();
    const webviews = await this.deps.readWebviews();
    const sessions = new Map<string, TabLayoutSessionRecord>();
    for (const record of persisted) sessions.set(record.id, record);
    for (const record of live) sessions.set(record.id, record);
    const ownedSessions = [...sessions.values()]
      .filter((record) => ownerOf(record) === owner)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sessionOrder = new Map(ownedSessions.map((record, index) => [record.id, index]));
    const metadata: TabRefMetadata[] = [...sessions.values()].map((record) => ({
      kind: 'session',
      id: record.id,
      ownerValid: ownerOf(record) === owner,
      visible: true,
      order: sessionOrder.get(record.id) ?? record.createdAt,
      parentSessionId: record.parentSessionId,
    }));
    const offset = ownedSessions.length;
    webviews.forEach((record, index) =>
      metadata.push({
        kind: 'webview',
        id: record.id,
        ownerValid: ownerOf(record) === owner,
        visible: true,
        order: offset + index,
      })
    );
    return { persisted, live, webviews, metadata };
  }

  private prepareCommit(base: TabLayout, next: TabLayout): TabLayout {
    return validateTabLayout({
      ...next,
      version: base.version + 1,
      updatedAt: (this.deps.now ?? (() => new Date().toISOString()))(),
    });
  }

  private publish(
    layouts: Readonly<Record<string, TabLayout>>,
    publications: readonly OwnerProjectionPublication[],
    preferred?: readonly string[]
  ): SessionOrderProjectionChange {
    const projections = publications.map((item) => {
      const excluded = item.excludedSessionIds ?? new Set<string>();
      const previous = item.previous ? flattenOwnerSessionOrder(item.previous) : [];
      const next = flattenOwnerSessionOrder(item.next).filter((id) => !excluded.has(id));
      const facts = item.metadata
        .filter((fact) => fact.kind === 'session' && fact.ownerValid && fact.visible && !excluded.has(fact.id))
        .map((fact) => fact.id);
      const claimedIds = normalizeSessionOrder([...previous, ...flattenOwnerSessionOrder(item.next), ...facts]);
      const currentIds = normalizeSessionOrder([...next, ...facts]);
      return {
        owner: item.owner,
        previousOrder: previous,
        claimedIds,
        currentIds,
        order: next,
      };
    });
    let beforeOrder: string[] = [];
    const accepted = this.deps.store.commitTabLayoutProjection(layouts, (latest) => {
      beforeOrder = normalizeSessionOrder(latest);
      const removed = new Set(
        projections.flatMap((projection) => projection.claimedIds.filter((id) => !projection.currentIds.includes(id)))
      );
      const base = beforeOrder.filter((id) => !removed.has(id));
      return recomposeGlobalSessionOrder(
        base,
        projections.map((projection) => ({
          owner: projection.owner,
          ownedIds: projection.currentIds,
          order: projection.order,
        })),
        preferred
      );
    });
    const changedEntries: Array<[string, string[]]> = [];
    for (const projection of projections) {
      if (!sameOrder(projection.previousOrder, projection.order)) {
        changedEntries.push([projection.owner, [...projection.order]]);
      }
    }
    const change: SessionOrderProjectionChange = {
      changedOwnerOrders: Object.fromEntries(changedEntries),
      globalOrder: [...accepted.sessionOrder],
      globalChanged: !sameOrder(beforeOrder, accepted.sessionOrder),
    };
    for (const [owner, layout] of Object.entries(accepted.layouts)) {
      this.deps.broadcast(SseEvent.TabLayoutChanged, { owner, version: layout.version });
    }
    if (changedEntries.length > 0 || change.globalChanged) this.deps.broadcastSessionOrder(change);
    return change;
  }

  private commit(
    owner: string,
    base: TabLayout,
    next: TabLayout,
    metadata: readonly TabRefMetadata[],
    previous: TabLayout | null = base.version < 0 ? null : base
  ): TabLayout {
    const stored = this.prepareCommit(base, next);
    this.publish({ [owner]: stored }, [{ owner, previous, next: stored, metadata }]);
    return stored;
  }

  private async prepareUnlocked(owner: string): Promise<PreparedOwnerLayout> {
    const facts = await this.facts(owner);
    const current = this.deps.store.getTabLayout(owner);
    const authoritative = normalizeOrMigrateOwnerTabLayout({
      owner,
      layouts: current ? { [owner]: current } : undefined,
      sessionOrder: this.deps.store.getSessionOrder(),
      persistedSessions: facts.persisted,
      liveSessions: facts.live,
      webviews: facts.webviews,
      updatedAt: (this.deps.now ?? (() => new Date().toISOString()))(),
    }).layout;
    return {
      current,
      authoritative,
      metadata: facts.metadata,
      needsReconciliationCommit: !current || !sameLayout(current, authoritative),
    };
  }

  private async getUnlocked(owner: string): Promise<TabLayout> {
    const prepared = await this.prepareUnlocked(owner);
    if (!prepared.needsReconciliationCommit) return prepared.authoritative;
    const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
    return this.commit(owner, base, prepared.authoritative, prepared.metadata);
  }

  async get(owner: string): Promise<TabLayout> {
    return this.withOwner(owner, () => this.getUnlocked(owner));
  }

  async put(owner: string, desired: unknown, baseVersion: number): Promise<TabLayoutPutResult> {
    return this.withOwner(owner, async () => {
      const prepared = await this.prepareUnlocked(owner);
      if (baseVersion !== prepared.authoritative.version) return { status: 'conflict', layout: prepared.authoritative };
      const validated = validateTabLayout(desired);
      const owned = new Set(prepared.metadata.filter((item) => item.ownerValid && item.visible).map(refKey));
      const refs = [...validated.groups.flatMap((group) => group.refs), ...validated.ungrouped];
      const invalid = refs.find((ref) => !owned.has(refKey(ref)));
      if (invalid)
        throw new TabLayoutValidationError(`ref is not owned by layout owner: ${invalid.kind}:${invalid.id}`);
      const normalized = normalizeTabLayout(
        { ...validated, version: prepared.authoritative.version },
        prepared.metadata
      );
      return {
        status: 'updated',
        layout: this.commit(owner, prepared.authoritative, normalized, prepared.metadata, prepared.current),
      };
    });
  }

  async putLegacyOrder(actor: LegacyOrderActor, requested: readonly string[]): Promise<LegacyOrderPutResult> {
    return actor.isAdmin ? this.putAdminLegacyOrder(requested) : this.putOwnerLegacyOrder(actor.owner, requested);
  }

  private async putOwnerLegacyOrder(owner: string, requested: readonly string[]): Promise<LegacyOrderPutResult> {
    return this.withOwner(owner, async () => {
      const prepared = await this.prepareUnlocked(owner);
      const normalized = normalizeSessionOrder(requested);
      const visible = new Set(
        prepared.metadata
          .filter((item) => item.kind === 'session' && item.ownerValid && item.visible)
          .map((item) => item.id)
      );
      const invalid = normalized.find((id) => !visible.has(id));
      if (invalid) throw new TabLayoutValidationError(`session is not owned by layout owner: ${invalid}`);
      const currentKnown = flattenOwnerSessionOrder(prepared.authoritative).filter((id) => visible.has(id));
      const effective = mergeSessionOrder(normalized, currentKnown);
      const ranked = applyLegacySessionRank(prepared.authoritative, effective, prepared.metadata);
      const needsLayout = prepared.needsReconciliationCommit || !sameLayout(prepared.authoritative, ranked);
      const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
      const next = needsLayout ? this.prepareCommit(base, ranked) : prepared.authoritative;
      const change = this.publish(needsLayout ? { [owner]: next } : {}, [
        { owner, previous: prepared.current, next, metadata: prepared.metadata },
      ]);
      return { order: flattenOwnerSessionOrder(next), ...change };
    });
  }

  private async putAdminLegacyOrder(requested: readonly string[]): Promise<LegacyOrderPutResult> {
    const discoverOwners = (): string[] => {
      const owners = new Set(Object.keys(this.deps.store.getTabLayouts()));
      const { persisted, live } = this.sessionRecords();
      for (const record of [...persisted, ...live]) owners.add(ownerOf(record));
      return [...owners].sort();
    };
    for (;;) {
      const owners = discoverOwners();
      const result = await this.withOwners(owners, async (): Promise<LegacyOrderPutResult | null> => {
        if (!sameOrder(owners, discoverOwners())) return null;
        const normalized = normalizeSessionOrder(requested);
        const knownOwners = new Map<string, string>();
        const { persisted, live } = this.sessionRecords();
        for (const record of persisted) knownOwners.set(record.id, ownerOf(record));
        for (const record of live) knownOwners.set(record.id, ownerOf(record));
        const invalid = normalized.find((id) => !knownOwners.has(id));
        if (invalid) throw new TabLayoutValidationError(`session is not visible machine-wide: ${invalid}`);

        const publications: OwnerProjectionPublication[] = [];
        const updates: Record<string, TabLayout> = Object.create(null) as Record<string, TabLayout>;
        for (const owner of owners) {
          const prepared = await this.prepareUnlocked(owner);
          const visible = new Set(
            prepared.metadata
              .filter((item) => item.kind === 'session' && item.ownerValid && item.visible)
              .map((item) => item.id)
          );
          const requestedOwner = normalized.filter((id) => visible.has(id));
          const currentKnown = flattenOwnerSessionOrder(prepared.authoritative).filter((id) => visible.has(id));
          const effective = mergeSessionOrder(requestedOwner, currentKnown);
          const ranked = applyLegacySessionRank(prepared.authoritative, effective, prepared.metadata);
          const needsLayout = prepared.needsReconciliationCommit || !sameLayout(prepared.authoritative, ranked);
          const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
          const next = needsLayout ? this.prepareCommit(base, ranked) : prepared.authoritative;
          if (needsLayout) updates[owner] = next;
          publications.push({ owner, previous: prepared.current, next, metadata: prepared.metadata });
        }
        const change = this.publish(updates, publications, normalized);
        return { order: [...change.globalOrder], ...change };
      });
      if (result) return result;
    }
  }

  /** Reconcile one completed session creation into one versioned mutation. */
  async sessionCreated(owner: string): Promise<TabLayout> {
    return this.get(owner);
  }

  /** Reconcile one completed saved-webview creation into one versioned mutation. */
  async webviewCreated(owner: string): Promise<TabLayout> {
    return this.get(owner);
  }

  async sessionsRemoved(removed: readonly RemovedTabLayoutSession[]): Promise<void> {
    if (this.restorationState !== 'complete' || removed.length === 0) return;
    const byOwner = new Map<string, string[]>();
    for (const item of removed) {
      const owner = ownerOf(item);
      const ids = byOwner.get(owner) ?? [];
      ids.push(item.id);
      byOwner.set(owner, ids);
    }
    const owners = [...byOwner.keys()].sort();
    await this.withOwners(owners, async () => {
      const publications: OwnerProjectionPublication[] = [];
      const updates: Record<string, TabLayout> = Object.create(null) as Record<string, TabLayout>;
      for (const owner of owners) {
        const ids = byOwner.get(owner) ?? [];
        const current = this.deps.store.getTabLayout(owner);
        if (!current) continue;
        const { metadata } = await this.facts(owner);
        // Normalize and prune together so stale cleanup, orphan materialization,
        // and missing-ref repair remain one versioned server mutation.
        const next = normalizeTabLayout(
          materializeOrphans(normalizeTabLayout(current, metadata), ids, metadata),
          metadata
        );
        if (sameLayout(current, next)) continue;
        const stored = this.prepareCommit(current, next);
        updates[owner] = stored;
        publications.push({
          owner,
          previous: current,
          next: stored,
          metadata,
          excludedSessionIds: new Set(ids),
        });
      }
      if (publications.length > 0) this.publish(updates, publications);
    });
  }

  /**
   * Hold the owner mutation lock across an irreversible session deletion.
   * All failure-prone normalization happens before `action`; the prepared layout
   * commits only after the resource cleanup finishes.
   */
  async runSessionDeletion<T>(removed: readonly RemovedTabLayoutSession[], action: () => Promise<T>): Promise<T> {
    this.assertDeletionReady();
    if (this.restorationState === 'skipped' || removed.length === 0) return action();
    const owners = new Set(removed.map(ownerOf));
    if (owners.size !== 1) throw new Error('A session deletion transaction must contain exactly one owner');
    const owner = owners.values().next().value as string;
    const ids = removed.map((item) => item.id);
    return this.withOwner(owner, async () => {
      const current = this.deps.store.getTabLayout(owner);
      let next: TabLayout | null = null;
      let stored: TabLayout | null = null;
      let metadata: TabRefMetadata[] = [];
      if (current) {
        ({ metadata } = await this.facts(owner));
        // Prepare while the soon-to-be-deleted sessions are still known, so
        // direct children can be materialized before their parent ref is removed.
        next = materializeOrphans(normalizeTabLayout(current, metadata), ids, metadata);
        if (!sameLayout(current, next)) stored = this.prepareCommit(current, next);
      }
      const result = await action();
      if (current && stored) {
        this.publish({ [owner]: stored }, [
          { owner, previous: current, next: stored, metadata, excludedSessionIds: new Set(ids) },
        ]);
      }
      return result;
    });
  }

  /**
   * Prepare every affected owner layout before bulk stale-state deletion.
   * The StateStore action remains synchronous in production, so the candidate
   * snapshot cannot change between successful preparation and resource removal.
   */
  async runStaleSessionCleanup<T>(
    activeSessionIds: ReadonlySet<string>,
    action: (ids: ReadonlySet<string>) => T | Promise<T>
  ): Promise<T> {
    this.assertDeletionReady();
    const candidates = Object.entries(this.deps.store.getSessions())
      .filter(([id, record]) => !activeSessionIds.has(id) && record.pinned !== true)
      .map(([id, record]) => ({ id, owner: record.owner }));
    if (this.restorationState === 'skipped') return action(new Set(candidates.map((item) => item.id)));
    if (candidates.length === 0) return action(new Set());

    const byOwner = new Map<string, string[]>();
    for (const item of candidates) {
      const owner = ownerOf(item);
      const ids = byOwner.get(owner) ?? [];
      ids.push(item.id);
      byOwner.set(owner, ids);
    }
    const owners = [...byOwner.keys()].sort();
    return this.withOwners(owners, async () => {
      const webviews = await this.deps.readWebviews();
      const persistedState = this.deps.store.getSessions();
      const persisted = Object.entries(persistedState).map(([id, record]) => ({
        id,
        owner: record.owner,
        createdAt: record.createdAt,
        parentSessionId: record.parentSessionId,
      }));
      const liveIds = new Set(this.deps.sessions.keys());
      const confirmed = candidates.filter((candidate) => {
        const record = persistedState[candidate.id];
        return (
          record !== undefined &&
          ownerOf(record) === ownerOf(candidate) &&
          record.pinned !== true &&
          !activeSessionIds.has(candidate.id) &&
          !liveIds.has(candidate.id)
        );
      });
      const confirmedByOwner = new Map<string, string[]>();
      for (const item of confirmed) {
        const owner = ownerOf(item);
        const ids = confirmedByOwner.get(owner) ?? [];
        ids.push(item.id);
        confirmedByOwner.set(owner, ids);
      }

      const prepared: Array<{
        owner: string;
        current: TabLayout;
        stored: TabLayout;
        metadata: TabRefMetadata[];
        excludedSessionIds: ReadonlySet<string>;
      }> = [];
      for (const owner of owners) {
        const ids = confirmedByOwner.get(owner) ?? [];
        if (ids.length === 0) continue;
        const current = this.deps.store.getTabLayout(owner);
        if (!current) continue;
        const sessions = new Map<string, TabLayoutSessionRecord>();
        for (const record of persisted) sessions.set(record.id, record);
        for (const record of this.deps.sessions.values()) sessions.set(record.id, record);
        const ownedSessions = [...sessions.values()]
          .filter((record) => ownerOf(record) === owner)
          .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const sessionOrder = new Map(ownedSessions.map((record, index) => [record.id, index]));
        const metadata: TabRefMetadata[] = [...sessions.values()].map((record) => ({
          kind: 'session',
          id: record.id,
          ownerValid: ownerOf(record) === owner,
          visible: true,
          order: sessionOrder.get(record.id) ?? record.createdAt,
          parentSessionId: record.parentSessionId,
        }));
        const offset = ownedSessions.length;
        webviews.forEach((record, index) =>
          metadata.push({
            kind: 'webview',
            id: record.id,
            ownerValid: ownerOf(record) === owner,
            visible: true,
            order: offset + index,
          })
        );
        const next = materializeOrphans(normalizeTabLayout(current, metadata), ids, metadata);
        if (!sameLayout(current, next)) {
          prepared.push({
            owner,
            current,
            stored: this.prepareCommit(current, next),
            metadata,
            excludedSessionIds: new Set(ids),
          });
        }
      }

      const result = await action(new Set(confirmed.map((item) => item.id)));
      if (prepared.length > 0) {
        this.publish(
          Object.fromEntries(prepared.map((item) => [item.owner, item.stored])),
          prepared.map((item) => ({
            owner: item.owner,
            previous: item.current,
            next: item.stored,
            metadata: item.metadata,
            excludedSessionIds: item.excludedSessionIds,
          }))
        );
      }
      return result;
    });
  }

  async webviewDeleted(owner: string, id: string): Promise<void> {
    this.assertDeletionReady();
    if (this.restorationState === 'skipped') return;
    await this.withOwner(owner, async () => {
      const current = this.deps.store.getTabLayout(owner);
      if (!current) return;
      const strip = (refs: readonly TabRef[]): TabRef[] =>
        refs.filter((ref) => ref.kind !== 'webview' || ref.id !== id).map((ref) => ({ ...ref }));
      const stripped: TabLayout = {
        ...current,
        groups: current.groups.map((group) => ({ ...group, refs: strip(group.refs) })),
        ungrouped: strip(current.ungrouped),
      };
      const { metadata } = await this.facts(owner);
      const next = normalizeTabLayout(stripped, metadata);
      if (!sameLayout(current, next)) this.commit(owner, current, next, metadata);
    });
  }
}
