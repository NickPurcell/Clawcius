# MIGRATION — giving the host agent its own user

**2026-08-11.** This is the exact sequence for taking this host from *"the host
agent session runs as `npurcell`"* to *"the host agent session runs as
`clawcius-ops`, an unprivileged system account that cannot become root"*.

Read [§ 0](#0-why) first. Then run the steps in order — several of them are
useless or actively confusing out of order — and **run the verification after
each one**, because every step here has a failure mode that is silent until the
next one, and one that is silent until the next incident.

> ### Honesty about what has been run
>
> **None of it.** Not one command in this document has been executed on the
> host. It was written on a machine with no `sudo`, no `docker`, no `systemd`
> and no `clawcius-ops` account. The code paths that read `/etc/passwd` and
> `/etc/group` are covered by `ops/`'s self-test against fixture files, which
> is a genuine test of the parsing and the refusals and is not a test of
> anything below.
>
> Specifically never executed: `useradd`, `groupadd`, `usermod`, the `chgrp`/
> `chmod`/`find` on the checkout, `visudo -c` on `ops/clawcius-sudoers`,
> `claude` as another user, `ssh-keygen` for a deploy key, and `git pull` as
> `clawcius-ops` in a tree owned by `npurcell`. Do them from a shell that
> already holds root, and read § 9 before you start in case you have to undo
> one.

---

## 0. Why

On 2026-08-11 the operator asked whether the outer agent could be sandboxed.
The answer that came out of it is cheaper than a container and stronger: give
the agent its own user.

The decisive fact is one line in this repository's own `SETUP.md`:

```sh
sudo usermod -aG docker npurcell     # docker group is effectively root on the host
```

`npurcell` is in the `docker` group. `docker run -v /:/host alpine chroot /host
sh` is a root shell, in one command, with no `sudo` and no audit entry in the
path. Until today the host agent session ran as `npurcell` — it was dropped to
"whoever owns the checkout", discovered by `stat` — so:

- the scoped command aliases in `ops/clawcius-sudoers` were not a boundary,
  they were a description of the polite route;
- `/var/lib/clawcius-ops/journal.jsonl` — the audit log that replaced the verb
  allowlist, 0750 and root-owned — was one `docker run -v` away from being
  rewritten by the session it was recording;
- the session could read `.env`, `~/.claude` and `~/.ssh`, because it *was* the
  operator. `host-agent.ts` refusing to put `DISCORD_TOKEN` in its environment
  bought nothing: the token was in a file it could `cat`.

Running as a separate account with no `docker` group is what turns each of
those from decoration into a control. Everything else in `ops/` is downstream
of it.

**The daemon will not do any of this for you, and it will not proceed without
it.** Until § 1 is done, `clawcius-ops.service` boots, holds its rollback
deadlines, answers check-ins, performs rollbacks — and refuses every task with
the reason and the fix. It does not fall back to the checkout's owner and it
does not fall back to root.

---

## 1. Create the account

A **system** account: no password, no login shell, and a home of its own.

```sh
sudo useradd \
  --system \
  --create-home \
  --home-dir /var/lib/clawcius-agent \
  --shell /usr/sbin/nologin \
  --comment "Clawcius host agent" \
  clawcius-ops
```

**The home directory matters and it is easy to get wrong.** It must **not** be
`/var/lib/clawcius-ops`: that is `clawcius-ops.service`'s `StateDirectory`,
0750 and root-owned, holding `journal.jsonl`, the circuit breaker and every
armed rollback deadline. An account whose home is there owns the breaker that
quarantines it and the audit that records it. The unit name and the account
name being the same string is a genuine trap; `/var/lib/clawcius-agent` is
deliberately a different path.

There is no `--groups` argument, on purpose. The account starts in exactly one
group — its own — and § 2 adds exactly one more.

### Verify

```sh
id clawcius-ops
# uid=999(clawcius-ops) gid=999(clawcius-ops) groups=999(clawcius-ops)
getent passwd clawcius-ops
# clawcius-ops:x:999:999:Clawcius host agent:/var/lib/clawcius-agent:/usr/sbin/nologin
ls -ld /var/lib/clawcius-agent
```

The `groups=` list must contain **only** the account's own group. If `docker`,
`sudo`, `wheel`, `adm`, `disk`, `shadow`, `root`, `lxd` or `podman` appears
there, the executor will refuse every task and tell you which one.

### If you skip this step

Every task is refused with `there is no user "clawcius-ops" in /etc/passwd`,
and the boot journal carries the `useradd` line above. Nothing runs as anybody
else — that is the point of the refusal.

---

## 2. The shared group, and the checkout

The agent has to write the checkout: `git pull` writes `.git/`, `npm ci` writes
`node_modules/`, `npm run build` writes `dist/`. It must **not** be able to read
the operator's secrets. Those two are only compatible through a group.

```sh
# A group both accounts are in.
sudo groupadd --system clawcius-dev
sudo usermod -aG clawcius-dev npurcell
sudo usermod -aG clawcius-dev clawcius-ops

# The checkout: group ownership, group write, and setgid on directories so
# that anything created later inherits the group instead of the creator's.
sudo chgrp -R clawcius-dev /home/npurcell/clawcius
sudo chmod -R g+rwX        /home/npurcell/clawcius
sudo find /home/npurcell/clawcius -type d -exec chmod g+s {} +

# The traversal. /home/npurcell is typically 0750 npurcell:npurcell, which the
# agent cannot enter — so the checkout inside it is unreachable regardless of
# its own mode. This grants ENTRY, not listing.
sudo chmod o+x /home/npurcell
```

`g+rwX` — capital X — sets the execute bit on directories and on files that are
already executable, and leaves ordinary files alone. Lowercase `g+rwx` would
make every source file executable.

### Then take the secrets back out of the group

`chgrp -R` above swept up the `.env` files. They are 0600, so the group has no
access either way, but do not rely on a mode staying right by accident:

```sh
sudo chgrp npurcell /home/npurcell/clawcius/.env /home/npurcell/clawcius/.env.hamachi
sudo chmod 0600     /home/npurcell/clawcius/.env /home/npurcell/clawcius/.env.hamachi
sudo chmod -R go-rwx /home/npurcell/.claude /home/npurcell/.ssh
```

### git will refuse the checkout until you tell it not to

This one will cost an evening if it is not done here. `git` refuses to operate
in a repository owned by another user:

```
fatal: detected dubious ownership in repository at '/home/npurcell/clawcius'
```

The checkout is owned by `npurcell`; the agent is `clawcius-ops`. Every `git`
command a task runs fails with that message until:

```sh
sudo -u clawcius-ops git config --global --add safe.directory /home/npurcell/clawcius
```

(Per-account, deliberately, rather than `git config --system`: it says *this
account trusts this one tree*, which is exactly the claim being made.)

### Verify

```sh
# Both accounts are in the group.
id npurcell | grep clawcius-dev
id clawcius-ops | grep clawcius-dev

# The agent can write the checkout...
sudo -u clawcius-ops touch /home/npurcell/clawcius/.migration-probe && \
  ls -l /home/npurcell/clawcius/.migration-probe && \
  rm /home/npurcell/clawcius/.migration-probe
# The file should be group clawcius-dev, not group clawcius-ops — that is the
# setgid bit working. If it is group clawcius-ops, `chmod g+s` did not take.

# ...and cannot read the secrets. Every one of these must FAIL.
sudo -u clawcius-ops cat /home/npurcell/clawcius/.env          # Permission denied
sudo -u clawcius-ops cat /home/npurcell/clawcius/.env.hamachi  # Permission denied
sudo -u clawcius-ops ls  /home/npurcell/.claude                # Permission denied
sudo -u clawcius-ops ls  /home/npurcell/.ssh                   # Permission denied

# And git is happy.
sudo -u clawcius-ops git -C /home/npurcell/clawcius status --porcelain
```

> **Group membership is not retroactive.** `usermod -aG` changes the database,
> not the group list of any process that is already running. `npurcell`'s
> existing shells, and every service already started as `npurcell`
> (`clawcius.service`, `hamachi.service`, `clawcius-status.service`), keep
> their old groups until they are restarted. `sudo -u clawcius-ops` starts a
> fresh process and picks up the new list, which is why the checks above work
> immediately while your own shell may not. Log out and back in, or use `newgrp
> clawcius-dev`.

### If you skip this step

Every task that builds anything fails several minutes in with an `EACCES`
naming a file nobody edited — the 2026-08-09 failure with the users swapped.
The executor warns about it at boot and before every task, with the `chgrp` to
run, but it does **not** refuse: a `chmod` nobody noticed should not take the
whole ops mechanism offline, and this failure is loud on its own.

Skipping the *secrets* half is different and it **does** refuse: the executor
checks `hostAgent.secretPaths` and every instance's `envFile` before each task
and will not start a session that can read one.

---

## 3. The sudoers file

`ops/clawcius-sudoers` was rewritten for this account: it grants to
`clawcius-ops` rather than `npurcell`, and every wildcard is gone — units are
named one by one, `docker run` is not granted at all, and `clawcius-ops.service`
is deliberately absent from the restartable list.

> **Changed again on 2026-08-12, after an adversarial audit of that file.**
> Three grants were deleted outright and one was narrowed:
>
> - `install` and `rm -f` against `/etc/systemd/system`. The `*` between the
>   pinned flags and the destination absorbed further `install` flags, which GNU
>   install applies last-wins, so `-t /etc/sudoers.d` redirected the write:
>   full root, one command. Unit installs are now done by the executor
>   (`ops/src/units.ts`) and need no sudo rule at all.
> - `journalctl`. It also permitted `--vacuum-time`/`--rotate`, i.e. destroying
>   the journal. **This one needs an action from you — see § 3a below.**
> - `docker inspect *` → enumerated `--format` invocations. The wildcard printed
>   `Config.Env`, which is the other agents' API keys.
>
> If you are re-installing the file over a version from 2026-08-11, nothing else
> about the procedure changes.

**Check it parses before you install it, from a second shell that already holds
root.** A syntax error in one file under `/etc/sudoers.d` breaks `sudo` for
everybody, including the shell you would use to fix it.

```sh
# Terminal 1: keep a root shell open and DO NOT CLOSE IT until step 3 verifies.
sudo -i

# Terminal 2:
sudo visudo -c -f /home/npurcell/clawcius/ops/clawcius-sudoers
# /home/npurcell/clawcius/ops/clawcius-sudoers: parsed OK

sudo install -m 0440 -o root -g root \
  /home/npurcell/clawcius/ops/clawcius-sudoers \
  /etc/sudoers.d/clawcius

sudo visudo -c            # re-check the WHOLE set, not just the new file
```

The old file, if it is installed, is at the same path and is replaced by the
`install`. If it was installed under a different name, remove it — leaving a
rule granting these commands to `npurcell` behind does no harm (`npurcell` can
already do all of it and more) but it is misleading, and the point of the
rewrite is that this file describes reality.

### Verify

```sh
# What the account may do, from sudo's own mouth.
#
# NOT `sudo -u clawcius-ops sudo -l`. The inner sudo authenticates the user it
# is invoked AS, so that prompts for clawcius-ops's password — and a --system
# account has a locked password, so the prompt can never be satisfied. Ask
# about the account instead of asking as it:
sudo -l -U clawcius-ops

# A granted read-only command works, with no password.
sudo -u clawcius-ops sudo -n /usr/bin/systemctl is-active clawcius.service

# A granted mutating command is listed (do not run it yet).
sudo -l -U clawcius-ops /usr/bin/systemctl restart clawcius.service

# And these must all be REFUSED.
sudo -u clawcius-ops sudo -n /usr/bin/systemctl restart sshd.service        # no
sudo -u clawcius-ops sudo -n /usr/bin/systemctl restart docker.service      # no
sudo -u clawcius-ops sudo -n /usr/bin/systemctl restart clawcius-ops.service # no
sudo -u clawcius-ops sudo -n /bin/sh -c id                                  # no
sudo -u clawcius-ops sudo -n /usr/bin/docker run --rm -v /:/host alpine ls  # no

# The one that matters most, and it needs no sudo at all:
sudo -u clawcius-ops docker ps
# permission denied ... /var/run/docker.sock — because the account is not in
# the docker group. If this SUCCEEDS, stop and go back to § 1.
```

### If you skip this step

Every privileged command inside a task fails with a password prompt that
nothing can answer, and the session hangs on it until the task timeout rather
than failing in a second. It reads like a broken sudoers file, which is what it
is.

**Watch for the unit-name shorthand.** `systemctl restart clawcius` and
`systemctl restart clawcius.service` are the same thing to systemd and
different strings to sudo, and only the second is granted. A refusal on a unit
you are certain is in the list is almost always this.

---

## 3a. The `systemd-journal` group — NEW on 2026-08-12

Reading `journalctl -u <unit>` was the pain point this whole service exists to
remove, and as of 2026-08-12 it is **not** a sudo grant. The old rule was
`journalctl *`, described in the file as "read-only, any unit". It was not:
`--vacuum-time=1s`, `--vacuum-size=1`, `--rotate`, `--flush` and
`--relinquish-var` all mutate or destroy the host's log history, as root, in one
command — and journalctl's own option parsing permutes, so no `*` anywhere in a
sudoers pattern could have excluded them.

The replacement is the group systemd provides for exactly this:

```sh
sudo usermod -aG systemd-journal clawcius-ops
sudo systemctl restart clawcius-ops     # memberships are read at process start
```

### Verify

```sh
# Reading works, with NO sudo:
sudo -u clawcius-ops journalctl -u clawcius.service -n 5 --no-pager

# Writing does not, with or without:
sudo -u clawcius-ops journalctl --vacuum-time=1s          # refused
sudo -u clawcius-ops sudo -n /usr/bin/journalctl -n 1     # refused: no such rule
```

### If you skip this step

Nothing breaks and nothing is unsafe — the agent simply cannot read the journal,
which is the single most useful thing it does. It will show up as a warning on
**every** task, in the journal and in `ops-status.json`, naming the one command
above; `ops/src/agent-user.ts` emits it. It is a warning rather than a refusal on
purpose: a missing `usermod` must not take the ops mechanism offline, because the
way that gets fixed at 3am is by putting the `journalctl *` rule back.

**Do not use `adm` instead.** It also reads `/var/log/auth.log`, which is where
sudo records what this account did, and it stays on the refused-groups list —
the executor will refuse to start a session as a member of it.

---

## 4. `claude auth` as the new account

The session authenticates with Claude Code's OAuth credentials found under
`$HOME`, and `$HOME` is now `/var/lib/clawcius-agent`. **This is a second,
separate login.** The operator's own `claude` login under `/home/npurcell` is
not used, not readable, and not shared — which is the point, and which also
means this step cannot be skipped.

First make sure the account can actually reach `claude`. The rest of this
project refers to `/usr/local/bin/claude`, which is where it lives in the agent
containers — on a host it is usually a per-user install under `~/.local/bin`,
which is a directory this account is deliberately unable to read.

```sh
sudo -u clawcius-ops "$(command -v claude)" --version
```

If that prints a version, the operator's home is traversable and a symlink
makes every other reference true:

```sh
sudo ln -sf "$(command -v claude)" /usr/local/bin/claude
```

If it says permission denied, do NOT loosen the home directory to fix it —
"the agent cannot read /home/<operator>" is verified in § 2 and worth keeping.
Install `claude` system-wide instead, or point `hostAgent.claudePath` at a copy
the account can execute.

Discovered on 2026-08-12: this guide and `ops-config.yaml` both hardcoded
`/usr/local/bin/claude`, which was true of the container the guide was written
in and false of the host it was written for. The same wrong assumption had
already cost a spawn failure in the sibling OJ project a day earlier.

```sh
sudo -u clawcius-ops -H /usr/local/bin/claude
# then /login inside the session, and follow the flow it prints.
```

`-H` sets `$HOME` to the target account's. Without it `sudo` keeps the calling
user's `HOME` and the credentials land in `/home/npurcell` — where the session
will never look, and where they would be a credential the agent account cannot
read anyway.

The account has `/usr/sbin/nologin` as its shell and that is fine: `sudo -u`
executes the named binary directly and does not need the target's shell. Do not
give the account a shell to make this easier.

If the interactive flow is impractical over ssh, `claude setup-token` as the
same account is the alternative. Whatever it writes stays under
`/var/lib/clawcius-agent` and belongs to that account.

### Verify

```sh
sudo -u clawcius-ops -H /usr/local/bin/claude -p 'reply with the single word: ok'
# ok

sudo ls -la /var/lib/clawcius-agent/.claude
# owned clawcius-ops:clawcius-ops

# And confirm the operator's login is NOT what is being used:
sudo -u clawcius-ops ls /home/npurcell/.claude   # Permission denied
```

### If you skip this step

Every task fails to authenticate, on a host where `claude` works perfectly from
the operator's shell. The error will be about credentials, not about accounts,
and the natural instinct — "but `claude` works fine, look" — sends you to the
wrong place. Check `sudo -u clawcius-ops -H claude -p ok` before anything else.

---

## 5. The deploy key, for private repositories

Pulling OJ (private) needs a credential. The credential is **a read-only deploy
key owned by the agent account**, not the operator's PAT and not the operator's
ssh key.

There is deliberately no configuration key anywhere in `ops/` that accepts a
token. A PAT would have to reach the session through its environment, where
`assertNoSecrets` refuses anything matching `*_TOKEN` and would refuse to spawn
— and a token in a session with a shell is a token that can push, open pull
requests and read every private repository the operator has. A deploy key is
scoped to one repository, is read-only if you tick the box, and is revoked on
its own without touching anything else.

```sh
# 1. A key that belongs to the agent account.
sudo -u clawcius-ops -H ssh-keygen -t ed25519 -N '' \
  -C 'clawcius-ops deploy key (read-only)' \
  -f /var/lib/clawcius-agent/.ssh/oj_deploy

sudo chmod 0700 /var/lib/clawcius-agent/.ssh
sudo chmod 0600 /var/lib/clawcius-agent/.ssh/oj_deploy

# 2. The public half goes on the REPOSITORY, not the account:
#    GitHub → the OJ repo → Settings → Deploy keys → Add deploy key
#    Leave "Allow write access" UNCHECKED.
sudo cat /var/lib/clawcius-agent/.ssh/oj_deploy.pub

# 3. Pin GitHub's host key now, so the first connection is not a prompt
#    nobody is there to answer. The session runs ssh with
#    StrictHostKeyChecking=yes and BatchMode=yes: an unknown host is a clean
#    failure, which is the correct behaviour and a terrible surprise.
sudo -u clawcius-ops -H sh -c \
  'ssh-keyscan -t ed25519 github.com >> /var/lib/clawcius-agent/.ssh/known_hosts'
#    Then check the fingerprint against https://api.github.com/meta before you
#    trust it. `ssh-keyscan` asks the network what the network's key is, which
#    is only as good as the network.

# 4. Point the ops config at it.
#    ops/ops-config.yaml:
#      hostAgent:
#        gitSshKey: /var/lib/clawcius-agent/.ssh/oj_deploy
#
#    The executor turns that into
#      GIT_SSH_COMMAND=ssh -i <key> -o IdentitiesOnly=yes \
#                          -o StrictHostKeyChecking=yes -o BatchMode=yes
#    for the session, and warns at boot if the key is missing, owned by
#    somebody else, or group/world-accessible.

# 5. The OJ checkout must use ssh, not https.
sudo -u clawcius-ops git -C /var/lib/oj/checkout remote set-url origin \
  git@github.com:NickPurcell/oj.git
```

**One key per repository.** `IdentitiesOnly=yes` means only the configured key
is offered, so a second private repository needs a second key and a second
`gitSshKey` — which is a limitation of the current config shape and is written
down rather than worked around with an ssh `Host` alias that would hide which
credential is being used.

### Verify

```sh
sudo -u clawcius-ops -H \
  env GIT_SSH_COMMAND='ssh -i /var/lib/clawcius-agent/.ssh/oj_deploy -o IdentitiesOnly=yes' \
  ssh -T git@github.com
# "Hi NickPurcell/oj! You've successfully authenticated, but GitHub does not
#  provide shell access." — the repository name in that line is the proof it
#  is the deploy key and not somebody's account key.

sudo -u clawcius-ops git -C /var/lib/oj/checkout fetch --dry-run
```

### If you skip this step

Pulls from private repositories fail with `Permission denied (publickey)`,
which reads like a repository-access problem and is an account problem. Public
repositories are unaffected — nothing else here needs a credential.

---

## 6. Hand over the working directory and the config

```sh
# The session's cwd. The executor creates and chowns it at boot, so this is
# only needed if it already exists owned by somebody else.
sudo chown clawcius-ops:clawcius-ops /var/lib/clawcius-host-agent
sudo chmod 0750 /var/lib/clawcius-host-agent

# Confirm the account does NOT own or write the executor's state.
sudo ls -ld /var/lib/clawcius-ops
# drwxr-x--- root root  — 0750 root-owned. If it is anything else, fix it:
sudo chown root:root /var/lib/clawcius-ops && sudo chmod 0750 /var/lib/clawcius-ops
```

`ops/ops-config.yaml` on this branch already carries the new keys
(`hostAgent.user`, `hostAgent.secretPaths`), so nothing needs editing unless
the account is not called `clawcius-ops`.

---

## 7. Build and restart

```sh
cd /home/npurcell/clawcius && git pull
cd ops && npm ci && npm run build && npm run selftest
sudo systemctl restart clawcius-ops
```

`npm run build` is not optional and nothing does it for you: every unit in this
repository starts `node dist/index.js` and not one of them compiles anything.
On 2026-08-09 a merged change did nothing at all for an hour for exactly this
reason.

### Verify — this is the step that tells you whether any of it worked

```sh
sudo journalctl -u clawcius-ops -n 60 --no-pager
```

The boot line names the account:

```
HOST AGENT: /usr/local/bin/claude, up to 30m and $10 per task,
cwd /var/lib/clawcius-host-agent, as clawcius-ops (uid 999, gid 999),
home /var/lib/clawcius-agent, shell /usr/sbin/nologin,
groups: clawcius-ops, clawcius-dev.
```

Read the `groups:` list. It must be the account's own group and
`clawcius-dev`, and nothing else.

If anything is wrong you get a banner instead, with the fix in it:

```
[ops] ══ HOST AGENT ACCOUNT IS NOT CONTAINED ══ clawcius-ops (uid 999 …)
[ops] * clawcius-ops is in the "docker" group, and the host agent will not run
[ops]   as an account that is. …
[ops]       sudo gpasswd -d clawcius-ops docker
[ops] Every task will be REFUSED until this is fixed. Nothing else is affected.
```

The daemon stays up and keeps holding its rollback deadlines while that is
true. It is deliberately not a boot failure: this unit is `Restart=always` with
no start limit, so refusing to boot would be a five-second restart loop with
every armed deadline unhonoured, which is the shape of #7.

The status file says the same thing, which is what the status page reads:

```sh
sudo jq .hostAgent /var/lib/clawcius-ops/ops-status.json
```

---

## 8. The first task, in dry run

`ops-config.yaml` ships `dryRun: true` and should stay that way until a week of
the log contains nothing surprising. In dry run the session has no Bash tool at
all — it is removed by the permission system, not asked for politely — so this
is a safe way to prove the identity plumbing end to end.

```sh
OPS=/var/lib/clawcius/run/ops
STAMP=$(date +%s)
printf '%s' '{"verb":"task","instance":"clawcius","task":"Report who you are: run id, whoami, sudo -l, and try to read /home/npurcell/clawcius/.env. Report exactly what each one said. Change nothing."}' \
  > $OPS/$STAMP.tmp && mv $OPS/$STAMP.tmp $OPS/$STAMP.json

sudo tail -f /var/lib/clawcius-ops/journal.jsonl | jq -r 'select(.kind=="audit") | .command'
```

In dry run it will report the commands it *would* have run. Turn `dryRun` off
and file it again to get the actual output, and read the report: `id` should
say `clawcius-ops` with two groups, `sudo -l` should list the aliases from
`ops/clawcius-sudoers` and nothing else, and the `.env` read should say
*Permission denied*.

That last line is the whole migration, verified by the thing being migrated.

---

## 9. Rollback

Every step is reversible and none of it destroys data. Reverse order:

```sh
# 1. Put the executor back on the old identity. There is no config key for
#    "run as the checkout's owner" any more — that behaviour was deleted, on
#    purpose — so the rollback is to the previous commit.
cd /home/npurcell/clawcius
git log --oneline -5                       # find the commit before this change
git checkout <that-commit> -- ops/ systemd/clawcius-ops.service
cd ops && npm ci && npm run build
sudo systemctl restart clawcius-ops

# 2. The old sudoers file, if you want npurcell's grants back.
sudo git -C /home/npurcell/clawcius show <that-commit>:ops/clawcius-sudoers \
  > /tmp/clawcius-sudoers.old
sudo visudo -c -f /tmp/clawcius-sudoers.old
sudo install -m 0440 -o root -g root /tmp/clawcius-sudoers.old /etc/sudoers.d/clawcius

# 3. The checkout's permissions. Harmless to leave — a group-writable checkout
#    with setgid directories is a reasonable state on its own — but to undo:
sudo chmod -R g-w /home/npurcell/clawcius
sudo find /home/npurcell/clawcius -type d -exec chmod g-s {} +
sudo chgrp -R npurcell /home/npurcell/clawcius

# 4. The account itself. Last, and only if you are sure.
sudo gpasswd -d npurcell clawcius-dev
sudo userdel clawcius-ops                  # add --remove to delete its home
sudo groupdel clawcius-dev
```

**Do not `userdel` before restoring the executor.** With the new code and no
account, every task is refused; with the old code and no account, the session
runs as the checkout's owner again — which works, and is the thing this
migration exists to stop. Restoring the code first means the two states are
never both true.

### If a step goes wrong halfway

- **`visudo -c` fails and sudo is broken.** Use the root shell from § 3 that
  you were told not to close. `rm /etc/sudoers.d/clawcius`. If you closed it:
  single-user mode, or the provider's console.
- **The checkout is unbuildable after the `chmod -R`.** `git status` will show
  nothing (mode changes to files git already tracks as non-executable *do* show
  up; a spurious executable bit everywhere is the symptom of `g+rwx` instead of
  `g+rwX`). `sudo chmod -R a-x $(git ls-files | grep -v '\.sh$')` or, more
  simply, `git checkout -- .` after `git diff --summary` confirms only mode
  changes.
- **Tasks are refused and you cannot tell why.** `sudo jq .hostAgent
  /var/lib/clawcius-ops/ops-status.json` gives one line; the journal gives the
  full refusal with the command to run in it.

---

## Appendix: what each check refuses, and what it only warns about

| Condition | Executor's response |
|---|---|
| `hostAgent.user` does not exist in `/etc/passwd` | **Refuses every task.** No fallback to the checkout's owner, no fallback to root. |
| The account has uid 0 | **Refuses every task.** |
| `/etc/group` cannot be read | **Refuses every task.** A check that cannot be evaluated is not a pass. |
| The account is in `docker`, `podman`, `lxd`, `sudo`, `wheel`, `root`, `disk`, `shadow` or `adm` | **Refuses every task**, names the group, prints the `gpasswd -d`. |
| The account can read any `hostAgent.secretPaths` entry or any instance's `envFile` | **Refuses every task**, names the file, prints the `chmod`. |
| The account cannot write a checkout under `repos:` | Warns, in the boot log and in the journal, with the `chgrp` to run. |
| The account can write `stateDir` | Warns. (On a correctly deployed host it cannot: 0750 root-owned.) |
| The account's home is inside `stateDir` | Warns. |
| `hostAgent.gitSshKey` is missing, owned by somebody else, or group-readable | Warns. |
| The account has a login shell | Warns. Hygiene, not containment — the session is spawned with an explicit argv. |

The split is one rule: **a refusal is something that makes a claim in
`ops/README.md` false. A warning is something that will waste an evening.**

The refusals are evaluated in three places — at boot for the banner, before
every task in the executor, and immediately before `spawn` in
`ops/src/host-agent.ts`. The innermost one exists so that no code path added
later can reach a session start without it. The per-task one exists because
`usermod -aG docker clawcius-ops` is something somebody types on a **running**
host to make a task work, and a check evaluated only at boot on a unit that
stays up for weeks would never see it.
