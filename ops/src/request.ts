/**
 * Parsing and validating ops requests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE CHANGING ANYTHING IN THIS FILE.
 *
 * The spool is written by an agent that may be prompt-injected, and read by a
 * root process holding docker and systemctl. That sentence used to end with
 * "and this file is where the boundary is enforced". Since 2026-08-10 it does
 * not, and the change is worth stating rather than discovering.
 *
 * ── What changed, and what did not ───────────────────────────────────────
 *
 * The closed verb list is gone. `restart`, `pull`, `redeploy` and `snapshot`
 * have been deleted, and `task` — a free-text description of what needs doing,
 * handed to a Claude Code session on the host with a shell — has replaced all
 * of them. The reasoning is in ops/src/host-agent.ts and in ops/README.md; the
 * short version is that a closed set can only contain what somebody imagined in
 * advance, and every gap in it turned the operator into the agent's hands.
 *
 * So this file no longer decides what may happen. It cannot: `task` carries
 * prose, and prose has no allowlist. What it still does, and still must:
 *
 *   **Structural rejection, not repair.** Malformed JSON is discarded whole.
 *   Nothing salvages the parseable prefix of a broken file and nothing coerces
 *   types. A number where a string belongs is a reject.
 *
 *   **Identifiers are still lookups, not values.** `instance` and `tag` are
 *   shape-checked here and matched by exact equality against config in the
 *   executor, and what reaches a command is the config entry. That rule is
 *   unchanged for the verbs that still take an identifier, because those verbs
 *   still build argv arrays out of them.
 *
 *   **Traversal and control bytes are refused, not stripped.** Stripping is how
 *   `....//` becomes `../`. Still checked on identifiers even though they are
 *   never used as paths, because "never used as paths" is a property of today's
 *   call graph.
 *
 *   **Free text is retained, capped and never executed.** `task`, `reason` and
 *   `detail` are the only fields that reach anything as *content*, and the
 *   thing they reach is a model's prompt. That is not a shell and it is not
 *   safer than one — it is the deal the operator accepted with his eyes open.
 *
 * The one thing this file must never be talked into growing is a way for the
 * request to say who filed it. Provenance is the spool directory. See
 * KNOWN_FIELDS.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * What a request may be. Four things, and three of them are plumbing.
 *
 * `task` is the whole feature: free text, handed to the host agent. The other
 * three survived the cull of 2026-08-10 for reasons that are individually
 * boring and collectively the point — none of them is a capability the host
 * agent would do better, and two of them must keep working when the host agent
 * does not.
 *
 * **`checkin`** — kept, and it could not have been dropped. It is the answer to
 * a question the executor asked: a destructive task arms a deadline and rolls
 * the instance back on silence. It runs no command, it is answered inline
 * without taking the lock, and it has to work when the instance that is
 * answering has just been rebuilt and may be barely alive. Routing it through a
 * model would make the recovery path depend on the thing being recovered.
 *
 * **`rollback`** — kept, and deliberately NOT delegated. It is the undo, and
 * the undo is now the safety property that replaced the verb list: "whatever it
 * does can be undone" is worth nothing if undoing is itself a natural-language
 * task run by the same machinery that just broke something. It is a fixed argv
 * — retag an image, recreate a container — and the automatic deadline path
 * calls the same code, so it exists whether or not it is exposed.
 *
 * **`wake`** — kept because it is not a privilege at all. It relays a wake into
 * the waker's own spool, which the agent can already write; it runs no command
 * and grants nothing. Deleting it would remove a documented capability in
 * exchange for nothing.
 *
 * Deleted: `restart`, `pull`, `redeploy`, `snapshot`. Every one of them is a
 * sentence a task can say, and each was an argument allowlist to maintain.
 * `snapshot` in particular is not gone as a *behaviour* — every task now takes
 * one before it starts, which is strictly more than a verb nobody remembered to
 * call.
 */
export const VERBS = ['task', 'checkin', 'rollback', 'wake'] as const;

export type Verb = (typeof VERBS)[number];

const VERB_SET: ReadonlySet<string> = new Set<string>(VERBS);

