/**
 * Reads a required environment variable, throwing if it is absent or empty.
 *
 * Call this from a composition root at module scope, never inside a handler.
 * A missing variable then kills the container on cold start rather than
 * failing an arbitrary invocation later, which is far easier to diagnose.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}
