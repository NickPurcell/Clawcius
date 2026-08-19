/**
 * Snapshot restore verification.
 *
 * SETUP.md has carried this line under Known gaps since the snapshot timer was
 * written: *"Snapshots are untested as a restore path. docker/snapshot.sh
 * produces images (~2 GB each, 8 retained), but restoring from one has never
 * been done."* That sentence is the entire justification for this file.
 *
 * The usual cause of a failed rollback is a restore path nobody ever ran. The
 * snapshot timer has been producing images nightly and nothing has ever booted
 * one, so what we actually have is a nightly job that produces 2 GB of
 * *plausible* backups. Now that a missed check-in triggers an automatic
 * rollback, the first time anyone finds out whether those images start would
 * otherwise be during an outage, in the recovery path, with an agent already
 * down.
 *
 * So: on a timer, take the newest snapshot, start a throwaway container from
 * it, prove it is genuinely up, and remove it. Loudly on failure.
 *
 * What "genuinely up" means here is deliberate. `docker run -d` succeeding
 * proves almost nothing — it returns as soon as the container is created, and
 * an image whose entrypoint dies immediately satisfies it. So the check is:
 * start it, wait for it to report running, then `docker exec` a configured
 * probe inside it. A container that is running but whose PID 1 is on its way
 * out fails the exec, which is the case we care about.
 *
 * The throwaway container is deliberately inert:
 *
 *   - a name of its own (`<container>-verify`), never the real one, so a bug
 *     here can never touch the live container;
 *   - no `--restart` policy, so it cannot come back after we remove it;
 *   - no env file, so it holds no Discord token and no agent credential;
 *   - no bind mounts, so it cannot see the workspaces, the agent home, or
 *     either spool — in particular it cannot write a wake or an ops request;
 *   - the same `--network clawcius-internal`, which has no route out except
 *     the Squid proxy, and without the env file it cannot authenticate to
 *     anything anyway;
 *   - removed in a `finally`, and removed again pre-emptively before each run
 *     in case a previous run died between create and remove.
 *
 * ── And then the same failure, one level up ───────────────────────────────
 *
 * Everything above tests whether the newest snapshot *boots*. Until Clawcius
 * #87 that was the whole test: sort the tags, take `tags[0]`, restore it, pass.
 * Nothing looked at the date on the tag.
 *
 * So when `hamachi` stopped being snapshotted on 2026-08-14 — not by losing a
 * timer, it never had one, but by losing the per-task snapshot the ops executor
 * had been taking before every container recreate, retired that day — this file
 * went on booting its 2026-08-14 image every night, watching it come up, and
 * reporting the rollback path sound. It was sound. It restored to a week ago.
 *
 * That is this file's own header happening to this file: "the usual cause of a
 * failed rollback is a restore path nobody ever ran" was answered by running
 * it, and the next cause along is a restore path that runs perfectly onto stale
 * content. A component whose entire job is checking, returning a confident
 * green over an artefact nobody had dated.
 *
 * Hence two things that are deliberately not one thing:
 *
 *   **The age is measured before the boot test, from a `probe`.** `docker
 *   images` runs even under `dryRun`, so staleness is the one property this
 *   verifier can establish honestly on a dry-run host. It is reported there.
 *
 *   **The outcome says WHICH fact it found**, in `finding`, and the four bad
 *   ones do not collapse into one red. "There is no snapshot at all", "the
 *   newest one is nine days old", "it is dated in the future", and "it does not
 *   boot" call for four different actions, and a verifier that prints them all
 *   as `ok: false` has measured four things and told you one.
 */

import { DEFAULT_MAX_AGE_HOURS, type InstanceEntry, type OpsConfig } from './config.js';
import { Runner, summarise } from './runner.js';

/**
 * What the verifier found, as a fact rather than a verdict.
 *
 * `ok` is derived from this and is a convenience for callers that only want a
 * traffic light. The distinction that matters most is `stale` versus
 * `unbootable`: a stale snapshot IS a working rollback target, to the wrong
 * day, and the thing to fix is the schedule that stopped — whereas an
 * unbootable one is a broken image and the schedule may be fine.
 */
