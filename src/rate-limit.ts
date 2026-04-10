/**
 * Rate-limit detection for Claude CLI error messages.
 *
 * A single helper used in two places:
 * - `Runner.execute()` retry loop — applies a 10× backoff multiplier when a
 *   rate-limit is detected, so we don't hammer the API mid-429.
 * - `ClaudeStreamParser.handleError()` — prefixes stream errors with
 *   `rate_limit:` so downstream code (retry loop, history, notifier) can
 *   distinguish rate-limits from generic failures.
 *
 * Keeping both consumers on the same regex prevents classification drift —
 * an error that triggers the stream parser's prefix must also trigger the
 * retry loop's backoff, and vice versa.
 *
 * Note: Not used by the caila-mode HTTP-status check (which works on
 * `res.status === 429`) or by `history.getConsecutiveRateLimits()` (which
 * scans historical DB rows for a slightly broader pattern including
 * "overloaded"). Those are separate concerns.
 */
export function isRateLimitMessage(s: string): boolean {
  return /rate.?limit|429|too many requests/i.test(s);
}
