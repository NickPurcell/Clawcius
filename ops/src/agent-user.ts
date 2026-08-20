/**
 * Who the host agent is, and the assertions that make that answer mean something.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE CHANGING ANYTHING IN THIS FILE. It is short, and every
 * check in it is load-bearing for a claim made elsewhere in this repository.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── The question the operator asked, 2026-08-11 ──────────────────────────
 *
 * "Can the outer agent be sandboxed?" The answer that came out of it is better
 * than a container and much cheaper: **give the agent its own user.**
 *
 * Until 2026-08-11 the host agent session ran as "whoever owns the checkout",
 * discovered by `stat`ing it. On this host that resolves to `npurcell` — the
 * operator. That was written up as a limitation and it was worse than a
 * limitation, because of one fact that made every other control in `ops/`
 * decorative:
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ `npurcell` is in the `docker` group.                               │
 *   │                                                                    │
 *   │ SETUP.md says so in the line that adds it: "docker group is        │
 *   │ effectively root on the host". `docker run -v /:/host …` is root   │
 *   │ with no sudo involved at all, in one command, with no audit and no │
 *   │ sudoers rule in the path.                                          │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * So the carefully-scoped command aliases in `ops/clawcius-sudoers` were not a
 * boundary, they were a description of the polite route. A sudoers rule granted
 * to a member of the docker group is not a rule. The journal in
 * `/var/lib/clawcius-ops`, 0750 and root-owned, was one `docker run -v` away
 * from being rewritten by the session it was recording.
 *
 * Running as a separate account with **no docker group** is what turns every
 * one of those from decoration into a control. That is the whole point of this
 * file, and it is why the check below is an assertion rather than a paragraph
 * in a README: a security property that can be silently undone by a convenience
 * `usermod -aG docker clawcius-ops` at 3am is not a property. It has to be
 * something the daemon refuses to run without, checked against the live
 * `/etc/group` every time, not something somebody remembers.
 *
 * ── Where these checks are enforced, and why not at boot ─────────────────
 *
 * `assertAgentIdentity` is called immediately before the session is spawned, in
 * `host-agent.ts`, in the same seat as `assertNoSecrets`. The executor calls
 * `agentProblems` before that and refuses the task with the reason; `index.ts`
 * calls it at boot and prints a banner. Three layers, and the innermost one is
 * the one that cannot be routed around.
 *
 * What deliberately does NOT happen is `process.exit(1)` at boot. That was the
 * first design and it is wrong here, for two reasons and the second is the one
 * that matters:
 *
 *   1. `clawcius-ops.service` is `Restart=always`, so a refused boot is not one
 *      loud failure, it is a root daemon in a restart loop. That is the exact
 *      shape of #7, and this repository has already agreed twice not to ship it
 *      again. (This clause used to add "with `StartLimitIntervalSec=0` and
 *      `StartLimitBurst=0` — never give up — because it holds the rollback
 *      deadlines", and "with every armed deadline unhonoured". Both went stale:
 *      nothing has armed a deadline since 2026-08-16, and the unit took a
 *      bounded start limit of 600s/20 on 2026-08-19 so that a loop it cannot
 *      avoid at least ends in `failed`. The verdict is unaffected — two minutes
 *      of looping followed by a dead unit is still worse than a daemon that
 *      stays up and names the account and the `gpasswd -d` to run.)
 *   2. **A boot-time check is evaluated once and is then stale for as long as
 *      the process lives**, which for this unit is weeks. The `usermod` this
 *      check exists to catch is precisely the thing somebody does to a *running*
 *      host during an incident. Checking before every spawn catches it at the
 *      next task; exiting at boot would not have caught it at all.
 *
 * The result is the same shape as `hostAgent.enabled: false`, which this
 * codebase already argues is strictly better than stopping the unit: the daemon
 * stays up, holds its deadlines, answers check-ins, performs rollbacks — and
 * refuses every task, loudly, with the `gpasswd -d` command in the message.
 *
 * ── Honest limits of what is checked here ────────────────────────────────
 *
 * `/etc/group` and `/etc/passwd` are read as files. A host using nsswitch with
 * LDAP, SSSD or systemd-userdb will not have its group memberships here, and
 * this file will happily conclude that a user in a remote `docker` group is
 * not. That is stated rather than papered over: on this host both databases are
 * files, `getent` is not shelled out to because shelling out from a root daemon
 * to answer a security question is its own problem, and a host that changes
 * that has to revisit this.
 *
 * The readability check below reasons about mode bits. It cannot see POSIX
 * ACLs, it cannot see a bind mount of the same inode somewhere friendlier, and
 * it cannot see a capability. It is a check against carelessness — a `.env` left
 * 0644, a home directory that was 0755 all along — and not against an adversary.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Where the user database lives, absent a config override. */
