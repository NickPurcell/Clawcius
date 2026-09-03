import { loadAgentConfig, type AgentConfig } from './agent-config.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** The process configuration. `readonly` on the env-derived members: `config()` hands every caller the same object. */
export type Config = {
  readonly discord: {
    readonly token: string;
    /** The single guild the bot operates in. */
    readonly guildId: string;
  };

  /** Optional GitHub token for the agent, so it can clone and push over HTTPS. */
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

  /**
   * The login page. `port` is loopback-only; `url` is where `tailscale serve`
   * puts it, and is what the outage announcement points at. Both are per
   * instance, so two crews on one box do not collide.
   */
  readonly loginPage: { readonly port: number; readonly url: string };

  /** Agent behaviour, from agent-config.yaml. `AgentConfig` states its own. */
  readonly agent: AgentConfig;
};

let loaded: Config | null = null;

/** Read and validate the environment, and remember the result. Anthropic credentials are deliberately not read here: the agent inherits the ambient environment. */
export function loadConfig(): Config {
  loaded = {
    discord: {
      token: required('DISCORD_TOKEN'),
      guildId: required('DISCORD_GUILD_ID'),
    },
    github: {
      token: process.env['GITHUB_TOKEN'] ?? '',
      /** GitHub App credentials, if this deployment has them. */
      appId: process.env['GITHUB_APP_ID'] ?? '',
      appPrivateKeyPath: process.env['GITHUB_APP_PRIVATE_KEY_PATH'] ?? '',
      appInstallationId: process.env['GITHUB_APP_INSTALLATION_ID'] ?? '',
    },
    storage: {
      dbPath: process.env['CLAWCIUS_DB_PATH'] ?? '/var/lib/clawcius/clawcius.db',
    },
    loginPage: {
      port: Number(required('LOGIN_PAGE_PORT')),
      url: required('LOGIN_PAGE_URL'),
    },
    agent: loadAgentConfig() satisfies AgentConfig,
  };
  return loaded;
}

/** The config the entry point loaded. */
export function config(): Config {
  if (loaded === null) {
    throw new Error(
      'Config has not been loaded. The entry point calls loadConfig() before ' +
        'anything else; a test calls setConfig() with what it needs.',
    );
  }
  return loaded;
}

/** Install a config directly, instead of reading the environment. */
export function setConfig(next: Config): void {
  loaded = next;
}
