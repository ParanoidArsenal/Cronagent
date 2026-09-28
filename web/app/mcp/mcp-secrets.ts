/**
 * Helpers for keeping MCP server env values (tokens, API keys) out of
 * responses and client-rendered props.
 *
 * Values are replaced with MCP_ENV_MASK; keys are kept so the UI can still
 * show which variables are configured. On update, any submitted value equal
 * to MCP_ENV_MASK means "keep the stored value".
 */

export const MCP_ENV_MASK = '••••••';

/** Replace every env value with the mask sentinel, keeping keys. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(env).map((key) => [key, MCP_ENV_MASK]));
}

/** Return a copy of an MCP server record with env values masked. */
export function redactMcpServer<T extends { env: Record<string, string> }>(server: T): T {
  return { ...server, env: redactEnv(server.env) };
}

/**
 * Resolve masked values in a submitted env against the stored env.
 * Returns the merged env, plus the keys that were masked but have no stored
 * value (the caller should reject those rather than persist the mask).
 */
export function restoreMaskedEnv(
  submitted: Record<string, string>,
  stored: Record<string, string>,
): { env: Record<string, string>; unresolved: string[] } {
  const env: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [key, value] of Object.entries(submitted)) {
    if (value !== MCP_ENV_MASK) {
      env[key] = value;
    } else if (Object.prototype.hasOwnProperty.call(stored, key)) {
      env[key] = stored[key];
    } else {
      unresolved.push(key);
    }
  }
  return { env, unresolved };
}