export const PASSWD_PATH = '/etc/passwd';
/** Where the group database lives, absent a config override. */
export const GROUP_PATH = '/etc/group';

/**
 * The account the host agent session runs as.
 *
 * `gids` is the FULL list — primary first, then every supplementary group —
 * because it is handed to `setgroups(2)` by the privilege-drop bootstrap in
 * host-agent.ts, in the child, immediately before it becomes the agent. Without
 * that call the session holds ONLY its primary group: libuv clears the
 * supplementary list in any child spawned with the `uid`/`gid` options, which
 * is #21.
 *
 * `gids` and `groups` are two renderings of the same fact and they are built on
 * adjacent lines below. Keep them that way. #21 cost an afternoon partly
 * because the log line printed `groups` (names, correct) while the thing that
 * mattered was `gids` (numbers, never observed). Anything handed to
 * `setgroups()` must be numbers: a STRING element is resolved as a group NAME.
 */
export type AgentUser = {
  /** Login name, exactly as written in ops-config.yaml and found in passwd. */
  user: string;
  uid: number;
  /** Primary gid. */
  gid: number;
  /** Becomes HOME, and is where Claude Code keeps this account's credentials. */
  home: string;
  /** Login shell, for the report only. A system account should have none. */
  shell: string;
  /** Every group name this user is in, primary first. Sorted after the first. */
  groups: string[];
  /**
   * Every gid, primary first. Numbers, never names — `process.setgroups()`
   * treats a string element as a group name to resolve through NSS.
   */
  gids: number[];
};

export type AgentUserResult =
  | { ok: true; user: AgentUser }
  | { ok: false; reason: string };

/**
 * Group names the agent user must not be in, and what each one grants.
 *
 * The map is a map rather than a list so the refusal can say *why* — a bare
 * "clawcius-ops is in adm" leaves the reader to guess whether that is serious,
 * and the answer is different for each of these.
 *
 * The first three are the reason this file exists. The rest are here because a
 * check that knows one name is a check that fails on the second one, which is
 * the same argument `assertNoSecrets` makes about credential-shaped variable
 * names. Naming a group that does not exist on this host costs nothing; missing
 * one costs the entire containment story.
 */
/**
 * The one group this account is meant to be IN.
 *
 * systemd's own group for reading the journal, and nothing else — it is not
 * `adm`, which also reads /var/log/auth.log where sudo records what this agent
 * did. See the warning in `agentWarnings` for why journal access moved here from
 * the sudoers file on 2026-08-12.
 */
export const JOURNAL_GROUP = 'systemd-journal';

