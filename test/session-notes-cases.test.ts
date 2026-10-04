import { describe, expect, it, vi, afterEach } from 'vitest';
import { listCaseView } from '../src/web/routes/case-routes.js';
import { StateStore } from '../src/state-store.js';
import { dataPath } from '../src/config/instance.js';

vi.mock('../src/remote-hosts.js', async (load) => ({
  ...(await load<object>()),
  readRemoteHosts: async () => [{ id: 'ssh', username: 'sshuser', host: 'host' }],
  readRemoteCases: async () => [
    { name: 'alice-ssh', owner: 'alice', hostId: 'ssh', remotePath: '/alice' },
    { name: 'bob-ssh', owner: 'bob', hostId: 'ssh', remotePath: '/bob' },
    { name: 'legacy-ssh', hostId: 'ssh', remotePath: '/legacy' },
  ],
}));
vi.mock('../src/docker-hosts.js', async (load) => ({
  ...(await load<object>()),
  readDockerHosts: async () => [{ id: 'docker', image: 'image' }],
  readDockerCases: async () => [
    { name: 'alice-docker', owner: 'alice', hostId: 'docker', hostWorkspacePath: '/alice' },
    { name: 'bob-docker', owner: 'bob', hostId: 'docker', hostWorkspacePath: '/bob' },
    { name: 'legacy-docker', hostId: 'docker', hostWorkspacePath: '/legacy' },
  ],
}));
afterEach(() => vi.unstubAllEnvs());
describe('shared case listing notebook privacy', () => {
  it('uses exact remote/docker ownership for notebook admin views while preserving ordinary admin listing', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const ctx = { store: new StateStore(dataPath('cases-notes-test.json')) };
    const user = { username: 'alice', role: 'admin' as const };
    expect((await listCaseView(ctx, user as never, true)).map((info) => info.name).sort()).toEqual([
      'alice-docker',
      'alice-ssh',
    ]);
    expect((await listCaseView(ctx, user as never)).map((info) => info.name)).toHaveLength(6);
  });
});