/**
 * Verbs that can take an instance off the air.
 *
 * These wait for an idle turn, arm a check-in deadline and are refused while
 * the breaker is frozen. `task` is on the list unconditionally and that is not
 * a judgement about any particular task: the executor cannot know what a
 * sentence will turn out to mean, and the only safe reading of "unknown" is the
 * same one the idle check uses for a missing waker status file — treat it as
 * the dangerous case.
 */
export const DESTRUCTIVE_VERBS: ReadonlySet<Verb> = new Set<Verb>(['task', 'rollback']);

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
  /**
   * What needs doing, in words, for `task`.
   *
   * The only field in this system whose content is *acted on* rather than
   * matched against a list. It reaches a model's prompt and nothing else — it
   * is never a path, never an argv element, never interpolated into anything.
   * Capped at MAX_TASK_CHARS and stripped of control characters, which is
   * hygiene for the journal rather than a security control: there is no
   * security control available here and pretending otherwise would be worse
   * than saying so.
   */
  task: string;
  /**
   * Instance the request concerns. Required by `checkin` and `rollback`,
   * OPTIONAL on `task` — and the default when it is absent is the expensive,
   * safe one. See the executor: a task that names an instance has that one
   * snapshotted, idle-waited and health-checked; a task that names none gets
   * every configured instance, because "which containers might this sentence
   * disturb" has no answer and the fail-safe reading of no answer is "all of
   * them".
   */
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
 * Deliberately tighter than the set they select from. `instances:` in the
 * config is still the real gate for the fields that reach a command — this is a
 * cheap structural filter in front of it so garbage is rejected with a precise
 * reason instead of failing an equality test and being reported as "not
 * allowed", which reads like a config problem.
 *
 * Note that these now guard only `instance`, `tag` and `channel`. The task text
 * has no pattern and cannot have one; that field is prose by design.
 */
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
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
 * Ceiling on the task itself. Larger, because a task is the payload now.
 *
 * Still bounded, and bounded well under `limits.maxRequestBytes` so the spool's
 * stat-before-open cap is the first thing that says no. A task that needs more
 * than this many characters is a task that should have been three tasks.
 */
const MAX_TASK_CHARS = 8000;

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
function text(value: unknown, max: number = MAX_TEXT_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS_EXCEPT_WHITESPACE, ' ').slice(0, max).trim();
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
  'task',
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
    task: text(body['task'], MAX_TASK_CHARS),
    instance: '',
    tag: '',
    channel: '',
    reason: text(body['reason']),
    detail: text(body['detail']),
    unknownFields,
  };

  /** Pull one identifier field, shape-check it, refuse traversal. */
  const identifier = (
    field: 'instance' | 'tag' | 'channel',
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
    case 'task':
      // The instance is optional and the task text is not. An empty task is
      // rejected rather than handed to a model to interpret, because "do
      // something" filed against a root shell is the request most likely to be
      // an accident and least likely to be what anybody wanted.
      error = identifier('instance', IDENTIFIER, false);
      if (!error && !request.task) {
        error =
          'task requires "task" — a sentence or two saying what needs doing. It is handed ' +
          'to a Claude Code session on the host; write it for a colleague, not for a parser.';
      }
      break;

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

/**
 * One-line rendering for the journal and for stdout.
 *
 * A task is summarised by its first line, squeezed and clipped, because the
 * journal's prose lines are read in a terminal during an incident and an
 * eight-thousand-character `what` field makes `journalctl` useless at the
 * moment it is needed. The full text is in the `detail` of the request entry
 * and in the audit, both of which are complete.
 */
export function describeRequest(request: OpsRequest): string {
  if (request.verb === 'task') {
    const first = request.task.split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
    const clipped = first.length > 80 ? `${first.slice(0, 80)}…` : first;
    return `task ${request.instance ? `${request.instance}: ` : ''}${clipped || '(empty)'}`;
  }
  const target = request.instance || request.channel || '(no target)';
  const tag = request.tag ? ` ${request.tag}` : '';
  return `${request.verb} ${target}${tag}`;
}