export const ROOT_EQUIVALENT_GROUPS: Record<string, string> = {
  docker:
    'membership of `docker` is root. `docker run -v /:/host --privileged …` mounts the ' +
    'whole filesystem into a container the caller controls, with no sudo, no sudoers rule ' +
    'and no audit entry in the path. SETUP.md says so in the line that adds npurcell to it. ' +
    'This is the single membership that would void every other control in ops/.',
  podman:
    'the same capability as `docker` with a different daemon. Not installed here today, ' +
    'and named anyway because it is the obvious way for this hole to reappear on a rebuilt ' +
    'host.',
  lxd:
    'the LXD socket allows creating a privileged container with the host root filesystem ' +
    'attached, which is the docker hole with different words.',
  sudo:
    'the Debian/Ubuntu group whose default sudoers line is `%sudo ALL=(ALL:ALL) ALL`. The ' +
    'entire point of ops/clawcius-sudoers is that what this account may do with sudo is a ' +
    'short list somebody reviewed; this membership replaces that list with "everything".',
  wheel:
    'the RHEL/Arch/BSD spelling of `sudo`. This host is Debian, so it is the one that will ' +
    'not be noticed if the box is ever rebuilt somewhere else.',
  root:
    'group 0. Not as total as uid 0, but it is write access to whatever on this host is ' +
    'group-root-writable, and no legitimate reason exists for a service account to be in it.',
  disk:
    'read/write on raw block devices. That reads every file on the filesystem — including ' +
    '/home/npurcell/.ssh and every .env — straight past the mode bits this design relies on.',
  shadow:
    'read access to /etc/shadow, i.e. every password hash on the host, offline.',
  adm:
    'read access to every log on the box. This one is NOT root-equivalent and it is refused ' +
    'anyway, for one concrete reason: it reads /var/log/auth.log, which is where sudo records ' +
    'what this agent did. An account that can read the record of its own privileged commands ' +
    'is a small step from an account whose record nobody can trust.\n' +
    'Until 2026-08-12 this entry also said the membership "adds nothing", because journal ' +
    'access came from a `journalctl` grant in the sudoers file. That grant is gone — it ' +
    'permitted `--vacuum-time` and `--rotate`, i.e. destroying the journal, while being ' +
    'documented as read-only — and journal reading is now the `systemd-journal` group, which ' +
    'is the narrow one: it reads the journal and nothing else. `adm` is still refused; ' +
    '`systemd-journal` is what the account should have instead.',
};

/** Names allowed for the agent account. Deliberately narrower than useradd's. */
const USER_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

type PasswdEntry = { user: string; uid: number; gid: number; home: string; shell: string };
type GroupEntry = { name: string; gid: number; members: string[] };

/**
 * getpwnam, by hand.
 *
 * Node exposes `os.userInfo()` for the *current* user and nothing at all for an
 * arbitrary name, so the file is parsed. Fields are
 * `name:passwd:uid:gid:gecos:home:shell`; a line with fewer than seven of them
 * is not a passwd line and is skipped rather than guessed at.
 */
export function parsePasswd(text: string): PasswdEntry[] {
  const entries: PasswdEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length < 7) continue;
    const uid = Number(fields[2]);
    const gid = Number(fields[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) continue;
    const user = fields[0] ?? '';
    if (!user) continue;
    entries.push({ user, uid, gid, home: fields[5] ?? '', shell: fields[6] ?? '' });
  }
  return entries;
}

/**
 * getgrent, by hand. `name:passwd:gid:member,member,…`.
 *
 * An empty member list is normal and means "nobody has this as a supplementary
 * group" — which says nothing about who has it as their PRIMARY group, and
 * forgetting that is the classic way to write this check and have it miss.
 * `resolveAgentUser` below joins both.
 */
export function parseGroups(text: string): GroupEntry[] {
  const entries: GroupEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length < 3) continue;
    const gid = Number(fields[2]);
    if (!Number.isInteger(gid)) continue;
    const name = fields[0] ?? '';
    if (!name) continue;
    entries.push({
      name,
      gid,
      members: (fields[3] ?? '').split(',').map((m) => m.trim()).filter((m) => m.length > 0),
    });
  }
  return entries;
}

/**
 * Resolve the named service account, or say exactly why not.
 *
 * NOTE what this does not do: it does not fall back to anything. There is no
 * "if the user is missing, use the checkout's owner" path, and adding one would
 * quietly restore the pre-2026-08-11 behaviour on any host where the migration
 * had not been run — which is every host, until somebody runs it. A missing
 * user is a refusal with the `useradd` line in the message.
 */
