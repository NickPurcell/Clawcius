# OJ instructions for NickPurcell/Clawcius

Read by OJ from this repository's base branch and handed to the reviewer inside
`<repo-instructions>`. Nothing in a pull request can change what the reviewer
sees here.

## What this repository is

A Discord-driven system of long-lived Claude Code agents ("crews"). `src/` is the
waker; `discord-cli/`, `browser-cli/`, `gws-cli/`, `pr-cli/` are the tools the
agents run inside their containers; `status/` is the Clawsky observability page;
`docker/`, `squid/`, `systemd/` deploy it. The authors of most pull requests are
the agents themselves. `ops/` is being removed; do not accept changes that extend
it.

## Comments

A comment describes what the code beside it does, or the invariant that code
relies on. That is the whole job. A comment is not about a previous version of
the code, a previous version of itself, the review that produced the change, or
the conversation with the reviewer — and it never answers the reviewer. A
comment that exists to justify a line to a reader who questioned it is deleted
along with the question. This applies in tests, in YAML, in systemd units and
in shell scripts exactly as it does in TypeScript.

A tool description string (the `description:` passed to `tool()` in
`src/*-tool.ts`) says the arguments, the result, and the one non-obvious
constraint. Policy belongs in the system prompt, once.

## Words that do not belong in a comment

`#` followed by digits, a `2026-` date, `round`, `finding`, `draft`,
`earlier version`, `used to`, `until`, `measured`, `verified`, `I `, a
`file.ts:NNN` reference into this repository, a quotation of the operator, or
any sentence addressed to whoever reviewed the change. Each occurrence is a
blocking finding under *unmaintainability*; the fix is deletion, not rewording.

## Tests

`npm test` runs `test/*.test.js` and `status/test/*.js`. A test in those files
must fail when the behaviour it names breaks and pass when any string changes.
Blocking, specifically here:

- asserting the count or presence of a phrase in `agent-config.base.yaml` or in
  any `systemPrompt`/`prompts` value — the loader already refuses unknown
  `{{placeholders}}`, and that is the whole property;
- regexing a tool `description`, a `!status` reply, a log line, or a refusal
  message;
- reading `src/`, `dist/`, `docker/`, `systemd/` or `package.json` with a regex
  to assert a constant, an import order, or that a name is absent;
- a real `setTimeout` sleep;
- a test that exists to keep an in-code copy of a YAML value in sync — delete
  the copy instead.

The Python suites under `browser-cli/`, `discord-cli/`, `vidbot/` do not run in
CI. A pull request touching those directories states how its tests were run.

## Documents

`README.md`, `SETUP.md`, `status/README.md`, `squid/README.md`,
`browser-cli/README.md`, `discord-cli/README.md`, `pr-cli/README.md`,
`gws-cli/README.md` describe the current system and nothing else. A pull
request that changes a behaviour one of them describes updates it in the same
pull request. A pull request that removes a behaviour removes every sentence
about it. No document gains a section whose subject is the past.

## Configuration

`agent-config.base.yaml` holds the system prompt; instance files hold `crew`,
`displayName` and channel ids and nothing else. A new key in any YAML, `.env`,
or systemd unit needs a reader in the same pull request; grep for it. A key
whose only value in every shipped config is the default is a finding.

## Deployment

Files under `systemd/` and `docker/` are what runs. A pull request that changes
one says which host action installs it (`systemctl daemon-reload`, image
rebuild, container recreate) in its description. A root-executed script may not
be group- or world-writable.
