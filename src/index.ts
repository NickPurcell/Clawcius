// FIRST, and it must stay first: importing it prints which commit this artefact
// was built from before anything that can throw at startup runs.
import { BUILD_INFO } from './build-info.js';

import { main } from './daemon.js';

const line = `[clawcius] build ${BUILD_INFO.line}\n`;

if (BUILD_INFO.commit === null || BUILD_INFO.dirty !== false) {
  process.stderr.write(line);
} else {
  process.stdout.write(line);
}

await main();