export function resolveAgentUser(
  name: string,
  options: { passwdPath?: string; groupPath?: string } = {},
): AgentUserResult {
  const passwdPath = options.passwdPath ?? PASSWD_PATH;
  const groupPath = options.groupPath ?? GROUP_PATH;

  if (!USER_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason:
        `hostAgent.user ("${name}") is not a plausible account name (${String(USER_NAME_PATTERN)}). ` +
        'Refusing to look it up rather than reporting a confusing "no such user".',
    };
  }

  let passwdText: string;
  try {
    passwdText = readFileSync(passwdPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason:
        `cannot read ${passwdPath} to resolve the host agent's account "${name}": ` +
        `${String(error)}. Refusing to start a session with a shell as anybody else — ` +
        'in particular, refusing to fall back to root.',
    };
  }

  const entry = parsePasswd(passwdText).find((candidate) => candidate.user === name);
  if (!entry) {
    return {
      ok: false,
      reason:
        `there is no user "${name}" in ${passwdPath}, so the host agent has nobody to run ` +
        'as. It is NOT run as root, and it is NOT run as whoever owns the checkout — that ' +
        'was the behaviour until 2026-08-11 and it resolved to the operator, who is in the ' +
        'docker group, which made every other control in ops/ decoration. Create the ' +
        'account (see MIGRATION.md § 1):\n' +
        '    sudo useradd --system --create-home --home-dir /var/lib/clawcius-agent \\\n' +
        `      --shell /usr/sbin/nologin --comment "Clawcius host agent" ${name}\n` +
        '    # NOTE the home directory. It must NOT be /var/lib/clawcius-ops: that is the\n' +
        '    # executor\'s StateDirectory, 0750 root-owned, holding the journal, the circuit\n' +
        '    # breaker and the armed rollback deadlines. Giving the agent account a home\n' +
        '    # there would hand the quarantined party the breaker.\n' +
        'then check it is not in any root-equivalent group with: ' +
        `id ${name}`,
    };
  }

  if (entry.uid === 0) {
    return {
      ok: false,
      reason:
        `hostAgent.user "${name}" has uid 0. The entire point of naming an account here is ` +
        'that the session is NOT root: a session with a shell running as root is the ' +
        '2026-08-09 root-owned-node_modules failure multiplied by everything it chooses to ' +
        'run, and it makes the sudoers file, the audit and the state directory meaningless ' +
        'at once. Refusing.',
    };
  }

  let groups: GroupEntry[] = [];
  try {
    groups = parseGroups(readFileSync(groupPath, 'utf8'));
  } catch (error) {
    // Fatal, not tolerated. Without the group file the docker-group assertion
    // — the reason this whole rework exists — cannot be evaluated, and a check
    // that fails open is worse than no check because it reads as a pass.
    return {
      ok: false,
      reason:
        `cannot read ${groupPath}, so the host agent's group memberships cannot be ` +
        `checked: ${String(error)}. The refusal to run an account that is in the docker ` +
        'group is the assertion the rest of this design rests on, and it must not fail ' +
        'open — a check that cannot be evaluated is reported as a refusal, not as a pass.',
    };
  }

  const primary = groups.find((group) => group.gid === entry.gid);
  const supplementary = groups.filter(
    (group) => group.gid !== entry.gid && group.members.includes(name),
  );

  return {
    ok: true,
    user: {
      user: entry.user,
      uid: entry.uid,
      gid: entry.gid,
      home: entry.home,
      shell: entry.shell,
      groups: [
        // Primary first even when it has no /etc/group entry, so the report
        // never silently omits the group the process actually runs with.
        primary ? primary.name : `(gid ${entry.gid}, no /etc/group entry)`,
        ...supplementary.map((group) => group.name).sort(),
      ],
      gids: [entry.gid, ...supplementary.map((group) => group.gid)],
    },
  };
}