export type VerifyFinding =
  /** Newest snapshot is within `maxAgeHours`, restored, and passed the probe. */
  | 'ok'
  /** Nothing was restored because `dryRun` is on. Age was still measured. */
  | 'dry-run'
  /** `docker images` could not be run at all, so nothing at all is known. */
  | 'images-unlistable'
  /** No snapshot tags exist. There is no rollback target of any age. */
  | 'no-snapshots'
  /** Newest tag matched the shape but is not a real UTC instant. */
  | 'unreadable-stamp'
  /** Newest tag is dated in the future, so the age is not trustworthy. */
  | 'future-stamp'
  /** Newest snapshot boots and probes clean, and is older than the ceiling. */
  | 'stale'
  /** Newest snapshot did not start, did not reach running, or failed the probe. */
  | 'unbootable'
  /** Named in `snapshotVerify.instances` with no matching entry under `instances:`. */
  | 'not-configured';

export type VerifyOutcome = {
  instance: string;
  /** True only for `ok` and `dry-run`. Derived from `finding`; see above. */
  ok: boolean;
  /** Which fact was found. Prefer this over `ok` when reporting. */
  finding: VerifyFinding;
  /** The snapshot tag that was tested, when one was found. */
  tag: string;
  /**
   * Age of `tag` in hours at the moment of the check, or null when there was no
   * tag or its stamp could not be read.
   *
   * Null and zero are different answers and the type says so. A number here is
   * a measurement; null is "not measured", and the two used to be the same
   * missing field.
   */
  ageHours: number | null;
  /**
   * Whether the newest datable snapshot was past `maxAgeHours`, independent of
   * `finding`.
   *
   * Orthogonal on purpose. `finding` carries the single most severe fact, so an
   * instance that is stale AND does not boot reports `unbootable` — and a
   * summary that counted staleness by `finding === 'stale'` therefore left that
   * instance out of the stale count while its own detail line described it as
   * both. Two facts, two fields. False when nothing was measured (no snapshots,
   * unreadable stamp, docker unreachable), which is "not stale as far as anyone
   * knows" rather than "fresh".
   */
  stale: boolean;
  detail: string;
};

/**
 * The tag `docker/snapshot.sh` writes: `snap-` then `date -u +%Y%m%d-%H%M%S`.
 *
 * Capturing rather than merely testing, because the same shape that filters the
 * tags is what dates them — the fields are already proven present by the filter,
 * so reading them costs nothing and needs no second `docker` call.
 */
const SNAPSHOT_TAG = /^snap-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})$/;

/**
 * A tag may be up to this far in the future before the stamp is called wrong
 * rather than fresh.
 *
 * Not zero, because `snapshot.sh` run by hand a minute ago is a legitimate
 * newest tag and clocks are not exact. Not generous either: the whole point of
 * treating a future stamp as a finding is that "fresh" is precisely what a
 * wrong clock, or an image tagged on another machine and loaded here, would
 * forge — and forging freshness is the defect this age check exists to end.
 */
const FUTURE_SLACK_MS = 5 * 60 * 1000;

/**
 * When the snapshot behind `tag` was taken, in epoch ms, or null.
 *
 * **UTC, and that is load-bearing.** `snapshot.sh` stamps with `date -u`; this
 * host runs CEST. Reading the stamp as local time would shift every age by two
 * hours, which is invisible in the middle of the range and wrong at the
 * boundary — and a boundary that is wrong by two hours in the lenient direction
 * is a stale snapshot reported green, which is the whole bug again.
 */
export function snapshotTakenAt(tag: string): number | null {
  const match = SNAPSHOT_TAG.exec(tag);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  // `Date.UTC` rolls out-of-range components over in silence: month 13 becomes
  // January of the next year and `snap-20260231-000000` becomes 2 March. Every
  // one of those parses, and every one of them would be reported as a real
  // instant that no snapshot was taken at. Round-trip instead, so a tag that is
  // shaped like a date without being one comes back as unreadable.
  const back = new Date(ms);
  const same =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second;
  return same ? ms : null;
}

/**
 * Truncate toward zero at `places`, never round.
 *
 * `toFixed` rounds to nearest, and rounding an age against a ceiling collides
 * from both sides: at a 48h ceiling, 47.97h rendered "48.0 hours … within the
 * 48h ceiling" and 48.001h rendered "48 hours … past the 48h ceiling". Two runs
 * a minute apart printing the same age and opposite verdicts reads as a bug in
 * the check rather than as a boundary being crossed, which is the one reading
 * this report cannot afford. Truncation keeps the printed number on the same
 * side of the ceiling as the comparison that produced the verdict.
 */
