import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3102;

describe('Interactive Session Lifecycle', () => {
  let server: WebServer;
  let baseUrl: string;
  // Own, isolated working-directory fixture instead of the shared /tmp — a
  // session writes .claude/ and .claude-images/ into its workingDir, so the
  // test should not pollute /tmp or depend on its contents (COD-44).
  let testWorkingDir: string;

  beforeAll(async () => {
    testWorkingDir = mkdtempSync(join(tmpdir(), 'codeman-session-test-'));
    server = new WebServer(TEST_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(testWorkingDir, { recursive: true, force: true });
  }, 60000); // Extended timeout for cleanup

  describe('Session Creation', () => {
    it('places a targeted session at the end of the requested tab group', async () => {
      const groupId = `session-create-${Date.now()}`;
      const baseResponse = await fetch(`${baseUrl}/api/tab-layout`);
      const baseData = await baseResponse.json();
      const baseLayout = baseData.data.layout;

      const groupResponse = await fetch(`${baseUrl}/api/tab-layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseVersion: baseLayout.version,
          operations: [{ type: 'createGroup', id: groupId, name: 'Session creation target' }],
        }),
      });
      const groupData = await groupResponse.json();
      expect(groupData.success).toBe(true);

      const createResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: testWorkingDir, mode: 'shell', tabGroupId: groupId }),
      });
      const createData = await createResponse.json();
      const sessionId = createData.data.session.id;

      try {
        expect(createData.success).toBe(true);
        expect(
          createData.data.tabLayout.groups.find((group: { id: string }) => group.id === groupId)?.refs.at(-1)
        ).toEqual({ kind: 'session', id: sessionId });

        const currentResponse = await fetch(`${baseUrl}/api/tab-layout`);
        const currentData = await currentResponse.json();
        expect(currentData.data.layout).toEqual(createData.data.tabLayout);
      } finally {
        await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
      }
    });

    it('should create session with default working directory', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.data.session.id).toBeDefined();
      expect(data.data.session.workingDir).toBeDefined();
      expect(data.data.session.status).toBe('idle');
    });

    it('should create session with custom working directory', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: testWorkingDir }),
      });

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.data.session.workingDir).toBe(testWorkingDir);
    });
  });

  describe('Session Retrieval', () => {
    it('should get session by id', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.data.session.id;

      // Get the session
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      const data = await response.json();

      expect(data.data.id).toBe(sessionId);
      expect(data.data.status).toBeDefined();
    });

    it('should return error for non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent-id`);
      const data = await response.json();

      expect(data.error).toContain('not found');
    });
  });

  describe('Session Deletion', () => {
    it('should delete a session', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.data.session.id;

      // Delete the session
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(data.success).toBe(true);

      // Verify it's gone
      const getRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
      const getData = await getRes.json();
      expect(getData.error).toContain('not found');
    });

    it('should return error when deleting non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent-id`, {
        method: 'DELETE',
      });
      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toContain('not found');
    });
  });

  describe('Session Output', () => {
    it('should get session output buffer', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.data.session.id;

      // Get output
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/output`);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('textOutput');
      expect(data.data).toHaveProperty('messages');
      expect(data.data).toHaveProperty('errorBuffer');
    });
  });

  describe('Session Terminal Buffer', () => {
    it('should get session terminal buffer', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.data.session.id;

      // Get terminal buffer
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/terminal`);
      const data = await response.json();

      expect(data.data).toHaveProperty('terminalBuffer');
      expect(data.data).toHaveProperty('status');
    });
  });

  describe('Interactive Mode', () => {
    it('should start interactive session', async () => {
      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.data.session.id;

      // Start interactive mode
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/interactive`, {
        method: 'POST',
      });
      const data = await response.json();

      expect(data.success).toBe(true);
    });

    it('should return error for non-existent session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions/non-existent/interactive`, {
        method: 'POST',
      });
      const data = await response.json();

      expect(data.error).toContain('not found');
    });
  });

  describe('Session Input', () => {
    it('should send input to interactive session', async () => {
      // Create and start interactive session
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.data.session.id;

      await fetch(`${baseUrl}/api/sessions/${sessionId}/interactive`, {
        method: 'POST',
      });

      // Wait a bit for interactive session to start
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Send input
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'test input\n' }),
      });
      const data = await response.json();

      expect(data.success).toBe(true);
    });
  });

  describe('Session Resize', () => {
    it('should resize session terminal', async () => {
      // Create and start interactive session
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const createData = await createRes.json();
      const sessionId = createData.data.session.id;

      await fetch(`${baseUrl}/api/sessions/${sessionId}/interactive`, {
        method: 'POST',
      });

      // Resize
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      });
      const data = await response.json();

      expect(data.success).toBe(true);
    });
  });
});