/**
 * Which forbidden groups is this account in? Empty means it is contained.
 *
 * `extra` comes from `hostAgent.forbiddenGroups` and is a UNION with the
 * built-in map, never a replacement. That asymmetry is deliberate and it is the
 * same argument as `envPassthrough` in reverse: a config key that can *widen* a
 * security property is a key somebody widens at 3am, so this one can only
 * narrow. If a group genuinely has to come off the list, that is a diff in this
 * file that somebody reviews.
 */
export function forbiddenGroupsFor(user: AgentUser, extra: readonly string[] = []): string[] {
  const forbidden = new Set([...Object.keys(ROOT_EQUIVALENT_GROUPS), ...extra]);
  return user.groups.filter((group) => forbidden.has(group));
}

/**
 * Can `user` read `path`, judged from mode bits?
 *
 * Walks the ancestor directories checking the execute bit before checking read
 * on the target, because that is how the kernel does it and because it is the
 * difference between a correct answer and a scary one: `~/.ssh/id_ed25519` is
 * usually 0600 inside a 0700 directory, and a check that only looked at the
 * file would be right by accident while a check that only looked at the
 * directory would be wrong about every 0644 file underneath a 0700 home.
 *
 * Returns `{ readable, why }` — `why` names the component that decided it, so a
 * refusal can tell the operator which `chmod` to run.
 */
export function canReadPath(
  path: string,
  user: AgentUser,
  stat: (p: string) => { uid: number; gid: number; mode: number } = statSync,
): { readable: boolean; why: string } {
  const target = resolve(path);

  const ancestors: string[] = [];
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    ancestors.unshift(dir);
    if (dir === dirname(dir)) break;
  }

  for (const dir of ancestors) {
    let info: { uid: number; gid: number; mode: number };
    try {
      info = stat(dir);
    } catch {
      // A component that cannot be stat'ed cannot be traversed either, so the
      // target is unreachable. Reported as not-readable, with the reason, so a
      // typo in a configured secret path does not read as "safe".
      return { readable: false, why: `${dir} could not be stat'ed` };
    }
    if (!permits(info, user, 1)) {
      return { readable: false, why: `${dir} is not traversable by ${user.user} (${modeOf(info)})` };
    }
  }

  let info: { uid: number; gid: number; mode: number };
  try {
    info = stat(target);
  } catch (error) {
    return { readable: false, why: `${target} could not be stat'ed: ${String(error)}` };
  }
  if (!permits(info, user, 4)) {
    return { readable: false, why: `${target} is not readable by ${user.user} (${modeOf(info)})` };
  }
  return { readable: true, why: `${target} is readable by ${user.user} (${modeOf(info)})` };
}

/** Can `user` write `path`? Same walk, write bit on the target. */
export function canWritePath(
  path: string,
  user: AgentUser,
  stat: (p: string) => { uid: number; gid: number; mode: number } = statSync,
): { writable: boolean; why: string } {
  const readable = canReadPath(path, user, stat);
  if (!readable.readable && !readable.why.includes('is not readable by')) {
    return { writable: false, why: readable.why };
  }
  let info: { uid: number; gid: number; mode: number };
  try {
    info = stat(resolve(path));
  } catch (error) {
    return { writable: false, why: `${path} could not be stat'ed: ${String(error)}` };
  }
  if (!permits(info, user, 2)) {
    return { writable: false, why: `${path} is not writable by ${user.user} (${modeOf(info)})` };
  }
  return { writable: true, why: `${path} is writable by ${user.user} (${modeOf(info)})` };
}

/**
 * The classic three-way permission test, written out because getting it subtly
 * wrong is easy: when the uid matches, ONLY the owner bits apply. There is no
 * fall-through to the group bits for the owner, so a 0060 file is unreadable by
 * its own owner and readable by the group, and a check that OR'd the three
 * classes together would be wrong in the direction that matters.
 */
