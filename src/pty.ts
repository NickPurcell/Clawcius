/**
 * Running the Claude login under a pseudo-terminal, and reading the authorize
 * URL back out of what it draws.
 *
 * `claude setup-token` writes nothing at all to a pipe: with `docker exec -i`
 * and no terminal it produces no output and never returns. Under a pty it runs
 * a full-screen interface and prints the URL. `claude auth login --claudeai` is
 * line-oriented and works either way, so the pty path serves both and which one
 * runs is a config value.
 *
 * `script` supplies the terminal. The daemon has no controlling terminal of its
 * own, so `docker exec -it` refuses on its own; `script` allocates one, and
 * what is written to `script`'s stdin reaches the command inside it.
 */

import { spawn as nodeSpawn } from 'node:child_process';

/**
 * The authorize URL as it appears in the drawn output.
 *
 * The visible URL is soft-wrapped to the terminal width and emitted as a chunk
 * per line, so matching `https://\S+` against the de-escaped text yields a
 * prefix that looks like a whole URL. The hyperlink escape carries it intact
 * and is repeated on every wrapped line, which is why this reads that instead.
 *
 * OSC 8 is `ESC ] 8 ; <params> ; <uri> BEL`, and the closing sequence has an
 * empty uri, which is why the match requires one character.
 */
const OSC8_URI = /\x1b\]8;[^;]*;([^\x07\x1b]+)/g;

/** Every distinct hyperlink target in `output`, in the order first seen. */
export function hyperlinks(output: string): string[] {
  const seen = new Set<string>();
  for (const match of output.matchAll(OSC8_URI)) {
    const uri = match[1];
    if (uri !== undefined) seen.add(uri);
  }
  return [...seen];
}

/** The authorize URL, or null if the output does not carry one yet. */
export function authorizeUrl(output: string): string | null {
  return hyperlinks(output).find((uri) => uri.includes('/oauth/authorize')) ?? null;
}

/**
 * Wrap a command so it runs with a terminal attached.
 *
 * `-q` suppresses the transcript header, `-e` returns the command's own exit
 * status, and the typescript goes to /dev/null because the capture that matters
 * is this process reading stdout.
 */
export function ptyArgv(command: readonly string[]): { file: string; args: string[] } {
  return { file: 'script', args: ['-qec', command.join(' '), '/dev/null'] };
}

/** The part of `ChildProcess` this uses, so a test can substitute one. */
export type PtyProcess = {
  stdout: { on: (event: 'data', listener: (chunk: unknown) => void) => unknown } | null;
  stderr: { on: (event: 'data', listener: (chunk: unknown) => void) => unknown } | null;
  stdin: { write: (chunk: string) => unknown } | null;
  once: (event: string, listener: (...args: never[]) => void) => unknown;
  kill: (signal?: NodeJS.Signals) => unknown;
};

export type PtySpawner = (file: string, args: readonly string[]) => PtyProcess;

export const defaultPtySpawner: PtySpawner = (file, args) =>
  nodeSpawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as PtyProcess;
