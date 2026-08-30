# pr-cli

Answers the questions agents actually have about a pull request, rather than the
fields that resemble them.

```sh
/srv/clawcius/current/pr-cli/pr-state 207
/srv/clawcius/current/pr-cli/pr-state 207 --repo NickPurcell/OJ --json
```

```
NickPurcell/Clawcius#240  head d94561f5

  merged?                        no
  review round                   FINISHED  since 2026-08-24T10:41:41Z
  review saw this code?          PARTLY — reviewed an ancestor; commits since it are unreviewed
                                 round 1 read c1d6f540
  can it merge?                  clean — nothing GitHub blocks on — but of 1 approval(s): 1 STALE, for a commit no longer at the head. None covers this head, so merging now merges code no review has read (dismiss_stale_reviews_on_push is false, so GitHub still counts it)
                                 (mergeable: true — only says git can combine the trees; not the question)
  approval                       osmosis-jones-agent[bot] at 2026-08-24T10:41:41Z — STALE: approved c1d6f540, head is d94561f5
                                 dismiss_stale_reviews_on_push is FALSE — GitHub still counts the stale one
  ruleset                        OJ1: 1 approval(s), 0 bypass actor(s)
```

## Why this exists

On 2026-08-23 four agents read five different fields that were **true**, that
they read **correctly**, and that answered a question adjacent to the one they
had (Clawcius #216). Between them: about two hours investigating an intruder
that turned out to be the author's own tooling, one wasted review round, one
nearly-published set of fixes for things that were not broken, and one
unnecessary chase.

A reference table would have covered those five. The sixth field will mislead
the same way — and nobody consults a table before reading a value that has
already given them a confident answer, which is the same reason these terminate
a search. A document that only works if you doubt yourself first does not work.

The heuristic, kept here and in the source header rather than in a document:

> A field that could **not** answer your question would have returned nothing
> and sent you looking. The dangerous ones are the ones that **do** answer —
> plausibly, right type, right shape — because a confident answer terminates the
> search. "I got a clean answer" is the moment to be suspicious, not the moment
> to stop.

## What it asks, and the field that looks like the answer

| question | the lookalike, and why it is not |
|---|---|
| is a round queued / running / finished / declined | **not** "an OJ comment exists" — the acknowledgement *is* a comment, posted about a second after pickup. **not** `labels: []` — OJ consumes the label at pickup, so absence means queued-and-taken *or* running, never "nobody asked" |
| did the review see **this** code | the footer sha is the only place a round names the commit it read, and it falls outside the 1200-character window `watchPr` mail truncates at — in 4 of 4 rounds measured (OJ#23). `EXACT` / `ANCESTOR` / `VOID` / `UNKNOWN` |
| can it merge, and if not why | **not** `mergeable`, which only says git can combine the trees. It was `true` on #207 for the whole time that PR was `blocked` |
| is an approval still valid | `dismiss_stale_reviews_on_push` is false on ruleset OJ1, so GitHub keeps counting an approval after the branch moves. "Approved" and "somebody approved this code" are different claims and only the first is a field |

It prints the misleading field **next to** the answer rather than suppressing
it. Someone will read `mergeable` anyway — from the API, the UI, or habit — and
the useful moment is when both are on screen together.

## Running it

Node 22+, no dependencies, nothing installed. Reads through bare `curl`, which
the daemon has already authenticated via netrc.

This directory is bind-mounted **read-only** into every agent container. The
tool writes nothing anywhere: no cache, no temp file, no log, and it needs no
scratch space. From a working directory that is not a clone it reports the
sha question as `UNKNOWN` rather than crashing, which is the normal case for an
agent.

`pr-state` is a launcher and `pr-state.mjs` is the implementation, the same
split as `discord-cli/discord`. The extension is on the module because ESM needs
one to import; the bare name matches `discord`, `gdoc` and `browse`.

## Tests

`test/pr-state.test.js`, run by `npm test` with the rest of the suite. They are
offline — the two impure edges, `curl` and `git merge-base`, are injected or
absent.

Every case named in them is a mistake somebody actually made, including two of
this tool's own: reporting `RUNNING` for a finished round, and `FINISHED` for a
live one. The second is the dangerous direction, because it invites acting on
findings nobody has written.
