/**
 * Secrets and deployment identity, from the environment.
 *
 * Everything describing how the agent *behaves* lives in `agent-config.yaml`
 * instead — see `agent-config.ts`. This file holds only what must not be
 * committed, plus the paths needed to find the config itself.
 *
 * ── Why this is a function and not a module-scope constant ──────────────────
 *
 * It used to be `export const config = { token: required('DISCORD_TOKEN'), … }`,
 * evaluated in the module body. Two things happened at IMPORT time as a result:
 * the environment was read and validated, and `loadAgentConfig()` went to disk
 * for the YAML. Either can throw, and both did — so every module that imported
 * this one, transitively, was unloadable without a live deployment underneath
 * it. That is `agent.ts` and `index.ts`: the session pool and the whole Discord
 * handler, which between them own most of what can go wrong at runtime and
 * could not be reached by a single test (Clawcius #130). Three defects and
 * three fixes landed in that area in #128 with no test able to touch any of
 * them.
 *
 * Loading is now something the entry point DOES, rather than something that
 * happens to it. `loadConfig()` is the first statement in the body of
 * `index.ts`, ahead of `preflight()` and of anything that touches Discord, so a
 * daemon with no `DISCORD_TOKEN` still refuses to start, at the same point in
 * startup and with the same message. What changed is that `import` alone no
 * longer has an opinion.
 *
 * This is the shape `ops/` and `status/` already use — `loadOpsConfig`,
 * `loadStatusConfig`. The root package was the outlier.
 */

import { loadAgentConfig, type AgentConfig } from './agent-config.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * `readonly` on the env-derived members, because `as const` used to give them
 * that and a hand-written type does not. `config()` hands every caller the same
 * object, so without these `config().discord.token = …` typechecks — an
 * assignment the old shape rejected. Nothing does it today; that is the point of
 * writing it down while nothing does.
 */
export type Config = {
  readonly discord: {
    readonly token: string;
    /**
     * The single guild the bot operates in. Passed to the agent so the
     * `discord` CLI resolves it without the agent ever choosing a server.
     */
    readonly guildId: string;
  };

  /**
   * Optional GitHub token for the agent, so it can clone and push over HTTPS.
   *
   * HTTPS rather than SSH deliberately: the agent runs under
   * `bwrap --unshare-net` whose only route out is a bridge to an HTTP proxy.
   * SSH is not HTTP, so `git@github.com` has no path out of the sandbox at
   * all. HTTPS goes over CONNECT like every other allowed request.
   */
  readonly github: { readonly token: string };

  readonly storage: { readonly dbPath: string };

  /** Agent behaviour, from agent-config.yaml. `AgentConfig` states its own. */
  readonly agent: AgentConfig;
};

let loaded: Config | null = null;

/**
 * Read and validate the environment, and remember the result.
 *
 * Anthropic credentials are deliberately *not* read here.
 *
 * The agent inherits the ambient environment, so it authenticates exactly the
 * way the `claude` CLI does for the user running this service: an
 * `ANTHROPIC_API_KEY` if one is exported, otherwise the OAuth credentials in
 * that user's home directory. That means no key is required in `.env` — but it
 * also means the service must run as a user who has actually logged in. See
 * SETUP.md § Authentication.
 *
 * Throws on a missing required variable or an unreadable `agent-config.yaml`,
 * exactly as the old module body did. The entry point calls this before it
 * does anything else, so that throw still lands during startup.
 */
export function loadConfig(): Config {
  loaded = {
    discord: {
      token: required('DISCORD_TOKEN'),
      guildId: required('DISCORD_GUILD_ID'),
    },
    github: {
      token: process.env['GITHUB_TOKEN'] ?? '',
    },
    storage: {
      dbPath: process.env['CLAWCIUS_DB_PATH'] ?? '/var/lib/clawcius/clawcius.db',
    },
    agent: loadAgentConfig() satisfies AgentConfig,
  };
  return loaded;
}

/**
 * The config the entry point loaded.
 *
 * Throws rather than lazily loading, and the difference matters. A `config()`
 * that read the environment on first use would put the startup failure
 * wherever the first read happened to be — inside a turn, after the gateway
 * connected, in whatever code path got there first. The daemon should die
 * during startup or not at all, so "nobody loaded a config" is its own loud
 * error and not a second chance to read `process.env`.
 */
export function config(): Config {
  if (loaded === null) {
    throw new Error(
      'Config has not been loaded. The entry point calls loadConfig() before ' +
        'anything else; a test calls setConfig() with what it needs.',
    );
  }
  return loaded;
}

/**
 * Install a config directly, instead of reading the environment.
 *
 * This is what a test uses, and saying so is more honest than a name that
 * pretends otherwise. It is not a way to make the daemon start without a
 * token: `index.ts` calls `loadConfig()` and nothing calls this.
 *
 * The tests are plain JavaScript, so one that only touches the session pool
 * passes only the keys the session pool reads, and that is deliberate: a
 * fixture obliged to be a complete `AgentConfig` would be a second copy of
 * `agent-config.yaml` to keep in step with the real one, and it would go stale
 * silently. What each test stands up is visible in the test.
 */
export function setConfig(next: Config): void {
  loaded = next;
}
