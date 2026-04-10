/**
 * Unit tests for the pure formatting utilities in web/lib/format.ts.
 *
 * Covered exports:
 *   - formatTokens(n: number): string
 *   - formatDuration(ms: number): string
 *
 * No external dependencies — no mocking required.
 */

import { describe, it, expect } from 'vitest';
import { formatTokens, formatDuration } from '../web/lib/format.ts';

// ── formatTokens ──────────────────────────────────────────────────────────────

describe('formatTokens()', () => {
  // ── Zero ──────────────────────────────────────────────────────────────────

  it('returns "0" for 0', () => {
    expect(formatTokens(0)).toBe('0');
  });

  // ── Small numbers (below 1 000) ───────────────────────────────────────────

  it('returns the number as a plain string for small values (500 → "500")', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('returns "1" for 1', () => {
    expect(formatTokens(1)).toBe('1');
  });

  it('returns "999" for 999 (just below the K boundary)', () => {
    expect(formatTokens(999)).toBe('999');
  });

  // ── K range (1 000 – 999 999) ─────────────────────────────────────────────

  it('returns "1.0K" for 1000 (exact K boundary)', () => {
    expect(formatTokens(1000)).toBe('1.0K');
  });

  it('returns "1.5K" for 1500', () => {
    expect(formatTokens(1500)).toBe('1.5K');
  });

  it('returns "10.0K" for 10000', () => {
    expect(formatTokens(10000)).toBe('10.0K');
  });

  it('returns "999.9K" for 999900 (just below the M boundary)', () => {
    expect(formatTokens(999900)).toBe('999.9K');
  });

  it('returns "999999" for 999999 — wait, 999999 >= 1000 so it returns "1000.0K"', () => {
    // 999999 / 1000 = 999.999 → toFixed(1) → "1000.0"
    expect(formatTokens(999999)).toBe('1000.0K');
  });

  // ── M range (>= 1 000 000) ────────────────────────────────────────────────

  it('returns "1.0M" for 1000000 (exact M boundary)', () => {
    expect(formatTokens(1000000)).toBe('1.0M');
  });

  it('returns "2.5M" for 2500000', () => {
    expect(formatTokens(2500000)).toBe('2.5M');
  });

  it('returns "10.0M" for 10000000', () => {
    expect(formatTokens(10000000)).toBe('10.0M');
  });

  // ── Boundary precision ────────────────────────────────────────────────────

  it('returns a string (not a number) for all boundary values', () => {
    for (const n of [999, 1000, 999999, 1000000]) {
      expect(typeof formatTokens(n)).toBe('string');
    }
  });

  // ── Negative numbers ──────────────────────────────────────────────────────
  // The source uses >= comparisons, which are always false for negative numbers,
  // so all negative inputs fall through to String(n) — no K/M suffix is applied.

  it('returns the plain string for a large negative number (-1500000)', () => {
    expect(formatTokens(-1500000)).toBe('-1500000');
  });

  it('returns the plain string for a negative number in the K range (-1500)', () => {
    expect(formatTokens(-1500)).toBe('-1500');
  });

  it('returns the plain string for a small negative number (-500)', () => {
    expect(formatTokens(-500)).toBe('-500');
  });

  it('returns "-1" for -1', () => {
    expect(formatTokens(-1)).toBe('-1');
  });
});

// ── formatDuration ────────────────────────────────────────────────────────────

describe('formatDuration()', () => {
  // ── Milliseconds range (< 1 000 ms) ──────────────────────────────────────

  it('returns "0ms" for 0 milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('returns "1ms" for 1 millisecond', () => {
    expect(formatDuration(1)).toBe('1ms');
  });

  it('returns "999ms" for 999 milliseconds (just below the second boundary)', () => {
    expect(formatDuration(999)).toBe('999ms');
  });

  it('returns "500ms" for 500 milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  // ── Seconds range (1 000 ms – 59 999 ms) ─────────────────────────────────

  it('returns "1.0s" for 1000 milliseconds (exact second boundary)', () => {
    expect(formatDuration(1000)).toBe('1.0s');
  });

  it('returns "1.5s" for 1500 milliseconds', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  it('returns "10.0s" for 10000 milliseconds', () => {
    expect(formatDuration(10000)).toBe('10.0s');
  });

  it('returns "59.9s" for 59900 milliseconds (just below the minute boundary)', () => {
    expect(formatDuration(59900)).toBe('59.9s');
  });

  it('returns "59.0s" for 59000 milliseconds', () => {
    expect(formatDuration(59000)).toBe('59.0s');
  });

  // ── Minutes+seconds range (>= 60 000 ms) ─────────────────────────────────

  it('returns "1m 0s" for exactly 60000 milliseconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
  });

  it('returns "1m 30s" for 90000 milliseconds', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('returns "2m 0s" for 120000 milliseconds', () => {
    expect(formatDuration(120000)).toBe('2m 0s');
  });

  it('returns "2m 15s" for 135000 milliseconds', () => {
    expect(formatDuration(135000)).toBe('2m 15s');
  });

  it('returns "10m 0s" for 600000 milliseconds', () => {
    expect(formatDuration(600000)).toBe('10m 0s');
  });

  // ── Return type ───────────────────────────────────────────────────────────

  it('always returns a string', () => {
    for (const ms of [0, 500, 1000, 60000, 3600000]) {
      expect(typeof formatDuration(ms)).toBe('string');
    }
  });
});
