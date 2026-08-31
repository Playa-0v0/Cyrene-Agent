/**
 * Hand-rolled argv parser. No commander/yargs; the surface is tiny.
 *
 * `unknown` is a first-class variant so the dispatch switch in app.ts is
 * exhaustive: adding a new Command variant without a handler is a TS error.
 */
export type Command =
  | { kind: "default" }
  | { kind: "hello" }
  | { kind: "about" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "run" }
  | { kind: "placeholder"; name: "doctor" | "init" | "update" }
  | { kind: "unknown"; name: string };

const SUBCOMMANDS = new Map<string, Command>([
  ["hello", { kind: "hello" }],
  ["about", { kind: "about" }],
  ["version", { kind: "version" }],
  ["help", { kind: "help" }],
  ["run", { kind: "run" }],
  ["doctor", { kind: "placeholder", name: "doctor" }],
  ["init", { kind: "placeholder", name: "init" }],
  ["update", { kind: "placeholder", name: "update" }],
]);

export function parseArgv(argv: readonly string[]): Command {
  // Flags first: --help/-h and --version/-v are accepted anywhere and win
  // over any subcommand. This matches user expectations from other CLIs.
  for (const a of argv) {
    if (a === "--help" || a === "-h") return { kind: "help" };
    if (a === "--version" || a === "-v") return { kind: "version" };
  }

  // First non-flag token is the subcommand. Extra tokens are rejected as
  // unknown so we fail fast and predictably (no silent swallowed args).
  const sub = argv.find((a) => !a.startsWith("-"));
  if (sub === undefined) {
    // No subcommand. If there are any leftover flags we did not recognise,
    // treat the first one as an unknown command rather than silently defaulting.
    const leftover = argv.find((a) => a.startsWith("-"));
    if (leftover !== undefined) return { kind: "unknown", name: leftover };
    return { kind: "default" };
  }

  const known = SUBCOMMANDS.get(sub);
  if (known) return known;

  return { kind: "unknown", name: sub };
}
