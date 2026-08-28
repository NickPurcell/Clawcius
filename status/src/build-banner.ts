import { BUILD_INFO } from './build-info.js';

const line = `[status] build ${BUILD_INFO.line}\n`;

if (BUILD_INFO.commit === null || BUILD_INFO.dirty !== false) {
  process.stderr.write(line);
} else {
  process.stdout.write(line);
}
