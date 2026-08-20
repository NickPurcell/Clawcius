/**
 * Clawcius — wakes a containerised Claude Code agent on Discord mentions.
 *
 * THE ENTRY POINT, and as of Clawcius #131 only that. The program is `main()`
 * in daemon.ts, alongside the handlers it wires; this file exists to print the
 * banner and call it.
 *
 * The split is not tidying. A module body runs when the module is imported, so
 * while the program lived here the whole Discord handler was unreachable by a
 * test — importing it started a bot. #133 removed the same coupling one layer
 * down and named the convention this completes: config is loaded by a function
 * the entry point calls, and an entry point's body is a `main()` whose handlers
 * are exported. See the header of daemon.ts for why this is a second file
 * rather than a `if (this module is argv[1])` guard at the bottom of one.
 *
 * Nothing about startup moved. `main()` calls `loadConfig()` as its first
 * statement and `await main()` is the first statement here, so a waker with no
 * DISCORD_TOKEN still dies during startup with the same message, after the
 * banner below.
 */

// FIRST, and it must stay first. This prints which commit this artefact was
// built from, as a side effect of being imported. The startup that follows can
// die before it says anything — `loadConfig()` throws on a missing environment
// variable or an unreadable agent-config.yaml, and `preflight()` throws on a
// container stack that is not up — so anything printed later would be lost in
// precisely the cases worth reporting. Being an import rather than two lines
// in this body is what puts it ahead of every other import too, any of which
// could in principle throw at load. See build-banner.ts.
import './build-banner.js';

import { main } from './daemon.js';

await main();
