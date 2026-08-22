import { readdir, readFile, readlink } from 'node:fs/promises';

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

function parentPidFromStat(stat) {
  const closeParen = stat.lastIndexOf(')');
  const fields = stat
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/);
  return Number(fields[1]);
}

export async function findLinuxDescendantPids(rootPid, procRoot = '/proc') {
  if (process.platform !== 'linux') throw new Error('process descendant proof unsupported on this platform');
  const entries = await readdir(procRoot, { withFileTypes: true });
  const parents = new Map();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const stat = await readFile(`${procRoot}/${entry.name}/stat`, 'utf8').catch(() => null);
        if (stat) parents.set(Number(entry.name), parentPidFromStat(stat));
      })
  );
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of parents) {
      if (!owned.has(pid) && owned.has(parentPid)) {
        owned.add(pid);
        changed = true;
      }
    }
  }
  return [...owned].sort((left, right) => left - right);
}

export async function proveReachedServerOwnership({
  baseUrl,
  port,
  spawnedPid,
  authenticate,
  findListenerOwners = findLinuxListenerOwners,
  findDescendantPids = findLinuxDescendantPids,
}) {
  const authentication = await authenticate(baseUrl);
  const [listenerPids, descendantPids] = await Promise.all([findListenerOwners(port), findDescendantPids(spawnedPid)]);
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
    ownershipMethod: 'authenticated HTTP nonce plus Linux listener inode/process-tree proof',
  };
}
