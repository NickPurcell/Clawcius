import { execFile } from 'node:child_process';

const underSystemd = Boolean(process.env['NOTIFY_SOCKET']);
let warnedUnavailable = false;
let failures = 0;

function notify(...assignments: string[]): void {
  if (!underSystemd) return;

  execFile('systemd-notify', assignments, { timeout: 2000 }, (error) => {
    if (!error) {
      failures = 0;
      return;
    }
    failures += 1;

    // Once, then every tenth failure.
    if (!warnedUnavailable || failures % 10 === 0) {
      warnedUnavailable = true;
      process.stderr.write(
        `[systemd] notify failed x${failures} (${error.message.split('\n')[0]}) ` +
          `for ${assignments.join(' ')}. Watchdog pings are not reaching systemd; ` +
          'expect a kill and restart.\n',
      );
    }
  });
}

export const systemd = {
  /** Startup finished. Required for `Type=notify`, or the unit never leaves `activating`. */
  ready(): void {
    notify('READY=1');
  },

  /** Pet the watchdog. Call at strictly less than WatchdogSec / 2. */
  watchdog(): void {
    notify('WATCHDOG=1');
  },

  /** One-line status shown by `systemctl status`. */
  status(text: string): void {
    // Newlines would split this into extra assignments.
    notify(`STATUS=${text.replace(/\n/g, ' ')}`);
  },

  stopping(): void {
    notify('STOPPING=1');
  },

  /** Watchdog interval in ms, or null when unset. */
  get watchdogIntervalMs(): number | null {
    const usec = process.env['WATCHDOG_USEC'];
    if (!usec) return null;
    const parsed = Number(usec);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  },
};