function permits(
  info: { uid: number; gid: number; mode: number },
  user: AgentUser,
  bit: 1 | 2 | 4,
): boolean {
  if (user.uid === 0) return true;
  if (info.uid === user.uid) return (info.mode & (bit << 6)) !== 0;
  if (user.gids.includes(info.gid)) return (info.mode & (bit << 3)) !== 0;
  return (info.mode & bit) !== 0;
}

function modeOf(info: { uid: number; gid: number; mode: number }): string {
  return `${(info.mode & 0o7777).toString(8).padStart(4, '0')} uid ${info.uid} gid ${info.gid}`;
}

export type IdentityOptions = {
  /** Extra group names to refuse on, unioned with the built-in list. */
  forbiddenGroups: readonly string[];
  /**
   * Files and directories the agent user must NOT be able to read.
   *
   * On this host: `/home/npurcell/clawcius/.env*`, `/home/npurcell/.claude`,
   * `/home/npurcell/.ssh`. Every instance's `envFile` is added automatically by
   * the caller, because those hold `DISCORD_TOKEN` and a session that can read
   * one has defeated the loudest assertion in `host-agent.ts` without ever
   * putting a variable in its environment.
   */
  secretPaths: readonly string[];
  /** Checkouts the session has to be able to write. Warnings only. */
  writablePaths?: readonly string[];
  /**
   * The executor's state directory — journal, breaker, armed deadlines.
   *
   * Warned about rather than refused, and the reason is a legitimate
   * configuration rather than a compromise: on a host where the executor is
   * not root (development, or somebody's deliberate choice), the executor and
   * the session are the same account and this directory is necessarily
   * writable by it. Refusing there would make non-root operation impossible.
   * On a properly deployed host it is 0750 root-owned and this never fires;
   * if it does fire there, the session can edit the breaker that quarantined
   * it and the audit log that recorded it, and the warning says so.
   */
  stateDir?: string;
  /** An ssh key the session uses for private pulls. Warnings only. */
  gitSshKey?: string;
  stat?: (p: string) => { uid: number; gid: number; mode: number };
};

/**
 * Everything wrong with this identity that must stop a session from starting.
 *
 * Returns prose, one entry per problem, empty when the account is what this
 * design says it is. Split from the warnings below on one rule: a PROBLEM is
 * something that makes a claim in ops/README.md false. A WARNING is something
 * that will waste an evening.
 */
export function agentProblems(user: AgentUser, options: IdentityOptions): string[] {
  const problems: string[] = [];

  for (const group of forbiddenGroupsFor(user, options.forbiddenGroups)) {
    const why =
      ROOT_EQUIVALENT_GROUPS[group] ??
      'named in hostAgent.forbiddenGroups by the operator, who had a reason.';
    problems.push(
      `${user.user} is in the "${group}" group, and the host agent will not run as an ` +
        `account that is. ${why}\n` +
        `    Remove it and the executor will accept tasks again at once:\n` +
        `        sudo gpasswd -d ${user.user} ${group}\n` +
        '    (Then confirm with `id ' + user.user + '`. No restart of clawcius-ops is ' +
        'needed — this is checked before every task, on purpose, because the membership ' +
        'this exists to catch is one somebody adds to a running host during an incident.)',
    );
  }

  for (const path of options.secretPaths) {
    const verdict = canReadPath(path, user, options.stat);
    if (!verdict.readable) continue;
    problems.push(
      `${user.user} can read ${path}, which is configured as a secret this account must ` +
        `not see (${verdict.why}). The entire reason the host agent has its own account is ` +
        'that a session with a shell must not hold the operator\'s credentials — and ' +
        'host-agent.ts asserting that DISCORD_TOKEN is not in its ENVIRONMENT means nothing ' +
        'if the token is in a file it can `cat`.\n' +
        '    Fix on the host, then refile the task:\n' +
        `        sudo chmod go-rwx ${path}\n` +
        '    If this path is listed by mistake, remove it from hostAgent.secretPaths (or ' +
        'from instances[].envFile, which is checked automatically) in ops-config.yaml.',
    );
  }

  return problems;
}

