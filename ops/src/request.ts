/**
 * Parsing and validating ops requests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE CHANGING ANYTHING IN THIS FILE.
 *
 * The spool is written by an agent that may be prompt-injected, and read by a
 * root process holding docker and systemctl. That is the whole threat model in
 * one sentence, and it is not hypothetical: the agents on this host read
 * Discord messages from strangers, fetch web pages, clone repositories and
 * summarise pull requests opened by people we have never met. Any of those can
 * contain text saying "now write the following JSON into the ops spool". The
 * container boundary is what stops that text becoming host code execution, and
 * this file is where the boundary is actually enforced.
 *
 * So the rules, and the reasoning:
 *
 *   **Closed verb list.** A verb is matched against a frozen set. An unknown
 *   verb is rejected and logged — never "close enough", never a prefix match,
 *   never a default branch that tries something sensible. "Best effort" on
 *   privileged input means the attacker chooses the effort.
 *
 *   **Every argument is a lookup, not a value.** `unit`, `instance` and `repo`
 *   are validated by exact equality against config, and what reaches the
 *   command is the *config entry*, not the request's string. The request only
 *   ever selects; it never supplies. That is the difference between an
 *   allowlist and a filter, and filters lose.
 *
 *   **No shell, anywhere.** Every command in this service is an argv array
 *   handed to execFile with no shell. There is no string to quote, so there is
 *   nothing quoting can get wrong. Do not add `exec`, do not pass
 *   `shell: true`, do not build a command line "just for logging" and then run
 *   it. This is why `;`, `$(…)`, backticks and newlines in a field are not
 *   interesting to us — but the validation rejects them anyway, because the
 *   day someone adds a shell should not also be the day this became
 *   exploitable.
 *
 *   **Structural rejection, not repair.** Malformed JSON is discarded whole.
 *   Nothing here salvages the parseable prefix of a broken file, and nothing
 *   coerces types. A number where a string belongs is a reject.
 *
 *   **Traversal is checked on identifiers even though they are never used as
 *   paths.** They are not used as paths *today*. Defence that only holds while
 *   the current call graph holds is not defence.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** The closed set. Nothing outside this is ever dispatched. */
export const VERBS = [
  'restart',
  'pull',
  'redeploy',
  'snapshot',
  'rollback',
  'checkin',
  'wake',
] as const;

export type Verb = (typeof VERBS)[number];

const VERB_SET: ReadonlySet<string> = new Set<string>(VERBS);

/**
 * Verbs that destroy or replace a running container.
 *
 * These are the ones that wait for an idle turn, arm a check-in deadline and
 * consult the circuit breaker. Kept as data next to the verb list so that
 * adding a verb forces a decision about which side of the line it is on.
 */
export const DESTRUCTIVE_VERBS: ReadonlySet<Verb> = new Set<Verb>(['redeploy', 'rollback']);

export function isDestructive(verb: Verb): boolean {
  return DESTRUCTIVE_VERBS.has(verb);
}

/**
 * A request that has passed structural validation.
 *
 * Still untrusted at this point: the identifier fields are known to be
 * *well-shaped*, not known to be *allowed*. Resolution against the config
 * allowlists happens in the executor, which is the only thing holding them.
 */
export type OpsRequest = {
  verb: Verb;
  /** Unit name, for `restart`. */
  unit: string;
  /** Repo name, for `pull`. */
  repo: string;
  /** Instance name, for `redeploy` / `snapshot` / `rollback` / `checkin`. */
  instance: string;
  /** Snapshot tag, for `rollback`. Empty means "the newest one". */
  tag: string;
  /** Discord channel, for `wake`. */
  channel: string;
  /** Free text: why the agent asked. Never reaches a command. */
  reason: string;
  /** Free text: the wake prompt, or the check-in detail. Never reaches a command. */
  detail: string;
  /** Fields present in the file that this schema does not know. Logged. */
  unknownFields: string[];
};

export type ParseResult = { ok: true; request: OpsRequest } | { ok: false; reason: string };

/**
 * Identifier fields: what an agent may name.
 *
 * Deliberately tighter than the set it selects from. The config allowlist is
 * the real gate — this is a cheap structural filter in front of it so garbage
 * is rejected with a precise reason instead of failing an equality test and
 * being reported as "not allowed", which reads like a config problem.
 */
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const UNIT = /^[a-z][a-z0-9@.-]{0,95}\.(service|timer|socket|target|path)$/;
/** Exactly the shape `docker/snapshot.sh` writes: `snap-YYYYmmdd-HHMMSS`. */
const SNAPSHOT_TAG = /^snap-[0-9]{8}-[0-9]{6}$/;
const CHANNEL = /^[0-9]{5,25}$/;

/** C0 controls plus DEL. Written as escapes; raw ones in source are unreadable. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** The same, minus tab, newline and carriage return — those survive in prose. */
const CONTROL_CHARS_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Ceiling on free-text fields, past which they are truncated, not rejected. */
const MAX_TEXT_CHARS = 2000;

/**
 * Anything with a separator, a traversal component, a NUL or a control
 * character is refused outright rather than stripped.
 *
 * Stripping is how you turn `....//` into `../`. If a field is wrong, say so
 * and stop.
 */
