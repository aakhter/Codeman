import { describe, expect, it, vi } from 'vitest';
import {
  exactFlagConversationProof,
  inspectSubagentProcesses,
  parseNulDelimited,
  readExactFlagValues,
  type ObservableClaudeIdentity,
  type ProcessInspectionSource,
  type ProcessProofMatcher,
} from '../src/subagent-process-inspector.js';

const identity: ObservableClaudeIdentity = {
  workingDir: '/work/project',
  projectHash: '-work-project',
  claudeSessionId: 'conversation-123',
  claudeRuntimeVersion: '2.1.237',
};

const directoryIdentity = { dev: 8n, ino: 42n };

function source(
  processes: Array<{
    pid: number;
    argv?: string;
    environment?: string;
    cwd?: { dev: bigint; ino: bigint };
  }>
): ProcessInspectionSource {
  return {
    listPids: async () => processes.map(({ pid }) => pid),
    readCmdline: async (pid) => processes.find((process) => process.pid === pid)?.argv ?? '',
    readEnviron: async (pid) => processes.find((process) => process.pid === pid)?.environment ?? '',
    statProcessCwd: async (pid) => processes.find((process) => process.pid === pid)?.cwd ?? directoryIdentity,
    statWorkingDirectory: async () => directoryIdentity,
  };
}

describe('process input parsing', () => {
  it('parses NUL-delimited arguments and environments without substring matching', () => {
    expect(parseNulDelimited('claude\0--resume\0conversation-123\0')).toEqual([
      'claude',
      '--resume',
      'conversation-123',
    ]);
    expect(parseNulDelimited(Buffer.from('CLAUDE_SESSION_ID=conversation-123\0ROLE=worker\0'))).toEqual([
      'CLAUDE_SESSION_ID=conversation-123',
      'ROLE=worker',
    ]);
  });

  it('accepts exact split and equals flag forms and rejects near-name collisions', () => {
    expect(readExactFlagValues(['claude', '--resume', 'conversation-123'], ['--resume'])).toEqual(['conversation-123']);
    expect(readExactFlagValues(['claude', '--resume=conversation-123'], ['--resume'])).toEqual(['conversation-123']);
    expect(readExactFlagValues(['claude', '--resume-other=conversation-123'], ['--resume'])).toEqual([]);
  });
});

