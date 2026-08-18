/**
 * Unix domain socket listeners for the status page.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The agent containers are on `clawcius-internal`, a docker network with no
 * gateway. Measured from inside one: `172.17.0.1:8477` and `172.31.250.1:8477`
 * are both "Network is unreachable", and squid is the only route out. So an
 * agent cannot reach the status page, and the operator wants it to be able to.
 *
 * The tempting fix is to bind the HTTP server somewhere the container can
 * route to. That trades away precisely the property the loopback bind exists
 * to buy — `tailscale serve` terminates TLS in front of this service, so a
 * loopback bind means a dead tailscaled makes the page UNREACHABLE rather than
 * PUBLIC — and it is not on the table. `config.ts` and `index.ts` both still
 * refuse a non-loopback host, unchanged.
 *
 * A unix socket sidesteps the question rather than answering it. It is not on
 * a network: it has no port, no address family a remote host can name, and
 * `IPAddressDeny=any` in the unit neither applies to it nor needs to. The set
 * of TCP endpoints serving this page is byte for byte what it was before this
 * file existed. What carries the traffic instead is the filesystem — the one
 * read-write bind mount `docker/run-container.sh` already gives each container
 * (`$CLAWCIUS_STATE/run`, Clawcius #65), which until now had no user at all.
 *
 * ── What the container can do to it ────────────────────────────────────────
 *
 * That mount is read-write, so the container can delete the socket, or put
 * something else at the path. Both are considered below and neither is a way
 * into anything: the worst an agent achieves is breaking its OWN access to the
 * page until the service is restarted. Specifically it cannot use this to make
 * the service delete a file elsewhere (see `claimSocketPath`), and it cannot
 * use it to take the service down (see `bindUnixSockets` — a socket that
 * cannot be claimed is a warning, never a boot failure).
 */

import { lstatSync, unlinkSync, chmodSync, type Stats } from 'node:fs';
import { connect, type Server } from 'node:net';
import { createServer, type RequestListener } from 'node:http';

/**
 * Mode applied to the socket once it is listening.
 *
 * 0600, not the 0755 a default systemd umask of 0022 would leave: the only
 * principal that should ever connect is the container, and the container runs
 * as the same uid that owns the host-side run directory. Note that the run
 * directory itself is world-traversable (`drwxr-xr-x`), so without this an
 * unprivileged local user could connect — a small hole on a host with two
 * accounts, but free to close.
 *
 * Applied in the `listening` callback rather than by setting a process-wide
 * umask, so there is a sub-millisecond window where the socket exists at the
 * umask default. Closing that window properly would mean mutating global umask
 * around an async listen, which is worse; on a host whose only other principal
 * is root, this is the right side of that trade and is written down rather
 * than glossed.
 */
const SOCKET_MODE = 0o600;

export type SocketOutcome =
  | { path: string; listening: true; server: Server }
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

/**
 * Is something actually listening on this socket, or is it a leftover?
 *
 * A unix socket file outlives the process that bound it. An unclean exit —
 * SIGKILL, an OOM kill, a host that lost power — leaves the file on disk, and
 * the next `listen()` on that path fails with EADDRINUSE even though nothing
 * is there. The only way to tell a live socket from a corpse is to knock.
 *
 * ECONNREFUSED means the file is a corpse. ENOENT means it went away between
 * the lstat and now, which is also fine. ANYTHING ELSE is treated as alive:
 * EACCES in particular means something is there that we are not allowed to
 * talk to, and "I could not connect" is not a licence to delete.
 */
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

/**
 * Make `path` bindable, or explain why it must be left alone.
 *
 * ── The "unlink whatever is there and bind" trap ───────────────────────────
 *
 * The naive form of this function deletes whatever it finds and binds. The
 * container can write this directory, so that turns an agent's `touch` into a
 * deletion performed by the host service — an agent that cannot delete a file
 * gets the status service to do it. Two things stop that here:
 *
 *   1. It only ever unlinks something `lstat` reports as a SOCKET. A regular
 *      file, a directory, a FIFO or a symlink at that path is a refusal, not a
 *      target. In particular a hard link to something valuable is a regular
 *      file and is refused.
 *
 *   2. `unlink()` does not follow symlinks — it removes the link, never what
 *      it points at. So the obvious escalation, pointing `status.sock` at
 *      `/var/lib/hamachi/hamachi.db` and waiting for a restart, deletes the
 *      symlink and leaves the board alone. It would be refused at step 1
 *      anyway; this is the second, independent reason.
 *
 * There is still a TOCTOU window between the lstat and the unlink, and it is
 * deliberately not closed, because closing it buys nothing. The only thing
 * that can win the race is something that can already write this directory,
 * and anything that can write this directory can delete anything in it by
 * itself. Combined with (2), the worst outcome of losing the race is that the
 * service removes a directory entry in a directory whose contents the racer
 * already controls entirely. There is no path from that to a file outside it.
 */
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

/**
 * Bind one HTTP listener per configured socket path, sharing `handler`.
 *
 * A separate `http.Server` per path rather than one server listening twice,
 * because a Node server listens once. They share the request listener, so they
 * share every route, the transcript store and the SSE stream set — there is
 * one process and one view of the world, and which listener a request arrived
 * on is not consulted anywhere. See the note on `AgentRoot.socketPath` in
 * config.ts for what that means for what an agent can see.
 *
 * ── Failures here are warnings, and that is a considered choice ────────────
 *
 * Every failure path returns a `listening: false` outcome instead of throwing.
 * This looks like the "guard instead of visible failure" the house style is
 * against, and the reason it is not is that the alternative hands a container
 * a kill switch for a host service.
 *
 * The unit sets `Restart=always` with `StartLimitIntervalSec=0` — never give
 * up, no rate limit. If a socket that cannot be claimed were fatal, an agent
 * could run `touch /var/lib/hamachi/run/status.sock` and put clawcius-status
 * into a permanent restart loop: the page whose entire argument is that it
 * keeps working when the things it watches do not, taken down from inside the
 * thing it watches. The TCP listener is the primary and is unaffected by any
 * of this, so a socket that cannot be bound costs one crew's agents their
 * access to the page and nothing else.
 *
 * It is not silent, which is the part that matters. Every outcome is logged at
 * boot with the reason, and every outcome is reported on `/healthz` for as
 * long as the process runs — so "the socket is missing" is a question with an
 * answer rather than something to infer from a connection refused.
 */
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
    const outcome = await new Promise<SocketOutcome>((resolve) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        // EROFS is the one worth naming: ProtectSystem=strict makes the whole
        // filesystem read-only, and this directory needs a ReadWritePaths= line
        // in clawcius-status.service before a bind here can succeed.
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
        try {
          chmodSync(path, SOCKET_MODE);
        } catch (error) {
          // Listening but world-connectable to anyone who can traverse the
          // directory. Worth saying out loud; not worth refusing to serve.
          console.warn(
            `[status] could not chmod ${path} to ${SOCKET_MODE.toString(8)}: ` +
              `${(error as NodeJS.ErrnoException).code ?? error}`,
          );
        }
        resolve({ path, listening: true, server });
      });
    });
    outcomes.push(outcome);
  }

  return outcomes;
}

/**
 * Remove a socket file we created, on the way out.
 *
 * `server.close()` on a unix socket does unlink the path in Node, so this is
 * belt and braces for the paths where close does not run to completion. It is
 * as narrow as the claim logic: only a socket is ever removed, so a shutdown
 * racing an agent that replaced the file does not delete the replacement.
 */
export function releaseSocketPath(path: string): void {
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch {
    // ENOENT is the expected case — close() already did it.
  }
}