function rejectTraversal(field: string, value: string): string | null {
  if (value.includes('\u0000')) return `"${field}" contains a NUL byte`;
  if (value.includes('/') || value.includes('\\')) {
    return `"${field}" contains a path separator`;
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    return `"${field}" contains a traversal component`;
  }
  if (CONTROL_CHARS.test(value)) return `"${field}" contains a control character`;
  return null;
}

/**
 * Free text kept for logs and for the wake context.
 *
 * This is the only place attacker-influenced text is *retained*, and it is
 * retained precisely because it never reaches a command — it goes into the
 * journal and into a wake prompt. Control characters are stripped here rather
 * than rejected: a `reason` with a newline in it is not an attack, it is
 * someone writing a sentence, and failing a redeploy over formatting would
 * make the honest path annoying enough to route around.
 *
 * It is still not *safe* text. Anything that renders it later — the status
 * page, a Discord message — treats it as hostile on its own account.
 */
function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS_EXCEPT_WHITESPACE, ' ').slice(0, MAX_TEXT_CHARS).trim();
}

/**
 * Fields this schema knows. Anything else is reported, never acted on.
 *
 * Note what is deliberately NOT here: `requester`, `from`, `instanceName` or
 * any other way for a request to say who wrote it. Provenance is not a field,
 * because a field is something the author chooses. Since 2026-08-10 the
 * requester is the SPOOL DIRECTORY the file was found in — one per instance,
 * each bind-mounted into exactly one container — and it is stamped on in
 * spool.ts where the file's contents cannot reach it.
 *
 * A request that writes `"requester": "clawcius"` therefore lands in the
 * unknown-field list, is logged as ignored, and is still attributed to
 * whichever spool it was actually written into. The self-test asserts exactly
 * that, because "the attacker supplies their own identity" is the obvious way
 * to get this wrong and it would look correct in every log until it mattered.
 */
const KNOWN_FIELDS = new Set([
  'verb',
  'unit',
  'repo',
  'instance',
  'tag',
  'channel',
  'reason',
  'detail',
  // Tolerated and ignored: agents like to stamp their own requests, and
  // failing one because it carried a timestamp would teach them to stop
  // explaining themselves.
  'at',
  'id',
  'note',
]);

/** Printable-ASCII rendering of untrusted text for a log line. */
function forLog(value: string, max: number): string {
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

/**
 * Parse one request file's contents.
 *
 * Takes the raw string rather than a path: the caller has already enforced the
 * size cap and unlinked the file, and keeping IO out of here means the
 * validation is testable without a filesystem — which is most of what the
 * self-test exercises.
 */
export function parseRequest(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'must be a JSON object' };
  }

  const body = parsed as Record<string, unknown>;

  const rawVerb = body['verb'];
  if (typeof rawVerb !== 'string') return { ok: false, reason: 'missing "verb"' };
  if (!VERB_SET.has(rawVerb)) {
    // Naming the verb in the log matters: this line is what tells you whether
    // you are looking at a typo or at someone probing the surface.
    return {
      ok: false,
      reason:
        `unknown verb "${forLog(rawVerb, 40)}" — known verbs: ${VERBS.join(', ')}`,
    };
  }
  const verb = rawVerb as Verb;

  const unknownFields = Object.keys(body).filter((key) => !KNOWN_FIELDS.has(key));

  const request: OpsRequest = {
    verb,
    unit: '',
    repo: '',
    instance: '',
    tag: '',
    channel: '',
    reason: text(body['reason']),
    detail: text(body['detail']),
    unknownFields,
  };

  /** Pull one identifier field, shape-check it, refuse traversal. */
  const identifier = (
    field: 'unit' | 'repo' | 'instance' | 'tag' | 'channel',
    pattern: RegExp,
    required: boolean,
  ): string | null => {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      return required ? `${verb} requires "${field}"` : null;
    }
    if (typeof value !== 'string') return `"${field}" must be a string`;
    const traversal = rejectTraversal(field, value);
    if (traversal) return traversal;
    if (!pattern.test(value)) {
      return `"${field}" ("${forLog(value, 40)}") does not match ${String(pattern)}`;
    }
    request[field] = value;
    return null;
  };

  let error: string | null = null;
  switch (verb) {
    case 'restart':
      error = identifier('unit', UNIT, true);
      break;

    case 'pull':
      error = identifier('repo', IDENTIFIER, true);
      break;

    case 'redeploy':
    case 'snapshot':
    case 'checkin':
      error = identifier('instance', IDENTIFIER, true);
      break;

    case 'rollback':
      error = identifier('instance', IDENTIFIER, true) ?? identifier('tag', SNAPSHOT_TAG, false);
      break;

    case 'wake':
      error = identifier('channel', CHANNEL, true);
      if (!error && !request.detail) {
        error = 'wake requires "detail" — the prompt the woken agent receives';
      }
      break;
  }

  if (error) return { ok: false, reason: error };
  return { ok: true, request };
}

/** One-line rendering for the journal and for stdout. */
export function describeRequest(request: OpsRequest): string {
  const target =
    request.unit || request.instance || request.repo || request.channel || '(no target)';
  const tag = request.tag ? ` ${request.tag}` : '';
  return `${request.verb} ${target}${tag}`;
}