/** Things that are not a refusal but will cost somebody an evening. */
export function agentWarnings(user: AgentUser, options: IdentityOptions): string[] {
  const warnings: string[] = [];

  // ── The one membership this account is supposed to HAVE ─────────────────
  //
  // Added 2026-08-12, when `journalctl` was removed from ops/clawcius-sudoers.
  // That grant was `journalctl *`, documented as "read-only, any unit", and `*`
  // also carries `--vacuum-time=1s`, `--rotate`, `--flush` and
  // `--relinquish-var` — every one of which mutates or destroys the host
  // journal, as root, in one command. No sudoers pattern can restrict it:
  // journalctl's own getopt permutes, so a `*` anywhere in the argument spec
  // re-admits the destructive flags. So the grant is gone and journal reading is
  // group membership instead, which is the correct mechanism and needs no sudo
  // at all.
  //
  // A WARNING and not a refusal, deliberately. The failure it describes is "the
  // agent cannot read the journal", which is annoying and visible; refusing to
  // run tasks over it would mean a missing `usermod` takes the whole ops
  // mechanism offline, and the operator would fix that by putting the sudo rule
  // back. It nags on every task until somebody runs one command.
  if (!user.groups.includes(JOURNAL_GROUP)) {
    warnings.push(
      `${user.user} is not in the \`${JOURNAL_GROUP}\` group, so it cannot read the system ` +
        'journal. Reading `journalctl -u <unit>` was the pain point this whole service was ' +
        'built for, and since 2026-08-12 it is NOT granted through sudo — the old ' +
        '`journalctl *` rule also permitted `--vacuum-time=1s` and `--rotate`, which erase ' +
        'the audit trail as root while the comment above the rule called it read-only. The ' +
        'group is the read-only mechanism and it is one command:\n' +
        `        sudo usermod -aG ${JOURNAL_GROUP} ${user.user} && sudo systemctl restart clawcius-ops`,
    );
  }

  if (user.shell && !/(nologin|false)$/.test(user.shell)) {
    warnings.push(
      `${user.user} has a login shell (${user.shell}). A service account does not need one, ` +
        'and `--shell /usr/sbin/nologin` removes one way in that nobody is watching. Not ' +
        'refused: the session does not use the account\'s shell (it is spawned with an ' +
        'explicit argv and SHELL=/bin/bash in its own environment), so this is hygiene ' +
        'rather than containment.',
    );
  }

  for (const path of options.writablePaths ?? []) {
    const verdict = canWritePath(path, user, options.stat);
    if (verdict.writable) continue;
    warnings.push(
      `${user.user} cannot write ${path} (${verdict.why}). Every task that pulls, runs ` +
        '`npm ci`, or builds `dist/` will fail there — with an EACCES naming a file nobody ' +
        'edited, which is the 2026-08-09 failure with the users swapped. The shared-group ' +
        'setup in MIGRATION.md § 2 is what fixes it:\n' +
        `        sudo chgrp -R clawcius-dev ${path} && sudo chmod -R g+rwX ${path}\n` +
        `        sudo find ${path} -type d -exec chmod g+s {} +`,
    );
  }

  if (options.stateDir) {
    const verdict = canWritePath(options.stateDir, user, options.stat);
    if (verdict.writable) {
      warnings.push(
        `${user.user} can write the executor's state directory ${options.stateDir} ` +
          `(${verdict.why}). That directory holds journal.jsonl, the circuit breaker and ` +
          'every armed rollback deadline. A breaker the quarantined party can edit is not a ' +
          'breaker, and an audit log the audited session can rewrite is not evidence. On a ' +
          'deployed host it is 0750 root-owned and this cannot happen; if you are seeing it ' +
          'there, fix it before the next task:\n' +
          `        sudo chown root:root ${options.stateDir} && sudo chmod 0750 ${options.stateDir}`,
      );
    }
    if (user.home && (user.home === options.stateDir || user.home.startsWith(`${options.stateDir}/`))) {
      warnings.push(
        `${user.user}'s home directory (${user.home}) is inside the executor's state ` +
          `directory (${options.stateDir}). Those must not be the same tree — the account's ` +
          'home is where Claude Code writes its credentials and session state, and the state ' +
          'directory is where the breaker and the audit live. Give the account a home of its ' +
          'own (/var/lib/clawcius-agent) with `usermod -d /var/lib/clawcius-agent -m`.',
      );
    }
  }

  if (options.gitSshKey) {
    let info: { uid: number; gid: number; mode: number } | null = null;
    try {
      info = (options.stat ?? statSync)(options.gitSshKey);
    } catch (error) {
      warnings.push(
        `hostAgent.gitSshKey (${options.gitSshKey}) cannot be stat'ed: ${String(error)}. ` +
          'Private-repo pulls will fail with a permission-denied from GitHub that reads ' +
          'like a repository-access problem. See MIGRATION.md § 5.',
      );
    }
    if (info) {
      if (info.uid !== user.uid) {
        warnings.push(
          `hostAgent.gitSshKey (${options.gitSshKey}) is owned by uid ${info.uid}, not by ` +
            `${user.user} (uid ${user.uid}). A deploy key the agent uses should be the ` +
            "agent's own — the point of it is not to share the operator's credential — and " +
            'ssh refuses keys it considers group- or world-accessible anyway.',
        );
      }
      if ((info.mode & 0o077) !== 0) {
        warnings.push(
          `hostAgent.gitSshKey (${options.gitSshKey}) is mode ` +
            `${(info.mode & 0o7777).toString(8).padStart(4, '0')}. ssh refuses to use a ` +
            'private key that is accessible by group or other, so every private pull will ' +
            'fail. `chmod 0600` it.',
        );
      }
    }
  }

  return warnings;
}