function truncTo(value: number, places: number): string {
  const scale = 10 ** places;
  return (Math.trunc(value * scale) / scale).toFixed(places);
}

/** Ages a human reads at 3am: hours while that is meaningful, days once it is not. */
function describeAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 48) return `${truncTo(hours, 1)} hours`;
  // Both figures truncated, so they cannot disagree with each other either:
  // 120.5h used to print "5.0 days (121 hours)".
  return `${truncTo(hours / 24, 1)} days (${truncTo(hours, 0)} hours)`;
}

/** The stamp, spelled out, so nobody has to decode `snap-20260814-190145` under pressure. */
function describeInstant(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * What to do about an instance whose snapshots have stopped moving.
 *
 * Every branch of this returns something an operator can run. That is the other
 * half of the design constraint on this change: a verifier that goes red for a
 * reason nobody can act on has only moved the uselessness, and the failure text
 * is where the action has to live because the failure text is what
 * `systemctl --failed` sends someone to read.
 *
 * The unit name comes from config and is never derived from the instance name.
 * This function used to be a hardcoded "Check clawcius-snapshot.timer" in the
 * no-snapshots branch, printed for every instance — so the one instance that
 * ever actually hit it would have been sent to read instance 1's timer, which
 * was running, nightly, correctly, and had nothing to do with it.
 */
function whatToDoAbout(instance: InstanceEntry): string {
  if (instance.snapshotTimer) {
    return (
      `Nothing is currently producing snapshots of ${instance.container}. ` +
      `\`systemctl list-timers --all ${instance.snapshotTimer}\` — a timer that is not ` +
      'listed is not enabled, and one listed with a NEXT in the past is not firing.'
    );
  }
  return (
    `ops-config.yaml records no \`snapshotTimer\` for instance "${instance.name}", and on ` +
    'its own that is the likeliest explanation: an instance with nothing scheduled to ' +
    'snapshot it produces exactly this reading, which is how hamachi spent days with a ' +
    'green restore test over a frozen image (Clawcius #87). Compare ' +
    '`systemctl list-timers --all | grep snap` against `instances:` — and once you know ' +
    `which timer owns ${instance.container}, write it into that instance's ` +
    '`snapshotTimer` so the next report names it instead of saying this.'
  );
}

function imageRepo(instance: InstanceEntry): string {
  const colon = instance.image.lastIndexOf(':');
  return colon > 0 ? instance.image.slice(0, colon) : instance.image;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyInstance(
  config: OpsConfig,
  runner: Runner,
  instance: InstanceEntry,
): Promise<VerifyOutcome> {
  const repo = imageRepo(instance);
  const throwaway = `${instance.container}-verify`;

  const images = await runner.probe(
    [config.dockerPath, 'images', repo, '--format', '{{.Tag}}'],
    { timeoutSeconds: 60 },
  );
  if (!images.ok) {
    return {
      instance: instance.name,
      ok: false,
      finding: 'images-unlistable',
      tag: '',
      ageHours: null,
      stale: false,
      detail: `cannot list images for ${repo}: ${images.stderr || summarise(images)}`,
    };
  }

  // ── Newest READABLE, not newest ─────────────────────────────────────────
  //
  // Selection used to be max-then-validate: take `tags[0]`, then try to date
  // it. One tag that matches the shape without being a real instant sorts
  // highest forever and the boot test never runs on the good image behind it —
  // and `snapshot.sh` prunes the LOWEST tags (`sort -r | tail -n +KEEP`), so
  // nothing ever removes it. A single bad tag would retire the restore test
  // permanently, which is a worse outcome than the bad tag.
  //
  // So: validate first, pick the newest that dates, and carry the bad ones into
  // the report rather than tripping over them. Loud AND still testing.
  const shaped = images.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((tag) => SNAPSHOT_TAG.test(tag))
    .sort()
    .reverse();
  const dated = shaped.map((tag) => ({ tag, at: snapshotTakenAt(tag) }));
  const readable = dated.filter(
    (entry): entry is { tag: string; at: number } => entry.at !== null,
  );
  const unreadable = dated.filter((entry) => entry.at === null).map((entry) => entry.tag);

  // Appended to every detail below when it is non-empty. These tags are inert
  // for selection now, and saying nothing about them would leave the disk
  // quietly accumulating something no retention rule can reach.
  const badTagNote = unreadable.length
    ? ` (Ignoring ${unreadable.length} tag(s) on ${repo} that match the snapshot shape but ` +
      `are not real instants: ${unreadable.join(', ')}. snapshot.sh prunes the LOWEST tags, ` +
      'so nothing will ever remove these — `docker rmi ' +
      `${unreadable.map((bad) => `${repo}:${bad}`).join(' ')}\` when you have worked out what ` +
      'wrote them.)'
    : '';

  if (shaped.length === 0) {
    // Not a pass, and NOT the same finding as a stale one. An instance with no
    // snapshots has no rollback path at any date; an instance with an old one
    // has a rollback path to the wrong day. The first is a hole, the second is
    // a clock that stopped, and they are repaired differently — so they get
    // different findings and different words rather than a shared red.
    return {
      instance: instance.name,
      ok: false,
      finding: 'no-snapshots',
      tag: '',
      ageHours: null,
      stale: false,
      detail:
        `no snapshot images exist for ${repo} at all. There is nothing to restore at any ` +
        `date, so a rollback of ${instance.container} is not something that would go badly ` +
        `— it is something that cannot be attempted. ${whatToDoAbout(instance)}`,
    };
  }

  // ── The age, measured before anything is started ────────────────────────
  //
  // Deliberately here rather than after the restore. `docker images` above is a
  // `probe`, so it runs even under dryRun; the restore below does not. Putting
  // the measurement first is what lets a dry-run host still learn the one thing
  // it can honestly learn, and it is the reading that was missing entirely.
  const newest = readable[0];
  if (!newest) {
    // Tags exist and NOT ONE of them dates. Distinct from `no-snapshots`: there
    // are images here, they may even restore, and none of them can be placed in
    // time — which is the same position as not checking.
    return {
      instance: instance.name,
      ok: false,
      finding: 'unreadable-stamp',
      tag: shaped[0] ?? '',
      ageHours: null,
      stale: false,
      detail:
        `every snapshot tag on ${repo} is shaped like a UTC timestamp without being one ` +
        `(${shaped.join(', ')}), so how old this instance's rollback target is cannot be ` +
        'established. Something other than docker/snapshot.sh wrote these. Note that ' +
        'snapshot.sh prunes the LOWEST tags, so nothing will ever remove them on its own.',
    };
  }
  const { tag, at: takenAt } = newest;

  const ageMs = Date.now() - takenAt;
  const ageHours = ageMs / 3_600_000;
  if (ageMs < -FUTURE_SLACK_MS) {
    return {
      instance: instance.name,
      ok: false,
      finding: 'future-stamp',
      tag,
      ageHours,
      stale: false,
      detail:
        `the newest tag on ${repo} is ${tag}, dated ${describeInstant(takenAt)} — ` +
        `${describeAge(-ageMs)} in the future. Every age on this instance is therefore ` +
        'untrustworthy, and note which way the error points: a clock ahead of real time ' +
        'makes stale snapshots look fresh, so this is reported rather than tolerated. ' +
        'Check the host clock (`timedatectl`), and check whether this image was tagged ' +
        'somewhere else and loaded here. THE RESTORE TEST DID NOT RUN this time — a ' +
        'future-dated tag sorts highest and snapshot.sh prunes the lowest, so this one ' +
        `will not age out and nothing will be tested until it goes: \`docker rmi ${repo}:${tag}\` ` +
        `once you know what wrote it.${badTagNote}`,
    };
  }

  const maxAgeMs = config.snapshotVerify.maxAgeHours * 3_600_000;
  const stale = ageMs > maxAgeMs;
  // The staleness sentence, assembled once: it is appended to the unbootable
  // findings too, because "it does not boot AND it is nine days old" is two
  // repairs, and reporting only the one that happened to be checked last is how
  // the second gets fixed a week later.
  //
  // The ceiling's RATIONALE is stated only when the configured value is still
  // the shipped one. "Sized at two missed nightly snapshots" is a fact about
  // 48, not about `maxAgeHours` — it is false for the 12 the suite's own test
  // configures, and a report that explains a number by reciting the default's
  // reasoning is the same defect as the green light this whole change is about:
  // a sentence that was true when written, printed in a state nobody checked.
  const rationale =
    config.snapshotVerify.maxAgeHours === DEFAULT_MAX_AGE_HOURS
      ? ', which is sized at two missed nightly snapshots so that one benign catch-up ' +
        'after downtime does not trip it'
      : ` (the shipped default is ${DEFAULT_MAX_AGE_HOURS}h; this host has been configured ` +
        'differently)';
  const staleDetail =
    `${repo}:${tag} is the newest snapshot and it was taken ${describeInstant(takenAt)}, ` +
    `${describeAge(ageMs)} ago — past the ${config.snapshotVerify.maxAgeHours}h ceiling ` +
    `(\`snapshotVerify.maxAgeHours\`)${rationale}.`;

  // Pre-emptive cleanup. A previous run killed between create and remove
  // leaves the throwaway behind, and `docker run --name` would then fail with
  // a name conflict that reads like an unrelated bug.
  await runner.run([config.dockerPath, 'rm', '-f', throwaway], { timeoutSeconds: 120 });

  const started = await runner.run(
    [
      config.dockerPath,
      'run',
      '-d',
      '--name',
      throwaway,
      '--runtime=runsc',
      '--network',
      'clawcius-internal',
      // No --restart, no --env-file, no -v. See the header.
      '--memory=1g',
      '--pids-limit=256',
      '--security-opt=no-new-privileges:true',
      `${repo}:${tag}`,
      // Something that stays up without doing anything. The image's own
      // entrypoint is not used: we are testing that the filesystem restored,
      // not re-running whatever the agent left running when the snapshot was
      // taken — which could be a bot that starts posting to Discord.
      'sleep',
      String(config.snapshotVerify.startTimeoutSeconds + 60),
    ],
    { timeoutSeconds: 300 },
  );

  if (!started.ok) {
    return {
      instance: instance.name,
      ok: false,
      finding: 'unbootable',
      tag,
      ageHours,
      stale,
      detail:
        `could not start a container from ${repo}:${tag}: ${started.stderr || summarise(started)}` +
        (stale ? ` — and separately, ${staleDetail} ${whatToDoAbout(instance)}` : '') +
        badTagNote,
    };
  }

  if (started.skipped) {
    // A dry run proves nothing about restoring, and it does not have to: the
    // age came from a probe, which ran. So a dry-run host still reports a
    // stopped snapshot schedule, and reports it as `stale` rather than as a
    // dry-run pass — because the staleness was measured and not simulated.
    if (stale) {
      return {
        instance: instance.name,
        ok: false,
        finding: 'stale',
        tag,
        ageHours,
        stale: true,
        detail:
          `${staleDetail} ${whatToDoAbout(instance)} (DRY RUN — nothing was restored, so ` +
          'whether this image still BOOTS is untested. Its age is not: that was read from ' +
          '`docker images`, which runs in dry run.)' +
          badTagNote,
      };
    }
    return {
      instance: instance.name,
      ok: true,
      finding: 'dry-run',
      tag,
      ageHours,
      stale: false,
      detail:
        `DRY RUN — would have restored ${repo}:${tag} into ${throwaway}, probed it with ` +
        `${config.snapshotVerify.probe.join(' ')}, and removed it. Nothing was started, so ` +
        'this is NOT evidence that the snapshot restores. Its age WAS checked and is ' +
        `${describeAge(ageMs)}, within the ${config.snapshotVerify.maxAgeHours}h ceiling.` +
        badTagNote,
    };
  }

  try {
    const deadline = Date.now() + config.snapshotVerify.startTimeoutSeconds * 1000;
    let lastState = 'unknown';

    for (;;) {
      const state = await runner.probe(
        [config.dockerPath, 'container', 'inspect', '-f', '{{.State.Status}}', throwaway],
        { timeoutSeconds: 30 },
      );
      lastState = state.ok ? state.stdout.trim() : `inspect failed: ${state.stderr.trim()}`;
      if (lastState === 'running') break;

      if (Date.now() >= deadline) {
        return {
          instance: instance.name,
          ok: false,
          finding: 'unbootable',
          tag,
          ageHours,
          stale,
          detail:
            `${repo}:${tag} did not reach "running" within ` +
            `${config.snapshotVerify.startTimeoutSeconds}s (last state: ${lastState}). ` +
            'This snapshot would not restore.' +
            (stale ? ` And separately, ${staleDetail} ${whatToDoAbout(instance)}` : '') +
            badTagNote,
        };
      }
      await sleep(1000);
    }

    // Running is not the same as usable. The probe is what tells them apart.
    const probe = await runner.probe(
      [config.dockerPath, 'exec', throwaway, ...config.snapshotVerify.probe],
      { timeoutSeconds: 120 },
    );
    if (!probe.ok) {
      return {
        instance: instance.name,
        ok: false,
        finding: 'unbootable',
        tag,
        ageHours,
        stale,
        detail:
          `${repo}:${tag} started, but the probe ` +
          `(${config.snapshotVerify.probe.join(' ')}) failed: ${probe.stderr || summarise(probe)}. ` +
          'The container is up and its contents are not what a restore needs them to be.' +
          (stale ? ` And separately, ${staleDetail} ${whatToDoAbout(instance)}` : '') +
          badTagNote,
      };
    }

    // Boots, probes clean, and old. This is the case the whole change is for,
    // and the wording has to carry the distinction: nothing is wrong with the
    // IMAGE. It restores. What is wrong is that it is the newest one there is.
    if (stale) {
      return {
        instance: instance.name,
        ok: false,
        finding: 'stale',
        tag,
        ageHours,
        stale: true,
        detail:
          `${repo}:${tag} restored, reached "running", and passed ` +
          `${config.snapshotVerify.probe.join(' ')} — the image is fine. What is not fine is ` +
          `its date. ${staleDetail} So a rollback of ${instance.container} today would work, ` +
          `and would land on ${describeInstant(takenAt)}, discarding everything the agent ` +
          `installed since. ${whatToDoAbout(instance)}` +
          badTagNote,
      };
    }

    return {
      instance: instance.name,
      ok: true,
      finding: 'ok',
      tag,
      ageHours,
      stale: false,
      detail:
        `${repo}:${tag} restored, reached "running", and passed ` +
        `${config.snapshotVerify.probe.join(' ')}. Taken ${describeInstant(takenAt)}, ` +
        `${describeAge(ageMs)} ago, within the ${config.snapshotVerify.maxAgeHours}h ceiling. ` +
        'This snapshot is a usable rollback target, and a current one.' +
        badTagNote,
    };
  } finally {
    // Always, on every path, including the failures above. A verifier that
    // leaves 2 GB containers behind on failure turns a broken snapshot into a
    // full disk.
    const removed = await runner.run([config.dockerPath, 'rm', '-f', throwaway], {
      timeoutSeconds: 120,
    });
    if (!removed.ok && !removed.skipped) {
      process.stderr.write(
        `[ops verify] could not remove the throwaway container ${throwaway}: ` +
          `${removed.stderr || summarise(removed)}. Remove it by hand.\n`,
      );
    }
  }
}

export async function verifyAll(config: OpsConfig, runner: Runner): Promise<VerifyOutcome[]> {
  const names = config.snapshotVerify.instances;
  const outcomes: VerifyOutcome[] = [];

  for (const name of names) {
    const instance = config.instances.find((entry) => entry.name === name);
    if (!instance) {
      // Cannot happen — the config loader checks this — but a verifier that
      // silently skips an instance it was told to check is exactly the failure
      // mode this whole file is about.
      outcomes.push({
        instance: name,
        ok: false,
        finding: 'not-configured',
        tag: '',
        ageHours: null,
        stale: false,
        detail: 'not found under instances: in ops-config.yaml',
      });
      continue;
    }
    // Sequentially. Each one starts a container from a multi-gigabyte image;
    // doing two at once on a 12 GB box during a nightly timer is a good way to
    // discover the memory ceiling.
    outcomes.push(await verifyInstance(config, runner, instance));
  }

  return outcomes;
}

// ══════════════════════════════════════════════════════════════════════════
// The report
//
// These live here rather than in `verify-main.ts` so they can be tested. That
// is not tidiness: the argument for this whole change is that the
// OPERATOR-FACING REPORT is the deliverable, and the summary line — the line
// most likely to be the only one read — was the one piece of it with no test.
// It said a stale restore "works" two lines after the detail said whether it
// boots was untested, and nothing caught that because nothing could.
// ══════════════════════════════════════════════════════════════════════════

/**
 * The banner a finding gets, and why they are not all the same one.
 *
 * Until Clawcius #87 every failure printed `RESTORE TEST FAILED`, which was
 * accurate while the only thing tested was whether the image booted. It is not
 * accurate for the finding that change added: a stale snapshot passes the
 * restore test — that is what makes it dangerous — and telling an operator at
 * 3am that the restore failed would send them to look at an image that is
 * perfectly good and away from the schedule that stopped.
 *
 * `Record<VerifyFinding, ...>`, so adding a finding without a banner is a
 * compile error rather than an empty string in a log at 3am.
 */
export const BANNER: Record<VerifyFinding, string> = {
  ok: '',
  'dry-run': '',
  'images-unlistable': '══ NOTHING IS KNOWN ══',
  'no-snapshots': '══ NO ROLLBACK TARGET AT ALL ══',
  'unreadable-stamp': '══ SNAPSHOT AGE UNREADABLE ══',
  'future-stamp': '══ SNAPSHOT DATED IN THE FUTURE ══',
  stale: '══ SNAPSHOTS HAVE STOPPED ══',
  unbootable: '══ RESTORE TEST FAILED ══',
  'not-configured': '══ INSTANCE NOT CONFIGURED ══',
};

/** The one-line consequence, which is the sentence an operator acts on. */
export const CONSEQUENCE: Record<VerifyFinding, string> = {
  ok: '',
  'dry-run': '',
  'images-unlistable': 'Whether this instance has a rollback path is currently unknown.',
  'no-snapshots': 'This instance cannot be rolled back to any date.',
  'unreadable-stamp': 'This instance has a rollback path of unknown vintage.',
  'future-stamp': 'Ages on this instance cannot be trusted, in the direction that hides staleness.',
  stale: 'This instance CAN be rolled back, and only to a state that keeps getting older.',
  unbootable: 'A rollback of this instance would not work today.',
  'not-configured': 'Nothing was tested for this instance.',
};

/**
 * The journal `what` string: greppable by failure mode.
 *
 * `grep '"kind":"verify"' journal.jsonl | grep stale` answers "when did this
 * instance stop being snapshotted" without anyone parsing a sentence.
 */
export function journalWhat(outcome: VerifyOutcome): string {
  return (
    `snapshot-verify ${outcome.instance} [${outcome.finding}]` +
    `${outcome.tag ? ` ${outcome.tag}` : ''}` +
    `${outcome.ageHours === null ? '' : ` age=${outcome.ageHours.toFixed(1)}h`}`
  );
}

/**
 * The closing summary line.
 *
 * **Under `dryRun` it may not say anything works.** It used to end
 * `1 restore(s) work and are older than the configured ceiling` in a run whose
 * detail line two lines above said, correctly, that whether the image boots was
 * untested — because the `stale` branch returns before anything is started. The
 * summary asserted the opposite of the detail, in the shipped mode, on the line
 * most likely to be the only one read. Nothing here may claim a restore works
 * unless a restore was actually attempted.
 */
export function summariseVerify(outcomes: VerifyOutcome[], dryRun: boolean): string {
  const total = outcomes.length;
  const current = outcomes.filter((outcome) => outcome.finding === 'ok').length;
  const withinCeiling = outcomes.filter(
    (outcome) => outcome.ageHours !== null && !outcome.stale,
  ).length;
  // By the `stale` FIELD, not by `finding` — an instance that is stale and also
  // unbootable reports `unbootable`, and counting by finding dropped it from
  // the tally while its own detail described it as both.
  const staleWorking = outcomes.filter((o) => o.stale && o.finding === 'stale').length;
  const staleBroken = outcomes.filter((o) => o.stale && o.finding !== 'stale').length;

  if (dryRun) {
    return (
      `DRY RUN — no restore was attempted, so NO restore path is proven here. Ages were ` +
      `read, and they are real: ${withinCeiling}/${total} instance(s) have a snapshot ` +
      `within the ceiling` +
      (staleWorking + staleBroken > 0 ? `, ${staleWorking + staleBroken} older than it` : '') +
      '.'
    );
  }

  return (
    `${current}/${total} instance(s) have a current, working restore path` +
    (staleWorking > 0
      ? `; ${staleWorking} restore(s) work and are older than the configured ceiling`
      : '') +
    (staleBroken > 0
      ? `; ${staleBroken} are older than the ceiling AND did not restore`
      : '') +
    '.'
  );
}
