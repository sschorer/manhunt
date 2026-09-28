/**
 * How the release checks talk: one line per step, one line per thing that held.
 *
 * Both checks are read from a CI log far more often than they are run by hand, so
 * every assertion prints what it proved rather than only what it compared.
 */

/** Announce the part of the check that follows. */
export function step(message: string): void {
  console.log(`\n── ${message}`);
}

/** Stop the check, with the reason as the failure. */
export function fail(message: string): never {
  throw new Error(message);
}

/** Assert, and say what held. `message` reads as the thing that is true. */
export function check(condition: unknown, message: string): void {
  if (!condition) fail(message);
  note(message);
}

/** Report something that got this far without failing; there is nothing left to assert. */
export function note(message: string): void {
  console.log(`   ok — ${message}`);
}