export class HostAgentIdentityError extends Error {}

/**
 * The gate immediately before the spawn. Throws rather than returning.
 *
 * Exported, pure over its inputs, and called from `runHostAgent` in the same
 * seat `assertNoSecrets` occupies — for the same reason it is a throw and not a
 * filter. A warning that "the session we just started is in the docker group"
 * in a log nobody reads at 3am is not a control; refusing to start it is.
 *
 * The executor checks the same thing earlier and produces a better-worded
 * refusal for the agent that filed the task. This one exists so that there is
 * no code path in `ops/` — including one somebody adds later — that reaches
 * `spawn` without it.
 */
export function assertAgentIdentity(user: AgentUser, options: IdentityOptions): void {
  const problems = agentProblems(user, options);
  if (problems.length === 0) return;
  throw new HostAgentIdentityError(
    `refusing to start the host agent as ${user.user} (uid ${user.uid}):\n\n` +
      problems.map((problem) => `  * ${problem}`).join('\n\n') +
      '\n\nSince 2026-08-11 the containment story for this service is "it runs as an ' +
      'unprivileged account of its own". Everything else — the sudoers scoping, the ' +
      'root-owned journal, the claim that it holds no Discord token — is downstream of that ' +
      'one fact, and none of it survives the account being root-equivalent. See ' +
      'ops/src/agent-user.ts.',
  );
}

/** A line for the boot banner and the journal. Never a security decision. */
export function describeAgentUser(user: AgentUser): string {
  return (
    `${user.user} (uid ${user.uid}, gid ${user.gid}), home ${user.home || '(none)'}, ` +
    `shell ${user.shell || '(none)'}, groups: ${user.groups.join(', ') || '(none)'}`
  );
}

/** Absolute-path guard shared by the config loader's new keys. */
export function requireAbsolute(path: string, what: string): string {
  if (!isAbsolute(path)) throw new Error(`${what} must be an absolute path, got "${path}"`);
  return resolve(path);
}
