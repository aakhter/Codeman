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
  createGroup,
  deleteGroup,
  describeTabPlacements,
  followParent,
  flattenOwnerSessionOrder,
  materializeOrphans,
  moveRef,
  normalizeTabLayout,
  renameGroup,
  reorderGroup,
  setManualPlacement,
  moveFocusRef,
  setTabFocus,
  MAX_TAB_GROUP_NAME_LENGTH,
  MAX_TAB_GROUPS,
  MAX_TAB_REFS,
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
    | 'getTabLayout'
    | 'getTabLayouts'
    | 'getSessions'
    | 'getSessionOrder'
    | 'commitTabLayoutProjection'
    | 'getCaseDefaultGroup'
    | 'setCaseDefaultGroup'
  >;
  sessions: ReadonlyMap<string, TabLayoutSessionLike>;
  readWebviews(): Promise<readonly TabLayoutWebviewRecord[]>;
  broadcast(event: string, data: unknown): void;
  broadcastSessionOrder(change: SessionOrderProjectionChange): void;
  now?: () => string;
}

interface PreparedOwnerLayout {
  current: TabLayout | null;
  authoritative: TabLayout;
  metadata: TabRefMetadata[];
  needsReconciliationCommit: boolean;
}

export type TabLayoutPutResult =
  | { status: 'updated'; layout: TabLayout }
  | { status: 'conflict'; layout: TabLayout; appliedOperationCount?: number };

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

interface OwnerProjectionPublication {
  owner: string;
  previous: TabLayout | null;
  next: TabLayout;
  metadata: readonly TabRefMetadata[];
  excludedSessionIds?: ReadonlySet<string>;
  layoutBroadcastData?: unknown;
}

interface PreparedOrderProjection {
  owner: string;
  previousOrder: string[];
  authoritativeBeforeIds: string[];
  excludedIds: string[];
  currentIds: string[];
  order: string[];
}

export type TabLayoutSemanticOperation =
  | { type: 'createGroup'; id: string; name: string; index?: number }
  | { type: 'renameGroup'; groupId: string; name: string }
  | { type: 'deleteGroup'; groupId: string }
  | { type: 'reorderGroup'; groupId: string; index: number }
  | { type: 'moveRef'; ref: TabRef; groupId: string | null; index: number }
  | { type: 'setManualPlacement'; ref: TabRef; manual: true }
  | { type: 'setFocus'; ref: TabRef; focused: boolean }
  | { type: 'moveFocus'; ref: TabRef; index: number }
  | { type: 'followParent'; ref: TabRef };

export type TabLayoutSnapshot = {
  layout: TabLayout;
  placements: ReturnType<typeof describeTabPlacements>;
  /** Internal creation hint used by routes to return the first authoritative render. */
  placementSource?: 'case-default';
};

export interface SessionPlacementHints {
  tabGroupId?: string;
  caseName?: string;
}

export type RegisterTabLayoutSession = () => void | (() => void);

export interface RemovedTabLayoutSession {
  id: string;
  owner?: string;
}

const ownerOf = (record: { owner?: string }): string => record.owner ?? SINGLE_USER_LAYOUT_OWNER;
const refKey = (ref: Pick<TabRef, 'kind' | 'id'>): string => `${ref.kind}\u0000${ref.id}`;
const sameLayout = (a: TabLayout, b: TabLayout): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

const preserveLegacyFocusFlags = (desired: TabLayout, current: TabLayout): TabLayout => {
  const focused = new Set(
    [...current.groups.flatMap((group) => group.refs), ...current.ungrouped]
      .filter((ref) => ref.focus === true)
      .map(refKey)
  );
  const ref = (value: TabRef): TabRef => {
    const { focus: _ignored, ...rest } = value;
    return focused.has(refKey(value)) ? { ...rest, focus: true } : rest;
  };
  const { focusOrder: _discarded, ...rest } = desired;
  return {
    ...rest,
    groups: desired.groups.map((group) => ({ ...group, refs: group.refs.map(ref) })),
    ungrouped: desired.ungrouped.map(ref),
    ...(current.focusOrder === undefined ? {} : { focusOrder: current.focusOrder.map((value) => ({ ...value })) }),
  };
};
const sameContent = (a: TabLayout, b: TabLayout): boolean =>
  JSON.stringify({ groups: a.groups, ungrouped: a.ungrouped, focusOrder: a.focusOrder ?? null }) ===
  JSON.stringify({ groups: b.groups, ungrouped: b.ungrouped, focusOrder: b.focusOrder ?? null });
