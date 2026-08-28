import { BUILD_INFO } from './build-info.js';

const line = `[clawcius] build ${BUILD_INFO.line}\n`;

if (BUILD_INFO.commit === null || BUILD_INFO.dirty !== false) {
  process.stderr.write(line);
} else {
  process.stdout.write(line);
}
