/**
 * sd_notify, via the `systemd-notify` binary.
 *
 * Node cannot do this natively. The notify socket is a SOCK_DGRAM unix socket:
 * `node:dgram` only supports udp4/udp6, and `node:net` only does SOCK_STREAM
 * for unix paths, so neither can speak to it. An earlier version of this file
 * called `dgram.createSocket('unix_dgram')` behind a TypeScript cast — it
 * compiled and threw ERR_SOCKET_BAD_TYPE at runtime, taking the bot down with
 * it. Shelling out to systemd's own helper is the honest way to do this.
 *
 * The helper sends from its own PID rather than the service's MainPID, so the
 * unit must set `NotifyAccess=all`.
 *
 * Every call here is best-effort. Telemetry must never be able to kill the
 * process it is reporting on — which is exactly what the previous version did.
 */

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

    // Warning exactly once was hiding the worst case. Every watchdog ping goes
    // through here, so if this starts failing -- fork failures under memory
    // pressure, systemd-notify missing after an upgrade -- the pings stop,
    // systemd kills the service, and with Restart=always it looks like a
    // spontaneous restart with no cause in the journal. Warn on the first, then
    // periodically, so a sustained outage stays visible without flooding it.
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

  /**
   * Watchdog interval in ms, or null when unset.
   * systemd exports WATCHDOG_USEC in microseconds.
   */
  get watchdogIntervalMs(): number | null {
    const usec = process.env['WATCHDOG_USEC'];
    if (!usec) return null;
    const parsed = Number(usec);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  },
};
