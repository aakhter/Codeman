import { readdir, readFile, readlink } from 'node:fs/promises';
import { createConnection } from 'node:net';

function listenerInodes(content, port) {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  return new Set(
    content
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length > 9 && fields[1]?.endsWith(`:${portHex}`) && fields[3] === '0A')
      .map((fields) => fields[9])
  );
}

export async function findLinuxListenerOwners(port, procRoot = '/proc') {
  if (process.platform !== 'linux') throw new Error('listener ownership proof unsupported on this platform');
  const [tcp, tcp6] = await Promise.all([
    readFile(`${procRoot}/net/tcp`, 'utf8').catch(() => ''),
    readFile(`${procRoot}/net/tcp6`, 'utf8').catch(() => ''),
  ]);
  const inodes = new Set([...listenerInodes(tcp, port), ...listenerInodes(tcp6, port)]);
  if (inodes.size === 0) return [];
  const entries = await readdir(procRoot, { withFileTypes: true });
  const owners = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        const descriptors = await readdir(`${procRoot}/${pid}/fd`).catch(() => []);
        for (const descriptor of descriptors) {
          const target = await readlink(`${procRoot}/${pid}/fd/${descriptor}`).catch(() => '');
          const match = target.match(/^socket:\[(\d+)]$/);
          if (match && inodes.has(match[1])) {
            owners.push(pid);
            return;
          }
        }
      })
  );
  return [...new Set(owners)].sort((left, right) => left - right);
}

function processIdentityFromStat(stat) {
  const closeParen = stat.lastIndexOf(')');
  const openParen = stat.indexOf('(');
  if (openParen < 1 || closeParen <= openParen) throw new Error('invalid Linux process stat record');
  const fields = stat
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(stat.slice(0, openParen).trim());
  const parentPid = Number(fields[1]);
  const startTimeTicks = fields[19];
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parentPid) || !/^\d+$/.test(startTimeTicks)) {
    throw new Error('invalid Linux process identity');
  }
  return { pid, parentPid, startTimeTicks };
}

export async function readLinuxProcessIdentity(pid, procRoot = '/proc') {
  if (process.platform !== 'linux') throw new Error('process identity proof unsupported on this platform');
  const stat = await readFile(`${procRoot}/${pid}/stat`, 'utf8').catch(() => null);
  return stat ? processIdentityFromStat(stat) : null;
}

export async function findLinuxDescendantProcesses(rootPid, procRoot = '/proc') {
  if (process.platform !== 'linux') throw new Error('process descendant proof unsupported on this platform');
  const entries = await readdir(procRoot, { withFileTypes: true });
  const processes = new Map();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const stat = await readFile(`${procRoot}/${entry.name}/stat`, 'utf8').catch(() => null);
        if (!stat) return;
        const identity = processIdentityFromStat(stat);
        processes.set(identity.pid, identity);
      })
  );
  if (!processes.has(rootPid))
    throw new Error(`spawned process identity disappeared before ownership proof: ${rootPid}`);
  const owned = new Map([[rootPid, { ...processes.get(rootPid), depth: 0 }]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, identity] of processes) {
      const parent = owned.get(identity.parentPid);
      if (!owned.has(pid) && parent) {
        owned.set(pid, { ...identity, depth: parent.depth + 1 });
        changed = true;
      }
    }
  }
  return [...owned.values()].sort((left, right) => left.pid - right.pid);
}

export async function findLinuxDescendantPids(rootPid, procRoot = '/proc') {
  return (await findLinuxDescendantProcesses(rootPid, procRoot)).map(({ pid }) => pid);
}

function sameProcessIdentity(expected, actual) {
  return actual?.pid === expected.pid && actual.startTimeTicks === expected.startTimeTicks;
}

