/** Reuse SSH transport for remote visible-frame captures without changing launch or history paths. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CONTROL_PERSIST_SECONDS = 60;
const CONTROL_CHECK_TIMEOUT_MS = 500;
const CONTROL_EXIT_TIMEOUT_MS = 1_000;

type SshExecutor = (argv: string[], options: { timeout: number; maxBuffer: number }) => Promise<string>;

const executeSsh: SshExecutor = async (argv, options) => {
  const { stdout } = await execFileAsync('ssh', argv, { ...options, encoding: 'utf-8' });
  return stdout;
};

interface ControlSocket {
  key: string;
  path: string;
  baseArgv: string[];
  target: string;
}

function isTransportFailure(error: unknown): boolean {
  const failure = error as { code?: unknown; killed?: unknown };
  return failure?.killed === true || failure?.code === 255;
}

/** A private pool for one Codeman process. A different owner or SSH configuration gets a different socket. */
export class RemoteFrameSshPool {
  private directory: string | null = null;
  private sockets = new Map<string, ControlSocket>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private readonly removeDirectoryOnExit = () => {
    if (this.directory) {
      try {
        rmSync(this.directory, { recursive: true, force: true });
      } catch {
        // Process exit is already in progress.
      }
    }
  };

  constructor(private readonly execute: SshExecutor = executeSsh) {}

  private socketFor(baseArgv: string[], target: string, owner: string | undefined): ControlSocket | null {
    // An explicit saved control setting belongs to the user. Never replace it with an app-owned socket.
    if (
      this.closed ||
      process.platform === 'win32' ||
      baseArgv.some((arg) => /^(?:ControlMaster|ControlPath|ControlPersist)=/i.test(arg))
    ) {
      return null;
    }

    try {
      if (!this.directory) {
        const directory = mkdtempSync(join(tmpdir(), 'codeman-frame-'));
        try {
          chmodSync(directory, 0o700);
        } catch (error) {
          rmSync(directory, { recursive: true, force: true });
          throw error;
        }
        this.directory = directory;
        process.once('exit', this.removeDirectoryOnExit);
      }
      const key = createHash('sha256')
        .update(JSON.stringify([owner === undefined ? null : owner, target, baseArgv]))
        .digest('hex');
      let socket = this.sockets.get(key);
      if (!socket) {
        const path = join(this.directory, key.slice(0, 32));
        // OpenSSH uses a Unix-domain socket. A long custom TMPDIR must fall back to ordinary SSH.
        if (Buffer.byteLength(path) > 90) return null;
        socket = { key, path, baseArgv: [...baseArgv], target };
        this.sockets.set(key, socket);
      }
      return socket;
    } catch {
      // A full or unavailable local temporary directory must not make remote sessions unreadable.
      return null;
    }
  }

  private async discardStaleSocket(socket: ControlSocket): Promise<void> {
    if (!existsSync(socket.path)) return;
    try {
      await this.execute([...socket.baseArgv, '-S', socket.path, '-O', 'check', socket.target], {
        timeout: CONTROL_CHECK_TIMEOUT_MS,
        maxBuffer: 1024,
      });
    } catch {
      // The master is gone or unresponsive. Unlink only our own private socket so auto mode can create a new one.
      try {
        unlinkSync(socket.path);
      } catch {
        // The master may have removed it concurrently.
      }
    }
  }

  private async exitMaster(socket: ControlSocket): Promise<void> {
    if (!existsSync(socket.path)) return;
    try {
      await this.execute([...socket.baseArgv, '-S', socket.path, '-O', 'exit', socket.target], {
        timeout: CONTROL_EXIT_TIMEOUT_MS,
        maxBuffer: 1024,
      });
    } catch {
      // A broken master is still bounded by ControlPersist and the private socket is removed below.
    }
    try {
      unlinkSync(socket.path);
    } catch {
      // OpenSSH normally removes its own socket on exit.
    }
  }

  async capture(
    baseArgv: string[],
    target: string,
    command: string,
    owner: string | undefined,
    options: { timeout: number; maxBuffer: number }
  ): Promise<string> {
    const socket = this.socketFor(baseArgv, target, owner);
    if (socket) await this.discardStaleSocket(socket);
    const argv = socket
      ? [
          ...baseArgv,
          '-o',
          'ControlMaster=auto',
          '-o',
          `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
          '-o',
          `ControlPath=${socket.path}`,
          target,
          command,
        ]
      : [...baseArgv, target, command];
    try {
      return await this.execute(argv, options);
    } catch (error) {
      if (socket && isTransportFailure(error)) {
        this.sockets.delete(socket.key);
        // A different pane may still be using this master. Unlink our socket so the next capture
        // connects afresh, while existing channels can finish and ControlPersist bounds the old master.
        try {
          unlinkSync(socket.path);
        } catch {
          // OpenSSH may already have removed it.
        }
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const sockets = [...this.sockets.values()];
    this.sockets.clear();
    const directory = this.directory;
    this.closing = Promise.allSettled(sockets.map((socket) => this.exitMaster(socket))).then(() => {
      if (directory) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          // A failed temporary-directory cleanup must not hold web-server shutdown open.
        }
      }
      this.directory = null;
      process.removeListener('exit', this.removeDirectoryOnExit);
    });
    return this.closing;
  }
}
