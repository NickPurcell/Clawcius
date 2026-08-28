import { lstatSync, unlinkSync, chmodSync, type Stats } from 'node:fs';
import { connect, type Server } from 'node:net';
import { createServer, type RequestListener } from 'node:http';

const SOCKET_MODE = 0o600;

const MAX_SOCKET_CONNECTIONS = 64;

export type SocketOutcome =
  | {
      path: string;
      listening: true;
      server: Server;
      dropped: number;
    }
  | { path: string; listening: false; reason: string };

function describe(info: Stats): string {
  if (info.isDirectory()) return 'a directory';
  if (info.isSymbolicLink()) return 'a symbolic link';
  if (info.isFile()) return 'a regular file';
  if (info.isFIFO()) return 'a FIFO';
  if (info.isBlockDevice()) return 'a block device';
  if (info.isCharacterDevice()) return 'a character device';
  return 'not a socket';
}

function isSocketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    const done = (alive: boolean): void => {
      probe.destroy();
      resolve(alive);
    };
    probe.once('connect', () => done(true));
    probe.once('error', (error: NodeJS.ErrnoException) => {
      done(!(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'));
    });
    // A path that accepts the connection but never completes it should not
    // hang the boot. Treating a timeout as "alive" is the conservative branch:
    // it declines to bind rather than deleting something that answered.
    probe.setTimeout(2000, () => done(true));
  });
}

export async function claimSocketPath(path: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Nothing there: the normal first-boot case, and the normal case after a
    // clean shutdown, which unlinks.
    if (code === 'ENOENT') return { ok: true };
    // ENOTDIR, EACCES, a missing parent — all mean the configured path is not
    // usable, and none of them mean "delete something".
    return { ok: false, reason: `cannot stat it (${code ?? 'unknown error'})` };
  }

  if (!info.isSocket()) {
    return {
      ok: false,
      reason:
        `it exists and is ${describe(info)}, not a socket — refusing to unlink it. ` +
        'This directory is writable by the agent container, so something that is not a ' +
        'socket here is either an agent\'s own file or an attempt to have this service ' +
        'delete something on its behalf; either way it is not ours to remove',
    };
  }

  if (await isSocketAlive(path)) {
    return {
      ok: false,
      reason:
        'a live server is already listening on it — this is a real EADDRINUSE, not a ' +
        'stale file, so it is left alone (is a second clawcius-status running?)',
    };
  }

  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Lost the race to something else removing it, which is fine.
    if (code === 'ENOENT') return { ok: true };
    return { ok: false, reason: `it is a stale socket that could not be removed (${code ?? 'unknown error'})` };
  }
  return { ok: true };
}

export async function bindUnixSockets(
  paths: readonly string[],
  handler: RequestListener,
): Promise<SocketOutcome[]> {
  const outcomes: SocketOutcome[] = [];

  for (const path of paths) {
    const claim = await claimSocketPath(path);
    if (!claim.ok) {
      outcomes.push({ path, listening: false, reason: claim.reason });
      continue;
    }

    const server = createServer(handler);
    server.maxConnections = MAX_SOCKET_CONNECTIONS;

    const outcome = await new Promise<SocketOutcome>((resolve) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        const hint =
          error.code === 'EROFS'
            ? ' — the filesystem is read-only here; clawcius-status.service needs a ' +
              'ReadWritePaths= line for this directory'
            : error.code === 'EACCES'
              ? ' — check that the service user owns this directory'
              : '';
        resolve({ path, listening: false, reason: `${error.code ?? 'bind failed'}${hint}` });
      };
      server.once('error', onError);
      server.listen(path, () => {
        server.removeListener('error', onError);

        server.on('error', (error: NodeJS.ErrnoException) => {
          console.warn(`[status] error on ${path}: ${error.code ?? error.message}`);
        });

        try {
          chmodSync(path, SOCKET_MODE);
        } catch (error) {
          console.warn(
            `[status] could not chmod ${path} to ${SOCKET_MODE.toString(8)}: ` +
              `${(error as NodeJS.ErrnoException).code ?? error}`,
          );
        }

        const settled: SocketOutcome = { path, listening: true, server, dropped: 0 };
        // 'drop' fires when maxConnections turned a connection away. Without
        // this the cap would be silent on both sides.
        server.on('drop', () => {
          settled.dropped += 1;
          if (settled.dropped === 1) {
            console.warn(
              `[status] ${path} hit maxConnections (${MAX_SOCKET_CONNECTIONS}); ` +
                'refusing further connections until some are released. Further drops ' +
                'are counted in /healthz rather than logged, so that a client looping ' +
                'on connect cannot flood the journal.',
            );
          }
        });
        resolve(settled);
      });
    });
    outcomes.push(outcome);
  }

  return outcomes;
}

/** Remove a socket file we created, on the way out. */
export function releaseSocketPath(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch {
    // ENOENT is the expected case — close() already did it.
  }
}