export async function terminateLinuxProcessIdentities({
  rootPid,
  processIdentities,
  signal,
  readProcessIdentity = readLinuxProcessIdentity,
  kill = process.kill.bind(process),
}) {
  const signaledPids = [];
  const skippedPids = [];
  const descendants = processIdentities
    .filter(({ pid }) => pid !== rootPid)
    .sort((left, right) => right.depth - left.depth || right.pid - left.pid);
  for (const identity of descendants) {
    const current = await readProcessIdentity(identity.pid);
    if (!current) {
      skippedPids.push({ pid: identity.pid, reason: 'not-found' });
      continue;
    }
    if (!sameProcessIdentity(identity, current)) {
      skippedPids.push({ pid: identity.pid, reason: 'identity-mismatch' });
      continue;
    }
    try {
      kill(identity.pid, signal);
      signaledPids.push(identity.pid);
    } catch (error) {
      if (error?.code === 'ESRCH') skippedPids.push({ pid: identity.pid, reason: 'not-found' });
      else throw error;
    }
  }
  return { signaledPids, skippedPids };
}

export async function isLoopbackPortClosed({ host, port, timeoutMs = 250 }) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(closed);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error) => finish(error?.code === 'ECONNREFUSED'));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function verifyLinuxOwnedServerStopped({
  processIdentities,
  host,
  port,
  readProcessIdentity = readLinuxProcessIdentity,
  findListenerOwners = findLinuxListenerOwners,
  isPortClosed = isLoopbackPortClosed,
}) {
  const [currentIdentities, listenerPidsStillBound, portClosed] = await Promise.all([
    Promise.all(processIdentities.map(({ pid }) => readProcessIdentity(pid))),
    findListenerOwners(port),
    isPortClosed({ host, port }),
  ]);
  return {
    exactPidsStillAlive: processIdentities
      .filter((identity, index) => sameProcessIdentity(identity, currentIdentities[index]))
      .map(({ pid }) => pid),
    listenerPidsStillBound,
    portClosed,
  };
}

export function createLinuxOwnedProcessTreeResource({
  ownership,
  host,
  port,
  readProcessIdentity = readLinuxProcessIdentity,
  findListenerOwners = findLinuxListenerOwners,
  isPortClosed = isLoopbackPortClosed,
  kill = process.kill.bind(process),
}) {
  const processIdentities = ownership.processIdentities.map((identity) => ({ ...identity }));
  return {
    rootPid: ownership.spawnedPid,
    listenerPid: ownership.listenerPid,
    port,
    processIdentities,
    terminate: (signal) =>
      terminateLinuxProcessIdentities({
        rootPid: ownership.spawnedPid,
        processIdentities,
        signal,
        readProcessIdentity,
        kill,
      }),
    verify: () =>
      verifyLinuxOwnedServerStopped({
        processIdentities,
        host,
        port,
        readProcessIdentity,
        findListenerOwners,
        isPortClosed,
      }),
  };
}

export async function proveReachedServerOwnership({
  baseUrl,
  port,
  spawnedPid,
  authenticate,
  findListenerOwners = findLinuxListenerOwners,
  findDescendantProcesses = findLinuxDescendantProcesses,
}) {
  const authentication = await authenticate(baseUrl);
  const [listenerPids, processIdentities] = await Promise.all([
    findListenerOwners(port),
    findDescendantProcesses(spawnedPid),
  ]);
  const descendantPids = processIdentities.map(({ pid }) => pid);
  const owned = new Set(descendantPids);
  const listenerPid = listenerPids.find((pid) => owned.has(pid));
  if (!listenerPid) {
    throw new Error(
      `listener is not owned by spawned server process tree: listeners=${listenerPids.join(',') || 'none'} spawned=${spawnedPid}`
    );
  }
  return {
    ...authentication,
    listenerPid,
    listenerPids,
    spawnedPid,
    descendantPids,
    processIdentities,
    ownershipMethod: 'authenticated HTTP nonce plus Linux listener inode/process-tree/start-time proof',
  };
}
