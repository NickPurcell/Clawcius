/**
 * Deterministic message automation — no model in the loop.
 *
 * The waker already receives every message on the gateway. This evaluates them
 * against declarative rules and acts directly, so routine reactions happen in
 * milliseconds for zero tokens, and can optionally suppress the LLM wake
 * entirely.
 *
 * Rules are **declarative, never executable**, and that is a security boundary
 * rather than a stylistic choice. The agent can write to the rules file; the
 * waker runs unsandboxed with the bot token and unrestricted network. If a rule
 * could carry a shell command, writing one would be a sandbox escape. So the
 * schema admits only a fixed set of Discord actions, and the file is data.
 *
 * Reloaded on write with no restart. A malformed file is rejected and the
 * previous good set stays live — a typo must not leave the bot inert.
 */

import { readFileSync, existsSync, watch, type FSWatcher } from 'node:fs';
import { parse } from 'yaml';

export type RuleAction =
  | { type: 'react'; emoji: string }
  | { type: 'reply'; text: string }
  | { type: 'send'; channelId: string; text: string }
  | { type: 'log'; text: string };

export type Rule = {
  name: string;
  /** Channel ids this rule applies to. Empty means any channel. */
  channels: string[];
  /** Author ids this rule applies to. Empty means anyone. */
  authors: string[];
  /** Case-insensitive substring the content must contain. */
  contains: string | null;
  /** Regex the content must match. Applied to the raw content. */
  matches: RegExp | null;
  /** Whether messages from bots are eligible. Default false. */
  allowBots: boolean;
  actions: RuleAction[];
  /**
   * Suppress the LLM wake when this rule fires. The point of the feature:
   * handle the routine case deterministically and never pay for inference.
   */
  stopWake: boolean;
  /** Minimum seconds between firings, per channel. 0 disables. */
  cooldownSeconds: number;
};

export type RuleMatch = {
  rule: Rule;
  actions: RuleAction[];
};

/** Substitutions available in reply/send/log text. */
export type RuleVars = {
  author: string;
  authorId: string;
  content: string;
  channelId: string;
  messageId: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class RuleError extends Error {
  constructor(where: string, message: string) {
    super(`rules: ${where} ${message}`);
  }
}

function strList(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v, i) => {
    if (typeof v !== 'string') throw new RuleError(`${where}[${i}]`, 'must be a string');
    return v;
  });
}

function parseActions(raw: unknown, where: string): RuleAction[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RuleError(where, 'must be a non-empty list of actions');
  }
  return raw.map((entry, i) => {
    if (!isRecord(entry)) throw new RuleError(`${where}[${i}]`, 'must be a mapping');

    if (typeof entry['react'] === 'string') return { type: 'react', emoji: entry['react'] };
    if (typeof entry['reply'] === 'string') return { type: 'reply', text: entry['reply'] };
    if (typeof entry['log'] === 'string') return { type: 'log', text: entry['log'] };
    if (isRecord(entry['send'])) {
      const s = entry['send'];
      if (typeof s['channel'] !== 'string' || typeof s['text'] !== 'string') {
        throw new RuleError(`${where}[${i}].send`, 'needs `channel` and `text` strings');
      }
      return { type: 'send', channelId: s['channel'], text: s['text'] };
    }
    throw new RuleError(
      `${where}[${i}]`,
      'unknown action. Supported: react, reply, send, log. ' +
        'Rules are data, not code — there is deliberately no way to run a command.',
    );
  });
}

