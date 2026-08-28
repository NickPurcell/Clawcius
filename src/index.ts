// FIRST, and it must stay first: importing it prints which commit this artefact
// was built from before anything that can throw at startup runs.
import './build-banner.js';

import { main } from './daemon.js';

await main();