const validOperationRef = (value: unknown): value is TabRef =>
  value !== null &&
  typeof value === 'object' &&
  ((value as TabRef).kind === 'session' || (value as TabRef).kind === 'webview') &&
  typeof (value as TabRef).id === 'string' &&
  (value as TabRef).id.length > 0;
const validOperationId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const validOperationIndex = (value: unknown, maximumExclusive: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < maximumExclusive;
const validOperationName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_TAB_GROUP_NAME_LENGTH;

function validateOperationRequest(value: unknown): asserts value is TabLayoutSemanticOperation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TabLayoutValidationError('invalid tab layout operation');
  }
  const operation = value as Record<string, unknown>;
  switch (operation.type) {
    case 'createGroup':
      if (
        !validOperationId(operation.id) ||
        !validOperationName(operation.name) ||
        (operation.index !== undefined && !validOperationIndex(operation.index, MAX_TAB_GROUPS))
      ) {
        throw new TabLayoutValidationError('createGroup operation has invalid fields');
      }
      return;
    case 'renameGroup':
      if (!validOperationId(operation.groupId) || !validOperationName(operation.name)) {
        throw new TabLayoutValidationError('renameGroup operation has invalid fields');
      }
      return;
    case 'deleteGroup':
      if (!validOperationId(operation.groupId)) {
        throw new TabLayoutValidationError('deleteGroup operation has an invalid groupId');
      }
      return;
    case 'reorderGroup':
      if (!validOperationId(operation.groupId) || !validOperationIndex(operation.index, MAX_TAB_GROUPS)) {
        throw new TabLayoutValidationError('reorderGroup operation has invalid fields');
      }
      return;
    case 'moveRef':
      if (
        !validOperationRef(operation.ref) ||
        (operation.groupId !== null && !validOperationId(operation.groupId)) ||
        !validOperationIndex(operation.index, MAX_TAB_REFS)
      ) {
        throw new TabLayoutValidationError('moveRef operation has invalid fields');
      }
      return;
    case 'setManualPlacement':
      if (!validOperationRef(operation.ref) || operation.manual !== true) {
        throw new TabLayoutValidationError('setManualPlacement operation has invalid fields');
      }
      return;
    case 'setFocus':
      if (!validOperationRef(operation.ref) || typeof operation.focused !== 'boolean') {
        throw new TabLayoutValidationError('setFocus operation has invalid fields');
      }
      return;
    case 'moveFocus':
      if (!validOperationRef(operation.ref) || !validOperationIndex(operation.index, MAX_TAB_REFS)) {
        throw new TabLayoutValidationError('moveFocus operation has invalid fields');
      }
      return;
    case 'followParent':
      if (!validOperationRef(operation.ref) || operation.ref.kind !== 'session') {
        throw new TabLayoutValidationError('followParent operation has an invalid ref; session required');
      }
      return;
    default:
      throw new TabLayoutValidationError('unknown tab layout operation');
  }
}

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

  private prepareOrderProjection(item: OwnerProjectionPublication): PreparedOrderProjection {
    const excluded = item.excludedSessionIds ?? new Set<string>();
    const authoritativeBeforeIds = item.metadata
      .filter((fact) => fact.kind === 'session' && fact.ownerValid && fact.visible)
      .map((fact) => fact.id);
    const facts = authoritativeBeforeIds.filter((id) => !excluded.has(id));
    const visible = new Set(facts);
    const rawPrevious = item.previous ? flattenOwnerSessionOrder(item.previous) : [];
    const rawNext = flattenOwnerSessionOrder(item.next);
    const previousOrder = rawPrevious.filter((id) => visible.has(id) || excluded.has(id));
    const order = rawNext.filter((id) => visible.has(id) && !excluded.has(id));
    const excludedIds = normalizeSessionOrder([...excluded]);
    return {
      owner: item.owner,
      previousOrder,
      authoritativeBeforeIds: normalizeSessionOrder([...authoritativeBeforeIds, ...excluded]),
      excludedIds,
      currentIds: normalizeSessionOrder([...order, ...facts]),
      order,
    };
  }

  private projectOrder(
    latest: readonly string[],
    projections: readonly PreparedOrderProjection[],
    preferred?: readonly string[]
  ): string[] {
    const before = normalizeSessionOrder(latest);
    const removed = new Set(
      projections.flatMap((projection) => projection.excludedIds.filter((id) => !projection.currentIds.includes(id)))
    );
    return recomposeGlobalSessionOrder(
      before.filter((id) => !removed.has(id)),
      projections.map((projection) => ({
        owner: projection.owner,
        ownedIds: projection.currentIds,
        order: projection.order,
      })),
      preferred
    );
  }

  private publish(
    layouts: Readonly<Record<string, TabLayout>>,
    publications: readonly OwnerProjectionPublication[],
    preferred?: readonly string[]
  ): SessionOrderProjectionChange {
    const projections = publications.map((item) => this.prepareOrderProjection(item));
    let beforeOrder: string[] = [];
    const accepted = this.deps.store.commitTabLayoutProjection(layouts, (latest) => {
      beforeOrder = normalizeSessionOrder(latest);
      return this.projectOrder(beforeOrder, projections, preferred);
    });
    const changedEntries: Array<[string, string[]]> = [];
    for (const projection of projections) {
      const beforeIds = new Set(projection.authoritativeBeforeIds);
      const currentIds = new Set(projection.currentIds);
      const persistedBefore = beforeOrder.filter((id) => beforeIds.has(id));
      const persistedAfter = accepted.sessionOrder.filter((id) => currentIds.has(id));
      const layoutOrderChanged = !sameOrder(projection.previousOrder, projection.order);
      const persistedOwnerSliceChanged = !sameOrder(persistedBefore, persistedAfter);
      if (layoutOrderChanged || persistedOwnerSliceChanged) {
        changedEntries.push([projection.owner, persistedAfter]);
      }
    }
    const change: SessionOrderProjectionChange = {
      changedOwnerOrders: Object.fromEntries(changedEntries),
      globalOrder: [...accepted.sessionOrder],
      globalChanged: !sameOrder(beforeOrder, accepted.sessionOrder),
    };
    for (const [owner, layout] of Object.entries(accepted.layouts)) {
      const publication = publications.find((item) => item.owner === owner);
      this.deps.broadcast(
        SseEvent.TabLayoutChanged,
        publication?.layoutBroadcastData ?? { owner, version: layout.version }
      );
    }
    if (changedEntries.length > 0 || change.globalChanged) this.deps.broadcastSessionOrder(change);
    return change;
  }

  private commit(
    owner: string,
    base: TabLayout,
    next: TabLayout,
    metadata: readonly TabRefMetadata[],
    previous: TabLayout | null = base.version < 0 ? null : base,
    layoutBroadcastData?: unknown
  ): TabLayout {
    const stored = this.prepareCommit(base, next);
    this.publish({ [owner]: stored }, [
      { owner, previous, next: stored, metadata, ...(layoutBroadcastData ? { layoutBroadcastData } : {}) },
    ]);
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
    const publication = {
      owner,
      previous: prepared.current,
      next: prepared.authoritative,
      metadata: prepared.metadata,
    };
    if (!prepared.needsReconciliationCommit) {
      const latest = this.deps.store.getSessionOrder();
      const projected = this.projectOrder(latest, [this.prepareOrderProjection(publication)]);
      if (!sameOrder(normalizeSessionOrder(latest), projected)) this.publish({}, [publication]);
      return prepared.authoritative;
    }
    const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
    return this.commit(owner, base, prepared.authoritative, prepared.metadata, prepared.current);
  }

  async get(owner: string): Promise<TabLayout> {
    return this.withOwner(owner, () => this.getUnlocked(owner));
  }

  async getSnapshot(owner: string): Promise<TabLayoutSnapshot> {
    return this.withOwner(owner, async () => {
      const layout = await this.getUnlocked(owner);
      const { metadata } = await this.facts(owner);
      return { layout, placements: describeTabPlacements(layout, metadata) };
    });
  }

  async putOperations(
    owner: string,
    operations: readonly TabLayoutSemanticOperation[],
    baseVersion: number,
    recoveryBaseLayout?: unknown
  ): Promise<TabLayoutPutResult & { placements: ReturnType<typeof describeTabPlacements> }> {
    return this.withOwner(owner, async () => {
      const prepared = await this.prepareUnlocked(owner);
      const current = prepared.authoritative;
      const metadata = prepared.metadata;
      const applyOperation = (input: TabLayout, operation: TabLayoutSemanticOperation): TabLayout => {
        if (!operation || typeof operation !== 'object')
          throw new TabLayoutValidationError('invalid tab layout operation');
        if (
          (operation.type === 'moveRef' ||
            operation.type === 'setManualPlacement' ||
            operation.type === 'setFocus' ||
            operation.type === 'moveFocus' ||
            operation.type === 'followParent') &&
          !validOperationRef(operation.ref)
        ) {
          throw new TabLayoutValidationError('tab layout operation has an invalid ref');
        }
        switch (operation.type) {
          case 'createGroup':
            return createGroup(input, { id: operation.id, name: operation.name, index: operation.index });
          case 'renameGroup':
            return renameGroup(input, operation.groupId, operation.name);
          case 'deleteGroup':
            return deleteGroup(input, operation.groupId);
          case 'reorderGroup':
            return reorderGroup(input, operation.groupId, operation.index);
          case 'moveRef':
            return moveRef(input, operation.ref, { groupId: operation.groupId, index: operation.index }, metadata);
          case 'setManualPlacement':
            return setManualPlacement(input, operation.ref, operation.manual);
          case 'setFocus':
            return setTabFocus(input, operation.ref, operation.focused);
          case 'moveFocus':
            return moveFocusRef(input, operation.ref, operation.index);
          case 'followParent': {
            const followState = describeTabPlacements(input, metadata).find(
              (placement) => placement.kind === operation.ref.kind && placement.id === operation.ref.id
            )?.state;
            if (followState !== 'manual' && followState !== 'inherited') {
              throw new TabLayoutValidationError('session is not eligible to follow an owner-valid parent');
            }
            return followParent(input, operation.ref, metadata);
          }
          default:
            throw new TabLayoutValidationError('unknown tab layout operation');
        }
      };
      if (baseVersion !== current.version) {
        let appliedOperationCount: number | undefined;
        try {
          if (!Array.isArray(operations) || operations.length === 0 || operations.length > 64) {
            throw new TabLayoutValidationError('operations must contain 1–64 semantic edits');
          }
          for (const operation of operations) validateOperationRequest(operation);
          if (recoveryBaseLayout !== undefined) {
            let candidate = validateTabLayout(recoveryBaseLayout);
            if (candidate.version !== baseVersion) {
              throw new TabLayoutValidationError('recovery base version must match baseVersion');
            }
            candidate = normalizeTabLayout(candidate, metadata);
            if (sameContent(candidate, current)) appliedOperationCount = 0;
            for (let index = 0; index < operations.length; index++) {
              candidate = normalizeTabLayout(applyOperation(candidate, operations[index]), metadata);
              if (sameContent(candidate, current)) appliedOperationCount = index + 1;
            }
          }
        } catch (error) {
          // Every version mismatch is a conflict. Malformed advisory recovery
          // data and semantically invalidated historical intent only make the
          // applied prefix unknown; neither may replace the authoritative 409.
          if (!(error instanceof TabLayoutValidationError)) throw error;
          appliedOperationCount = undefined;
        }
        return {
          status: 'conflict',
          layout: current,
          placements: describeTabPlacements(current, metadata),
          ...(appliedOperationCount === undefined ? {} : { appliedOperationCount }),
        };
      }
      if (!Array.isArray(operations) || operations.length === 0 || operations.length > 64) {
        throw new TabLayoutValidationError('operations must contain 1–64 semantic edits');
      }
      for (const operation of operations) validateOperationRequest(operation);
      if (recoveryBaseLayout !== undefined) {
        const recoveryBase = validateTabLayout(recoveryBaseLayout);
        if (recoveryBase.version !== baseVersion) {
          throw new TabLayoutValidationError('recovery base version must match baseVersion');
        }
      }
      let next = current;
      for (const operation of operations) next = applyOperation(next, operation);
      next = normalizeTabLayout(next, metadata);
      if (sameLayout(current, next)) {
        if (!prepared.needsReconciliationCommit) {
          return { status: 'updated', layout: current, placements: describeTabPlacements(current, metadata) };
        }
      }
      const stored = this.commit(owner, current, next, metadata, prepared.current);
      return { status: 'updated', layout: stored, placements: describeTabPlacements(stored, metadata) };
    });
  }

  async put(owner: string, desired: unknown, baseVersion: number): Promise<TabLayoutPutResult> {
    return this.withOwner(owner, async () => {
      const prepared = await this.prepareUnlocked(owner);
      const current = prepared.authoritative;
      if (baseVersion !== current.version) return { status: 'conflict', layout: current };
      const validated = preserveLegacyFocusFlags(validateTabLayout(desired), current);
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
      // Unknown or foreign ids are DROPPED, never a 400: the browser debounces
      // its reorder push (and swallows errors), so a session deleted inside
      // that window would otherwise cost the user the whole reorder — and the
      // endpoint sits on the stable /api/v1 surface, where the pre-layout
      // server merged leniently. Same philosophy as resolveParentSessionId.
      const requestedVisible = normalized.filter((id) => visible.has(id));
      const currentKnown = flattenOwnerSessionOrder(prepared.authoritative).filter((id) => visible.has(id));
      const effective = mergeSessionOrder(requestedVisible, currentKnown);
      const ranked = applyLegacySessionRank(prepared.authoritative, effective, prepared.metadata);
      const needsLayout = prepared.needsReconciliationCommit || !sameLayout(prepared.authoritative, ranked);
      const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
      const next = needsLayout ? this.prepareCommit(base, ranked) : prepared.authoritative;
      const change = this.publish(needsLayout ? { [owner]: next } : {}, [
        { owner, previous: prepared.current, next, metadata: prepared.metadata },
      ]);
      return { order: flattenOwnerSessionOrder(next).filter((id) => visible.has(id)), ...change };
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
        // Unknown ids are DROPPED, never a 400 — see putOwnerLegacyOrder. In
        // single-user mode every request is the synthetic admin, so this path
        // IS the one the browser's debounced (error-swallowing) push hits.
        const known = normalized.filter((id) => knownOwners.has(id));

        const publications: OwnerProjectionPublication[] = [];
        const updates: Record<string, TabLayout> = Object.create(null) as Record<string, TabLayout>;
        for (const owner of owners) {
          const prepared = await this.prepareUnlocked(owner);
          const visible = new Set(
            prepared.metadata
              .filter((item) => item.kind === 'session' && item.ownerValid && item.visible)
              .map((item) => item.id)
          );
          const requestedOwner = known.filter((id) => visible.has(id));
          const currentKnown = flattenOwnerSessionOrder(prepared.authoritative).filter((id) => visible.has(id));
          const effective = mergeSessionOrder(requestedOwner, currentKnown);
          const ranked = applyLegacySessionRank(prepared.authoritative, effective, prepared.metadata);
          const needsLayout = prepared.needsReconciliationCommit || !sameLayout(prepared.authoritative, ranked);
          const base = prepared.current ?? { ...prepared.authoritative, version: -1 };
          const next = needsLayout ? this.prepareCommit(base, ranked) : prepared.authoritative;
          if (needsLayout) updates[owner] = next;
          publications.push({ owner, previous: prepared.current, next, metadata: prepared.metadata });
        }
        const change = this.publish(updates, publications, known);
        return { order: [...change.globalOrder], ...change };
      });
      if (result) return result;
    }
  }

  /** Reconcile one completed session creation into one versioned mutation. */
  async sessionCreated(
    owner: string,
    sessionId: string,
    options: SessionPlacementHints = {},
    register?: RegisterTabLayoutSession
  ): Promise<TabLayoutSnapshot> {
    return this.withOwner(owner, async () => {
      let rollback: (() => void) | void = undefined;
      try {
        rollback = register?.();
        const prepared = await this.prepareUnlocked(owner);
        const candidate = prepared.authoritative;
        const metadata = prepared.metadata;
        const base = prepared.current ?? { ...candidate, version: -1 };
        let next = candidate;
        let placementSource: TabLayoutSnapshot['placementSource'];
        const explicitGroup = options.tabGroupId
          ? candidate.groups.find((group) => group.id === options.tabGroupId)
          : undefined;
        const createdMetadata = metadata.find((item) => item.kind === 'session' && item.id === sessionId);
        const candidateSessionIds = new Set(
          [...candidate.groups.flatMap((group) => group.refs), ...candidate.ungrouped]
            .filter((ref) => ref.kind === 'session')
            .map((ref) => ref.id)
        );
        const eligibleParent = createdMetadata?.parentSessionId
          ? metadata.some(
              (item) =>
                item.kind === 'session' &&
                item.id === createdMetadata.parentSessionId &&
                item.ownerValid &&
                item.visible &&
                candidateSessionIds.has(item.id)
            )
          : false;
        let defaultGroup: (typeof candidate.groups)[number] | undefined;
        if (options.caseName) {
          const defaultGroupId = this.deps.store.getCaseDefaultGroup(owner, options.caseName);
          if (typeof defaultGroupId === 'string') {
            defaultGroup = candidate.groups.find((group) => group.id === defaultGroupId);
            if (!defaultGroup) {
              this.deps.store.setCaseDefaultGroup(owner, options.caseName, null);
            }
          }
        }
        let targetGroup = explicitGroup;
        if (!targetGroup && !eligibleParent && defaultGroup) {
          targetGroup = defaultGroup;
          placementSource = 'case-default';
        }

        if (targetGroup) {
          const target = { kind: 'session' as const, id: sessionId };
          const storedRefs = [...candidate.groups.flatMap((group) => group.refs), ...candidate.ungrouped];
          const stored = new Map(storedRefs.map((ref) => [refKey(ref), ref]));
          const children = new Map<string, string[]>();
          for (const item of metadata) {
            if (
              item.kind !== 'session' ||
              !item.ownerValid ||
              !item.visible ||
              !item.parentSessionId ||
              !stored.has(refKey(item)) ||
              stored.get(refKey(item))?.placement === 'manual' ||
              !stored.has(refKey({ kind: 'session', id: item.parentSessionId }))
            ) {
              continue;
            }
            const siblings = children.get(item.parentSessionId) ?? [];
            siblings.push(item.id);
            children.set(item.parentSessionId, siblings);
          }
          const blockKeys = new Set<string>();
          const addDescendants = (ref: TabRef): void => {
            const key = refKey(ref);
            if (blockKeys.has(key)) return;
            blockKeys.add(key);
            if (ref.kind !== 'session') return;
            for (const childId of children.get(ref.id) ?? []) {
              addDescendants({ kind: 'session', id: childId });
            }
          };
          addDescendants(target);
          const removedFromTarget = targetGroup.refs.filter((ref) => blockKeys.has(refKey(ref))).length;
          const destinationIndex = targetGroup.refs.length - removedFromTarget;
          try {
            next = moveRef(candidate, target, { groupId: targetGroup.id, index: destinationIndex }, metadata);
            if (placementSource === 'case-default') {
              const withoutCreatedPlacement = (ref: TabRef): TabRef => {
                if (ref.kind !== 'session' || ref.id !== sessionId || ref.placement === undefined) return ref;
                const { placement: _placement, ...rest } = ref;
                return rest;
              };
              next = {
                ...next,
                groups: next.groups.map((group) => ({ ...group, refs: group.refs.map(withoutCreatedPlacement) })),
                ungrouped: next.ungrouped.map(withoutCreatedPlacement),
              };
            }
          } catch (error) {
            if (!(error instanceof TabLayoutValidationError)) throw error;
            next = candidate;
            placementSource = undefined;
          }
        }

        const layout = sameLayout(base, next) ? base : this.prepareCommit(base, next);
        const placements = describeTabPlacements(layout, metadata);
        const publication: OwnerProjectionPublication = {
          owner,
          previous: prepared.current,
          next: layout,
          metadata,
          layoutBroadcastData: { owner, version: layout.version, layout, placements },
        };
        const layoutChanged = !sameLayout(base, next);
        const latestOrder = this.deps.store.getSessionOrder();
        const projectedOrder = this.projectOrder(latestOrder, [this.prepareOrderProjection(publication)]);
        if (layoutChanged || !sameOrder(normalizeSessionOrder(latestOrder), projectedOrder)) {
          this.publish(layoutChanged ? { [owner]: layout } : {}, [publication]);
        }
        return { layout, placements, ...(placementSource ? { placementSource } : {}) };
      } catch (error) {
        rollback?.();
        throw error;
      }
    });
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
        const prepared = await this.prepareUnlocked(owner);
        const current = prepared.current;
        // Normalize and prune together so stale cleanup, orphan materialization,
        // and missing-ref repair remain one versioned server mutation.
        const next = normalizeTabLayout(
          materializeOrphans(prepared.authoritative, ids, prepared.metadata),
          prepared.metadata
        );
        const stored = current && !sameLayout(current, next) ? this.prepareCommit(current, next) : null;
        if (stored) updates[owner] = stored;
        publications.push({
          owner,
          previous: current,
          next: stored ?? next,
          metadata: prepared.metadata,
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
    // A failed restoration must not lock the user out of explicitly closing a
    // tab for the rest of the process lifetime: degrade to best-effort deletion
    // without layout coordination. Only the AUTOMATED stale sweep stays
    // fail-closed on 'failed' (runStaleSessionCleanup), because that one picks
    // its victims itself from state a failed restore may have left incomplete.
    if (this.restorationState === 'failed') return action();
    this.assertDeletionReady();
    if (this.restorationState === 'skipped' || removed.length === 0) return action();
    const owners = new Set(removed.map(ownerOf));
    if (owners.size !== 1) throw new Error('A session deletion transaction must contain exactly one owner');
    const owner = owners.values().next().value as string;
    const ids = removed.map((item) => item.id);
    return this.withOwner(owner, async () => {
      const prepared = await this.prepareUnlocked(owner);
      const current = prepared.current;
      // Prepare while the soon-to-be-deleted sessions are still known, so
      // direct children can be materialized before their parent ref is removed.
      const next = materializeOrphans(prepared.authoritative, ids, prepared.metadata);
      const stored = current && !sameLayout(current, next) ? this.prepareCommit(current, next) : null;
      const result = await action();
      this.publish(stored ? { [owner]: stored } : {}, [
        {
          owner,
          previous: current,
          next: stored ?? next,
          metadata: prepared.metadata,
          excludedSessionIds: new Set(ids),
        },
      ]);
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
        current: TabLayout | null;
        next: TabLayout;
        stored: TabLayout | null;
        metadata: TabRefMetadata[];
        excludedSessionIds: ReadonlySet<string>;
      }> = [];
      for (const owner of owners) {
        const ids = confirmedByOwner.get(owner) ?? [];
        if (ids.length === 0) continue;
        const current = this.deps.store.getTabLayout(owner);
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
        const authoritative = normalizeOrMigrateOwnerTabLayout({
          owner,
          layouts: current ? { [owner]: current } : undefined,
          sessionOrder: this.deps.store.getSessionOrder(),
          persistedSessions: persisted,
          liveSessions: [...this.deps.sessions.values()],
          webviews,
          updatedAt: (this.deps.now ?? (() => new Date().toISOString()))(),
        }).layout;
        const next = materializeOrphans(authoritative, ids, metadata);
        prepared.push({
          owner,
          current,
          next,
          stored: current && !sameLayout(current, next) ? this.prepareCommit(current, next) : null,
          metadata,
          excludedSessionIds: new Set(ids),
        });
      }

      const result = await action(new Set(confirmed.map((item) => item.id)));
      if (prepared.length > 0) {
        this.publish(
          Object.fromEntries(prepared.filter((item) => item.stored).map((item) => [item.owner, item.stored!])),
          prepared.map((item) => ({
            owner: item.owner,
            previous: item.current,
            next: item.stored ?? item.next,
            metadata: item.metadata,
            excludedSessionIds: item.excludedSessionIds,
          }))
        );
      }
      return result;
    });
  }

  async webviewDeleted(owner: string, id: string): Promise<void> {
    // Same explicit-user-action escape hatch as runSessionDeletion: a failed
    // restore skips layout coordination instead of failing the delete.
    if (this.restorationState === 'failed') return;
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
