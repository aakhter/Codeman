/** Authoritative identity supplied by the owning Codeman Session. */
export interface ObservableClaudeIdentity {
  workingDir: string;
  projectHash: string;
  claudeSessionId: string;
  claudeRuntimeVersion?: string;
}

export interface DirectoryIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

export interface ProcessInspectionSource {
  listPids(signal?: AbortSignal): Promise<number[]>;
  readCmdline(pid: number, signal?: AbortSignal): Promise<string | Buffer>;
  readEnviron(pid: number, signal?: AbortSignal): Promise<string | Buffer>;
  statProcessCwd(pid: number, signal?: AbortSignal): Promise<DirectoryIdentity>;
  statWorkingDirectory(workingDir: string, signal?: AbortSignal): Promise<DirectoryIdentity>;
}

export interface ProcessProofCandidate {
  pid: number;
  argv: readonly string[];
  environment: ReadonlyMap<string, string>;
}

export interface ExactConversationProof {
  source: 'argument' | 'environment';
  /** Version-matcher allowlisted flag or environment field. */
  field: string;
  claudeSessionId: string;
}

export type ProcessProofMatch =
  | { matched: false }
  | {
      matched: true;
      conversationProof: ExactConversationProof;
      /** Present only when the matcher also proves this exact Claude agent identity. */
      agentId?: string;
    };

export interface ProcessProofMatcher {
  capability: 'exact_role';
  match(candidate: ProcessProofCandidate, identity: ObservableClaudeIdentity): ProcessProofMatch;
}

export type ProcessProofMatcherRegistry = ReadonlyMap<string, ProcessProofMatcher>;

export type ProcessInspectionResult =
  | {
      status: 'positive';
      reason: 'matching_process';
      matcherCapability: 'exact_role';
      projectHash: string;
      claudeSessionId: string;
      agentIds: string[];
    }
  | {
      status: 'negative';
      reason: 'no_registered_role_signature' | 'no_matching_process';
      matcherCapability: 'none' | 'exact_role';
      projectHash: string;
      claudeSessionId: string;
      agentIds: [];
    }
  | {
      status: 'unknown';
      reason: 'unreadable_process_data' | 'aborted';
      matcherCapability: 'none' | 'exact_role';
      projectHash: string;
      claudeSessionId: string;
      agentIds: [];
    };

export interface ProcessInspectionOptions {
  signal?: AbortSignal;
  matcherRegistry?: ProcessProofMatcherRegistry;
}

const EMPTY_MATCHER_REGISTRY: ProcessProofMatcherRegistry = new Map();
class InspectionAbortedError extends Error {}

export function parseNulDelimited(value: string | Buffer): string[] {
  const fields = (Buffer.isBuffer(value) ? value.toString('utf8') : value).split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

export function readExactFlagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const acceptedFlags = new Set(flags);
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (acceptedFlags.has(token)) {
      const value = argv[index + 1];
      if (value !== undefined) values.push(value);
      index += 1;
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex > 0 && acceptedFlags.has(token.slice(0, equalsIndex))) {
      values.push(token.slice(equalsIndex + 1));
    }
  }

  return values;
}

/** Build exact argument proof for a version matcher from its own allowlisted flags. */
export function exactFlagConversationProof(
  argv: readonly string[],
  allowedFlags: readonly string[],
  claudeSessionId: string
): ExactConversationProof | undefined {
  for (const field of allowedFlags) {
    if (readExactFlagValues(argv, [field]).some((value) => value === claudeSessionId)) {
      return { source: 'argument', field, claudeSessionId };
    }
  }
  return undefined;
}

function parseEnvironment(value: string | Buffer): ReadonlyMap<string, string> {
  const environment = new Map<string, string>();
  for (const field of parseNulDelimited(value)) {
    const equalsIndex = field.indexOf('=');
    if (equalsIndex <= 0) continue;
    environment.set(field.slice(0, equalsIndex), field.slice(equalsIndex + 1));
  }
  return environment;
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function matcherFor(
  identity: ObservableClaudeIdentity,
  registry: ProcessProofMatcherRegistry
): ProcessProofMatcher | undefined {
  if (!identity.claudeRuntimeVersion) return undefined;
  return registry.get(identity.claudeRuntimeVersion);
}

function resultBase(identity: ObservableClaudeIdentity) {
  return {
    projectHash: identity.projectHash,
    claudeSessionId: identity.claudeSessionId,
  };
}

function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new InspectionAbortedError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new InspectionAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Inspect process data without interpreting watcher or renderer evidence.
 *
 * The built-in registry intentionally has no Claude 2.1.237 matcher: that build
 * has a verified renderer but no verified process-role signature.
 */
export async function inspectSubagentProcesses(
  identity: ObservableClaudeIdentity,
  source: ProcessInspectionSource,
  options: ProcessInspectionOptions = {}
): Promise<ProcessInspectionResult> {
  const registry = options.matcherRegistry ?? EMPTY_MATCHER_REGISTRY;
  const matcher = matcherFor(identity, registry);
  const matcherCapability = matcher?.capability ?? 'none';
  const signal = options.signal;

  try {
    const pids = await awaitWithAbort(source.listPids(signal), signal);
    const workingDirectory = await awaitWithAbort(source.statWorkingDirectory(identity.workingDir, signal), signal);
    const candidates: ProcessProofCandidate[] = [];

    for (const pid of pids) {
      const [rawArgv, rawEnvironment, processCwd] = await Promise.all([
        awaitWithAbort(source.readCmdline(pid, signal), signal),
        awaitWithAbort(source.readEnviron(pid, signal), signal),
        awaitWithAbort(source.statProcessCwd(pid, signal), signal),
      ]);
      const argv = parseNulDelimited(rawArgv);
      const environment = parseEnvironment(rawEnvironment);
      if (!sameDirectory(workingDirectory, processCwd)) continue;
      if (environment.get('CODEMAN_MUX') === '1') continue;
      candidates.push({ pid, argv, environment });
    }

    if (!matcher) {
      return {
        ...resultBase(identity),
        status: 'negative',
        reason: 'no_registered_role_signature',
        matcherCapability: 'none',
        agentIds: [],
      };
    }

    const agentIds = new Set<string>();
    let matched = false;
    for (const candidate of candidates) {
      if (signal?.aborted) throw new InspectionAbortedError();
      const match = matcher.match(candidate, identity);
      if (!match.matched) continue;
      if (match.conversationProof.claudeSessionId !== identity.claudeSessionId) continue;
      matched = true;
      if (match.agentId !== undefined) agentIds.add(match.agentId);
    }

    if (matched) {
      return {
        ...resultBase(identity),
        status: 'positive',
        reason: 'matching_process',
        matcherCapability: 'exact_role',
        agentIds: [...agentIds],
      };
    }

    return {
      ...resultBase(identity),
      status: 'negative',
      reason: 'no_matching_process',
      matcherCapability: 'exact_role',
      agentIds: [],
    };
  } catch (error) {
    return {
      ...resultBase(identity),
      status: 'unknown',
      reason: error instanceof InspectionAbortedError || signal?.aborted ? 'aborted' : 'unreadable_process_data',
      matcherCapability,
      agentIds: [],
    };
  }
}
