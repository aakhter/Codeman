import { describe, expect, it } from 'vitest';
import {
  claudeProjectHash,
  normalizeClaudeProjectPath,
  parseSubagentKey,
  serializeSubagentKey,
} from '../src/claude-project-identity.js';

describe('Claude project identity', () => {
  it('normalizes paths lexically without resolving symlink spelling', () => {
    expect(normalizeClaudeProjectPath('/workspace//linked-project/./src///')).toBe('/workspace/linked-project/src');
  });

  it('generates Claude project hashes from the normalized launch path', () => {
    expect(claudeProjectHash('/workspace//linked-project/./src///')).toBe('-workspace-linked-project-src');
  });

  it('round-trips composite subagent identities without delimiter collisions', () => {
    const first = serializeSubagentKey('project/one', 'conversation', 'agent');
    const second = serializeSubagentKey('project', 'one/conversation', 'agent');

    expect(first).not.toBe(second);
    expect(parseSubagentKey(first)).toEqual({
      projectHash: 'project/one',
      claudeSessionId: 'conversation',
      agentId: 'agent',
    });
    expect(parseSubagentKey(serializeSubagentKey('项目', 'conversation/with/slash', 'agent:1'))).toEqual({
      projectHash: '项目',
      claudeSessionId: 'conversation/with/slash',
      agentId: 'agent:1',
    });
  });

  it('rejects malformed opaque subagent keys', () => {
    expect(parseSubagentKey('project/conversation/agent')).toBeNull();
    expect(parseSubagentKey('v1.not-base64!')).toBeNull();
  });
});
