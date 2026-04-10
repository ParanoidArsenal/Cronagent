import { describe, it, expect } from 'vitest';
import { isRateLimitMessage } from '../src/rate-limit.js';

describe('isRateLimitMessage', () => {
  describe('matches', () => {
    it.each([
      ['rate_limit: too many requests', 'prefixed `rate_limit:`'],
      ['Rate limit reached', 'case-insensitive `Rate limit`'],
      ['rate-limit exceeded', 'hyphenated `rate-limit`'],
      ['HTTP 429 Too Many Requests', 'status code 429'],
      ['429', 'bare 429'],
      ['Too many requests, try again later', 'phrase "too many requests"'],
      ['TOO MANY REQUESTS', 'uppercase "TOO MANY REQUESTS"'],
    ])('matches %s (%s)', (msg) => {
      expect(isRateLimitMessage(msg)).toBe(true);
    });
  });

  describe('does not match', () => {
    it.each([
      ['Claude exited with code 1', 'generic exit failure'],
      ['ENOENT: no such file or directory', 'filesystem error'],
      ['process crash', 'crash message'],
      ['Reached maximum number of turns (12)', 'max-turns error'],
      ['', 'empty string'],
      ['something unrelated', 'unrelated text'],
      ['HTTP 500 Internal Server Error', 'non-rate-limit HTTP status'],
    ])('does not match %s (%s)', (msg) => {
      expect(isRateLimitMessage(msg)).toBe(false);
    });
  });
});
