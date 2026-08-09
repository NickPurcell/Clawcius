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
 */

import type { InstanceEntry, OpsConfig } from './config.js';
import { Runner, summarise } from './runner.js';

export type VerifyOutcome = {
  instance: string;
  ok: boolean;
  /** The snapshot tag that was tested, when one was found. */
  tag: string;
  detail: string;
};

const SNAPSHOT_TAG = /^snap-[0-9]{8}-[0-9]{6}$/;

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
      tag: '',
      detail: `cannot list images for ${repo}: ${images.stderr || summarise(images)}`,
    };
  }

  const tags = images.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((tag) => SNAPSHOT_TAG.test(tag))
    .sort()
    .reverse();

  const tag = tags[0];
  if (!tag) {
    // Not a pass. An instance with no snapshots has no rollback path at all,
    // which is a worse position than one whose snapshots are broken — at least
    // a broken snapshot is a thing you can find out about.
    return {
      instance: instance.name,
      ok: false,
      tag: '',
      detail:
        `no snapshot images exist for ${repo}. There is nothing to restore, so an ` +
        'automatic rollback of this instance would fail. Check clawcius-snapshot.timer.',
    };
  }

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
      tag,
      detail: `could not start a container from ${repo}:${tag}: ${started.stderr || summarise(started)}`,
    };
  }

  if (started.skipped) {
    return {
      instance: instance.name,
      ok: true,
      tag,
      detail:
        `DRY RUN — would have restored ${repo}:${tag} into ${throwaway}, probed it with ` +
        `${config.snapshotVerify.probe.join(' ')}, and removed it. Nothing was started, so ` +
        'this is NOT evidence that the snapshot restores.',
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
          tag,
          detail:
            `${repo}:${tag} did not reach "running" within ` +
            `${config.snapshotVerify.startTimeoutSeconds}s (last state: ${lastState}). ` +
            'This snapshot would not restore.',
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
        tag,
        detail:
          `${repo}:${tag} started, but the probe ` +
          `(${config.snapshotVerify.probe.join(' ')}) failed: ${probe.stderr || summarise(probe)}. ` +
          'The container is up and its contents are not what a restore needs them to be.',
      };
    }

    return {
      instance: instance.name,
      ok: true,
      tag,
      detail:
        `${repo}:${tag} restored, reached "running", and passed ` +
        `${config.snapshotVerify.probe.join(' ')}. This snapshot is a usable rollback target.`,
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
        tag: '',
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
