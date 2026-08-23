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
 * it. That is `agent.ts` and what was then `index.ts`: the session pool and the
 * whole Discord handler, which between them own most of what can go wrong at
 * runtime and could not be reached by a single test (Clawcius #130). Three
 * defects and three fixes landed in that area in #128 with no test able to
 * touch any of them.
 *
 * Loading is now something the entry point DOES, rather than something that
 * happens to it. `loadConfig()` is the first statement of `main()` in
 * `daemon.ts`, which is the first statement of `index.ts`, and it runs ahead of
 * `preflight()` and of anything that touches Discord — so a daemon with no
 * `DISCORD_TOKEN` still refuses to start, at the same point in startup and with
 * the same message. What changed is that `import` alone no longer has an
 * opinion. (`main()` being a function the entry point calls is the other half of
 * the same convention, and is #131.)
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
  readonly github: {
    readonly token: string;
    /** GitHub App id, or '' if this deployment authenticates with a PAT. */
    readonly appId: string;
    /** Path to the App's PEM. A path, never the key — see loadConfig below. */
    readonly appPrivateKeyPath: string;
    /** Pin the installation when the App is installed on more than one account. */
    readonly appInstallationId: string;
  };

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
      /**
       * GitHub App credentials, if this deployment has them.
       *
       * Both must be present for the App path to be taken; either alone is a
       * half-configured deployment and falls back to the PAT rather than
       * failing, because a crew that cannot reach GitHub is worse than one
       * reaching it as the wrong identity — and the fallback is what keeps
       * Clawcius, which has no App, working unchanged.
       *
       * The private key stays a PATH. Reading it here would put the PEM in this
       * process's memory for its whole life and in every core dump; it is read
       * per mint instead, which also means rotating the key on disk takes
       * effect at the next refresh rather than the next restart.
       */
      appId: process.env['GITHUB_APP_ID'] ?? '',
      appPrivateKeyPath: process.env['GITHUB_APP_PRIVATE_KEY_PATH'] ?? '',
      appInstallationId: process.env['GITHUB_APP_INSTALLATION_ID'] ?? '',
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
 * token: `main()` calls `loadConfig()` and nothing calls this.
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
