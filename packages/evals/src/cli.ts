import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when this module is the file node was asked to run, so a script can
 * export its pieces for unit tests without executing on import.
 */
export function isEntrypoint(moduleUrl: string, argv = process.argv): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entry))
    );
  } catch {
    return false;
  }
}

/** Exit code 1 with a readable message; stack traces are noise in a CLI. */
export function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[evals] ${message}\n`);
  process.exit(1);
}
