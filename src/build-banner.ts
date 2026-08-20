/**
 * Say which code this is, on import, before anything else gets the chance to
 * stop it being said.
 *
 * ── Why this is a module and not two lines in index.ts ──────────────────────
 *
 * ES module bodies run in dependency order, and every import in `index.ts` is
 * evaluated before the first statement of `index.ts` itself. The first
 * statement of `index.ts` is `await main()`, whose own first statement is
 * `loadConfig()` — which throws on a missing environment variable or an
 * unreadable `agent-config.yaml`, and a config loader is exactly what dies in
 * the case this exists for: `clawcius-ops` failed to start 22,675 consecutive
 * times inside its config loader on a `dist/` that predated its own config, and
 * nothing escalated (Clawcius #89). A banner printed after that call would have
 * appeared zero of those 22,675 times.
 *
 * Being an import rather than two lines at the top of `index.ts` also puts it
 * ahead of every OTHER import, any of which could throw at load — which is
 * where the waker's own config used to throw, until #130 moved it into the
 * body. `./daemon.js` is one of those other imports as of #131, and it is
 * imported second: everything the program is made of is evaluated after this
 * line has been printed.
 *
 * So this is imported FIRST, it depends on nothing but the generated constant,
 * and it prints as a side effect. The line comes out of a process that is about
 * to fail, which is the only version of it that is worth having.
 *
 * ── Why there are three near-identical copies of this file ──────────────────
 *
 * One per package. Each of `.`, `status/` and `ops/` has its own tsconfig with
 * `rootDir: src`, no cross-package imports and no shared compilation unit, so
 * there is nowhere for a common module to live without restructuring all three
 * builds. The thing that is genuinely shared — how the sha, the branch, the
 * dirty flag and the reason are turned into one sentence — lives in exactly one
 * place, `scripts/build-info.mjs`, and is baked into the constant this reads.
 * What is copied is the prefix and the decision of which stream to use.
 *
 * ── stdout or stderr ────────────────────────────────────────────────────────
 *
 * A build that names its commit over a clean tree is routine, and goes to
 * stdout. A dirty or unknown build is a claim that cannot be checked against
 * `git rev-parse` and goes to stderr, so that it is separable in the journal
 * from the ordinary case. Neither ever throws and neither ever exits: a service
 * that will not boot because it cannot name itself is worse than one that boots
 * saying "unknown".
 */

import { BUILD_INFO } from './build-info.js';

const line = `[clawcius] build ${BUILD_INFO.line}\n`;

if (BUILD_INFO.commit === null || BUILD_INFO.dirty !== false) {
  process.stderr.write(line);
} else {
  process.stdout.write(line);
}
