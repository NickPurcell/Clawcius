/**
 * Creating a directory on the HOST and giving it to the account that has to
 * write it.
 *
 * This used to live in `spool.ts` next to `ensureSpoolDir`, which was the
 * careful one: a spool's parent was inside a bind mount, so the sandbox owned
 * the name and a root `mkdir -p` + `chown` there was an arbitrary-path root
 * chown (CWE-59). That function is gone with the spools, and this one is not
 * it. Everything here is `mkdir -p` and `chown` BY NAME, which is safe for
 * exactly one reason: nothing in a container owns any part of the paths it is
 * called with — the host agent's working directory and the three unit-desk
 * directories under it, all of them outside every mount in
 * `docker/run-container.sh`.
 *
 * DO NOT POINT THIS AT ANYTHING AN AGENT CAN WRITE. That sentence was the
 * whole of the distinction when the two functions were neighbours, and it is
 * the reason this one now sits in a file of its own rather than being read as
 * the relaxed version of a rule that no longer exists.
 *
 * The owner is passed in rather than discovered by `stat`. That is a
 * deliberate reversal of the rule the spool followed — "the owner is
 * discovered, never configured" — and it was the point of the 2026-08-11
 * rework: the session runs as a named service account that owns nothing on
 * this host to point at, and discovering its identity from the filesystem is
 * how it ended up running as the operator, who is in the docker group.
 */

import { chownSync, mkdirSync, statSync } from 'node:fs';

export function ensureDirOwnedBy(
  dir: string,
  want: { uid: number; gid: number },
  log: (line: string) => void,
  mode: number,
  why = '',
): void {
  let created = false;
  try {
    created = mkdirSync(dir, { recursive: true, mode }) !== undefined;
  } catch (error) {
    log(`cannot create ${dir}: ${String(error)} — the session will not be able to start`);
    return;
  }

  let have: { uid: number; gid: number };
  try {
    const current = statSync(dir);
    have = { uid: current.uid, gid: current.gid };
  } catch (error) {
    log(`cannot stat ${dir}: ${String(error)} — leaving it alone`);
    return;
  }

  if (want.uid === have.uid && want.gid === have.gid) {
    if (created) log(`created ${dir}, already owned ${have.uid}:${have.gid}`);
    return;
  }

  try {
    chownSync(dir, want.uid, want.gid);
    log(
      `chowned ${dir} to ${want.uid}:${want.gid} ${why} — it was ` +
        `${have.uid}:${have.gid}, which the process that has to write it cannot`,
    );
  } catch (error) {
    // Loud, and with the command in it, because the alternative symptom is a
    // session that cannot start, reported as a missing `claude` binary.
    log(
      `WARNING: ${dir} is owned ${have.uid}:${have.gid} but should be ` +
        `${want.uid}:${want.gid} ${why}, and chown failed (${String(error)}). Fix on the ` +
        `host with: chown ${want.uid}:${want.gid} ${dir} && chmod ` +
        `${(mode & 0o7777).toString(8).padStart(4, '0')} ${dir}`,
    );
  }
}