function parseRule(raw: unknown, index: number): Rule {
  if (!isRecord(raw)) throw new RuleError(`rules[${index}]`, 'must be a mapping');
  const name = typeof raw['name'] === 'string' ? raw['name'] : `rule-${index}`;
  const where = `rules[${index}] (${name})`;

  const when = isRecord(raw['when']) ? raw['when'] : {};
  const contains = typeof when['contains'] === 'string' ? when['contains'] : null;

  let matches: RegExp | null = null;
  if (typeof when['matches'] === 'string') {
    if (when['matches'].length > 400) {
      throw new RuleError(`${where}.when.matches`, 'pattern is unreasonably long (max 400 chars)');
    }
    try {
      matches = new RegExp(when['matches'], 'i');
    } catch (error) {
      throw new RuleError(
        `${where}.when.matches`,
        `is not valid regex: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  if (!contains && !matches && !when['channel'] && !when['author']) {
    throw new RuleError(
      where,
      'has no conditions — it would fire on every message. ' +
        'Give it at least one of: contains, matches, channel, author.',
    );
  }

  const cooldown = when['cooldownSeconds'] ?? raw['cooldownSeconds'];
  if (cooldown !== undefined && (typeof cooldown !== 'number' || cooldown < 0)) {
    throw new RuleError(`${where}.cooldownSeconds`, 'must be a number >= 0');
  }

  return {
    name,
    channels: strList(when['channel'], `${where}.when.channel`),
    authors: strList(when['author'], `${where}.when.author`),
    contains,
    matches,
    allowBots: when['allowBots'] === true,
    actions: parseActions(raw['do'], `${where}.do`),
    stopWake: raw['stopWake'] !== false,
    cooldownSeconds: typeof cooldown === 'number' ? cooldown : 0,
  };
}

export function parseRules(text: string): Rule[] {
  const doc: unknown = parse(text);
  if (doc === null || doc === undefined) return [];
  const raw = isRecord(doc) ? doc['rules'] : doc;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RuleError('rules', 'must be a list');
  return raw.map(parseRule);
}

export class RuleEngine {
  #rules: Rule[] = [];
  #path: string;
  #watcher: FSWatcher | null = null;
  #lastFired = new Map<string, number>();
  #reloadTimer: NodeJS.Timeout | null = null;

  constructor(path: string) {
    this.#path = path;
    this.#load('startup');
  }

  get count(): number {
    return this.#rules.length;
  }

  get names(): string[] {
    return this.#rules.map((r) => r.name);
  }

  #load(reason: string): void {
    if (!existsSync(this.#path)) {
      // Absent is a legitimate state: no automation configured.
      if (this.#rules.length > 0) {
        process.stdout.write(`[rules] ${this.#path} removed — keeping ${this.#rules.length} in memory\n`);
        return;
      }
      this.#rules = [];
      return;
    }

    try {
      const next = parseRules(readFileSync(this.#path, 'utf8'));
      this.#rules = next;
      process.stdout.write(`[rules] loaded ${next.length} rule(s) (${reason})\n`);
    } catch (error) {
      // Keep the previous good set. A typo must not silently disable automation.
      process.stderr.write(
        `[rules] reload FAILED, keeping ${this.#rules.length} previous rule(s): ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /** Watch for edits so rules change without a restart. */
  watch(): void {
    if (this.#watcher) return;
    try {
      // Watch the directory, not the file: editors replace rather than modify,
      // which detaches a file watch after the first save.
      const dir = this.#path.replace(/\/[^/]+$/, '');
      const base = this.#path.split('/').pop();
      this.#watcher = watch(dir, (_event, filename) => {
        if (filename !== base) return;
        // Debounce — a single save can emit several events.
        if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
        this.#reloadTimer = setTimeout(() => this.#load('file changed'), 250);
        this.#reloadTimer.unref();
      });
    } catch (error) {
      process.stderr.write(`[rules] could not watch ${this.#path}: ${String(error)}\n`);
    }
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#reloadTimer) clearTimeout(this.#reloadTimer);
  }

  /**
   * Evaluate a message. Returns every rule that fired, in order.
   * Cooldowns are applied here, so a match that is cooling down does not fire
   * and does not suppress the wake.
   */
  evaluate(input: {
    channelId: string;
    authorId: string;
    content: string;
    isBot: boolean;
  }): RuleMatch[] {
    const now = Date.now();
    const fired: RuleMatch[] = [];

    for (const rule of this.#rules) {
      if (input.isBot && !rule.allowBots) continue;
      if (rule.channels.length > 0 && !rule.channels.includes(input.channelId)) continue;
      if (rule.authors.length > 0 && !rule.authors.includes(input.authorId)) continue;
      if (rule.contains && !input.content.toLowerCase().includes(rule.contains.toLowerCase())) continue;
      if (rule.matches && !rule.matches.test(input.content)) continue;

      if (rule.cooldownSeconds > 0) {
        const key = `${rule.name}:${input.channelId}`;
        const last = this.#lastFired.get(key) ?? 0;
        if (now - last < rule.cooldownSeconds * 1000) continue;
        this.#lastFired.set(key, now);
      }

      fired.push({ rule, actions: rule.actions });
    }
    return fired;
  }
}

/** Substitute `{name}` in rule text. Unknown names are left as-is. */
export function fillVars(text: string, vars: RuleVars): string {
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, key: string) =>
    Object.hasOwn(vars, key) ? String(vars[key as keyof RuleVars]) : whole,
  );
}
