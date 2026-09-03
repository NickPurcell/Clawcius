/**
 * Running the Claude login under a pseudo-terminal, and reading the authorize
 * URL out of what it draws.
 *
 * `claude setup-token` writes nothing to a pipe: with no terminal it produces
 * no output and never returns. `script` supplies one, because the daemon has no
 * controlling terminal of its own to lend, and `-t` on the exec supplies the
 * second one inside the container. Stdin written to `script` reaches the
 * command inside it.
 */

/**
 * The authorize URL as it appears in the drawn output.
 *
 * The visible URL is soft-wrapped to the terminal width and emitted a chunk per
 * line, so matching `https://\S+` against the de-escaped text yields a prefix
 * that reads as a whole URL. The hyperlink escape carries it intact.
 *
 * OSC 8 is `ESC ] 8 ; <params> ; <uri> ST`, where the terminator is BEL or
 * `ESC \`. Requiring it is what keeps a read that ends mid-escape from
 * returning a prefix — which is the same truncated URL by another route.
 */
const OSC8_URI = /\x1b\]8;[^;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;

/** Every distinct hyperlink target in `output`, in the order first seen. */
export function hyperlinks(output: string): string[] {
  const seen = new Set<string>();
  for (const match of output.matchAll(OSC8_URI)) {
    const uri = match[1];
    if (uri !== undefined) seen.add(uri);
  }
  return [...seen];
}

/** The authorize URL, or null if the output does not carry a whole one yet. */
export function authorizeUrl(output: string): string | null {
  return hyperlinks(output).find((uri) => uri.includes('/oauth/authorize')) ?? null;
}

/** Single-quote for `sh -c`, which is what `script -c` hands its string to. */
function shellQuote(word: string): string {
  return `'${word.split("'").join(`'\\''`)}'`;
}

/**
 * Wrap a command so it runs with a terminal attached.
 *
 * `-q` suppresses the transcript header, `-e` returns the command's own exit
 * status, and the typescript goes to /dev/null because the capture that matters
 * is this process reading stdout.
 */
export function ptyArgv(command: readonly string[]): { file: string; args: string[] } {
  return { file: 'script', args: ['-qec', command.map(shellQuote).join(' '), '/dev/null'] };
}