describe('inspectSubagentProcesses', () => {
  it('does not claim a role capability for the supported 2.1.237 runtime', async () => {
    const result = await inspectSubagentProcesses(
      identity,
      source([
        {
          pid: 10,
          argv: 'claude\0--resume\0conversation-123\0',
          environment: 'CLAUDE_SESSION_ID=conversation-123\0',
          cwd: directoryIdentity,
        },
      ])
    );

    expect(result).toEqual({
      status: 'negative',
      reason: 'no_registered_role_signature',
      matcherCapability: 'none',
      projectHash: '-work-project',
      claudeSessionId: 'conversation-123',
      agentIds: [],
    });
  });

  it.each([undefined, '', '2.1.999'] as const)(
    'selects no matcher for missing or unrecognized runtime version %s',
    async (claudeRuntimeVersion) => {
      const result = await inspectSubagentProcesses(
        { ...identity, claudeRuntimeVersion },
        source([{ pid: 10, argv: 'claude\0--resume\0conversation-123\0' }])
      );

      expect(result.status).toBe('negative');
      expect(result.reason).toBe('no_registered_role_signature');
      expect(result.matcherCapability).toBe('none');
    }
  );

  it('requires exact conversation and cwd identity before invoking a future matcher', async () => {
    const matcher: ProcessProofMatcher = {
      capability: 'exact_role',
      match: vi.fn((candidate, observableIdentity) => {
        const conversationProof = exactFlagConversationProof(
          candidate.argv,
          ['--session-id', '--resume'],
          observableIdentity.claudeSessionId
        );
        return conversationProof ? { matched: true, conversationProof, agentId: 'agent-7' } : { matched: false };
      }),
    };
    const registry = new Map([['future-test-runtime', matcher]]);
    const result = await inspectSubagentProcesses(
      { ...identity, claudeRuntimeVersion: 'future-test-runtime' },
      source([
        { pid: 1, argv: 'claude\0--resume\0conversation-123-extra\0', cwd: directoryIdentity },
        { pid: 2, argv: 'claude\0--resume=conversation-123\0', cwd: { dev: 8n, ino: 43n } },
        { pid: 3, argv: 'claude\0--resume=conversation-123\0', cwd: directoryIdentity },
      ]),
      { matcherRegistry: registry }
    );

    expect(matcher.match).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'positive',
      reason: 'matching_process',
      matcherCapability: 'exact_role',
      projectHash: '-work-project',
      claudeSessionId: 'conversation-123',
      agentIds: ['agent-7'],
      exactAgentProcesses: [{ agentId: 'agent-7', pid: 3 }],
    });
  });

  it('never promotes aggregate conversation proof into exact-agent process proof', async () => {
    const matcher: ProcessProofMatcher = {
      capability: 'exact_role',
      match: vi.fn((candidate, observableIdentity) => {
        const conversationProof = exactFlagConversationProof(
          candidate.argv,
          ['--session-id'],
          observableIdentity.claudeSessionId
        );
        return conversationProof ? { matched: true, conversationProof } : { matched: false };
      }),
    };

    const result = await inspectSubagentProcesses(
      { ...identity, claudeRuntimeVersion: 'future-test-runtime' },
      source([{ pid: 99, argv: 'claude\0--session-id\0conversation-123\0', cwd: directoryIdentity }]),
      { matcherRegistry: new Map([['future-test-runtime', matcher]]) }
    );

    expect(result).toMatchObject({ status: 'positive', agentIds: [], exactAgentProcesses: [] });
  });

  it('gives future matchers exact structured environment values without substring collisions', async () => {
    const matcher: ProcessProofMatcher = {
      capability: 'exact_role',
      // TEST_ROLE is deliberately test-only and is not a claimed Claude role signature.
      match: vi.fn((candidate, observableIdentity) => {
        const conversationProof = exactFlagConversationProof(
          candidate.argv,
          ['--session-id'],
          observableIdentity.claudeSessionId
        );
        return candidate.environment.get('TEST_ROLE') === 'worker' && conversationProof
          ? { matched: true, conversationProof }
          : { matched: false };
      }),
    };
    const result = await inspectSubagentProcesses(
      { ...identity, claudeRuntimeVersion: 'future-test-runtime' },
      source([
        {
          pid: 1,
          argv: 'claude\0--session-id\0conversation-123\0',
          environment: 'TEST_ROLE=worker-extra\0',
          cwd: directoryIdentity,
        },
        {
          pid: 2,
          argv: 'claude\0--session-id\0conversation-123\0',
          environment: 'TEST_ROLE=worker\0',
          cwd: directoryIdentity,
        },
      ]),
      { matcherRegistry: new Map([['future-test-runtime', matcher]]) }
    );

    expect(matcher.match).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('positive');
    expect(result.agentIds).toEqual([]);
  });

  it('lets a future matcher prove exact conversation identity from an environment-only field', async () => {
    const matcher: ProcessProofMatcher = {
      capability: 'exact_role',
      // TEST_CONVERSATION_ID is deliberately test-only, not a production Claude allowlist claim.
      match: vi.fn((candidate) => {
        const claudeSessionId = candidate.environment.get('TEST_CONVERSATION_ID');
        return claudeSessionId === identity.claudeSessionId
          ? {
              matched: true,
              conversationProof: {
                source: 'environment',
                field: 'TEST_CONVERSATION_ID',
                claudeSessionId,
              },
            }
          : { matched: false };
      }),
    };
    const result = await inspectSubagentProcesses(
      { ...identity, claudeRuntimeVersion: 'future-test-runtime' },
      source([
        {
          pid: 1,
          argv: 'future-worker\0',
          environment: 'TEST_CONVERSATION_ID=conversation-123-extra\0',
          cwd: directoryIdentity,
        },
        {
          pid: 2,
          argv: 'future-worker\0',
          environment: 'TEST_CONVERSATION_ID=conversation-123\0',
          cwd: directoryIdentity,
        },
      ]),
      { matcherRegistry: new Map([['future-test-runtime', matcher]]) }
    );

    expect(matcher.match).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'positive', reason: 'matching_process' });
  });

  it('rejects a matcher claim whose conversation proof is not the exact authoritative identity', async () => {
    const matcher: ProcessProofMatcher = {
      capability: 'exact_role',
      match: vi.fn(() => ({
        matched: true,
        conversationProof: {
          source: 'environment',
          field: 'TEST_CONVERSATION_ID',
          claudeSessionId: 'conversation-123-extra',
        },
      })),
    };
    const result = await inspectSubagentProcesses(
      { ...identity, claudeRuntimeVersion: 'future-test-runtime' },
      source([{ pid: 1, argv: 'future-worker\0', cwd: directoryIdentity }]),
      { matcherRegistry: new Map([['future-test-runtime', matcher]]) }
    );

    expect(result).toMatchObject({ status: 'negative', reason: 'no_matching_process' });
  });

  it('excludes parent, helper, and generic children when the injected matcher does not prove their role', async () => {
    const matcher: ProcessProofMatcher = {
      capability: 'exact_role',
      match: vi.fn(() => ({ matched: false })),
    };
    const result = await inspectSubagentProcesses(
      { ...identity, claudeRuntimeVersion: 'future-test-runtime' },
      source([
        { pid: 1, argv: 'claude\0--resume\0conversation-123\0', cwd: directoryIdentity },
        { pid: 2, argv: 'claude-helper\0--resume=conversation-123\0', cwd: directoryIdentity },
        { pid: 3, argv: 'node\0child.js\0--resume=conversation-123\0', cwd: directoryIdentity },
      ]),
      { matcherRegistry: new Map([['future-test-runtime', matcher]]) }
    );

    expect(result).toMatchObject({
      status: 'negative',
      reason: 'no_matching_process',
      matcherCapability: 'exact_role',
      agentIds: [],
    });
  });

  it('excludes the Codeman-managed parent even if a future matcher would otherwise accept it', async () => {
    const matcher: ProcessProofMatcher = {
      capability: 'exact_role',
      match: vi.fn(() => ({
        matched: true,
        conversationProof: {
          source: 'argument',
          field: '--session-id',
          claudeSessionId: identity.claudeSessionId,
        },
        agentId: 'must-not-escape',
      })),
    };
    const result = await inspectSubagentProcesses(
      { ...identity, claudeRuntimeVersion: 'future-test-runtime' },
      source([
        {
          pid: 1,
          argv: 'claude\0--session-id=conversation-123\0',
          environment: 'CODEMAN_MUX=1\0',
          cwd: directoryIdentity,
        },
      ]),
      { matcherRegistry: new Map([['future-test-runtime', matcher]]) }
    );

    expect(matcher.match).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'negative', reason: 'no_matching_process', agentIds: [] });
  });

  it.each(['readCmdline', 'readEnviron', 'statProcessCwd'] as const)(
    'returns unknown when %s is unreadable',
    async (operation) => {
      const failingSource = source([{ pid: 1 }]);
      failingSource[operation] = async () => {
        throw new Error('permission denied');
      };

      const result = await inspectSubagentProcesses(identity, failingSource);

      expect(result).toMatchObject({ status: 'unknown', reason: 'unreadable_process_data' });
    }
  );

  it('returns unknown when the authoritative working directory is unreadable', async () => {
    const failingSource = source([{ pid: 1 }]);
    failingSource.statWorkingDirectory = async () => {
      throw new Error('not found');
    };

    await expect(inspectSubagentProcesses(identity, failingSource)).resolves.toMatchObject({
      status: 'unknown',
      reason: 'unreadable_process_data',
    });
  });

  it('settles as aborted and ignores process results that arrive later', async () => {
    let resolvePids!: (pids: number[]) => void;
    const matcher: ProcessProofMatcher = {
      capability: 'exact_role',
      match: vi.fn(() => ({
        matched: true,
        conversationProof: {
          source: 'argument',
          field: '--session-id',
          claudeSessionId: identity.claudeSessionId,
        },
      })),
    };
    const delayedSource = source([]);
    delayedSource.listPids = vi.fn(
      () =>
        new Promise<number[]>((resolve) => {
          resolvePids = resolve;
        })
    );
    const controller = new AbortController();
    const inspection = inspectSubagentProcesses(
      { ...identity, claudeRuntimeVersion: 'future-test-runtime' },
      delayedSource,
      { signal: controller.signal, matcherRegistry: new Map([['future-test-runtime', matcher]]) }
    );

    controller.abort();
    await expect(inspection).resolves.toMatchObject({ status: 'unknown', reason: 'aborted' });
    resolvePids([1]);
    await Promise.resolve();
    expect(matcher.match).not.toHaveBeenCalled();
    expect(delayedSource.listPids).toHaveBeenCalledWith(controller.signal);
  });
});
