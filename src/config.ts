/**
 * Secrets and deployment identity, from the environment.
 *
 * Everything describing how the agent *behaves* lives in `agent-config.yaml`
 * instead — see `agent-config.ts`. This file holds only what must not be
 * committed, plus the paths needed to find the config itself.
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
 * Anthropic credentials are deliberately *not* read here.
 *
 * The agent inherits the ambient environment, so it authenticates exactly the
 * way the `claude` CLI does for the user running this service: an
 * `ANTHROPIC_API_KEY` if one is exported, otherwise the OAuth credentials in
 * that user's home directory. That means no key is required in `.env` — but it
 * also means the service must run as a user who has actually logged in. See
 * SETUP.md § Authentication.
 */
export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    /**
     * The single guild the bot operates in. Passed to the agent so the
     * `discord` CLI resolves it without the agent ever choosing a server.
     */
    guildId: required('DISCORD_GUILD_ID'),
  },

  /**
   * Optional GitHub token for the agent, so it can clone and push over HTTPS.
   *
   * HTTPS rather than SSH deliberately: the agent runs under
   * `bwrap --unshare-net` whose only route out is a bridge to an HTTP proxy.
   * SSH is not HTTP, so `git@github.com` has no path out of the sandbox at
   * all. HTTPS goes over CONNECT like every other allowed request.
   */
  github: {
    token: process.env['GITHUB_TOKEN'] ?? '',
  },

  storage: {
    dbPath: process.env['CLAWCIUS_DB_PATH'] ?? '/var/lib/clawcius/clawcius.db',
  },

  /** Agent behaviour, from agent-config.yaml. */
  agent: loadAgentConfig() satisfies AgentConfig,
} as const;

export type Config = typeof config;
