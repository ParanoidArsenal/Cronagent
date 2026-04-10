/**
 * Unit tests for the CAILA execution mode in Runner.
 *
 * The CAILA mode calls an OpenAI-compatible chat completions endpoint via
 * fetch(). These tests stub global fetch with vi.stubGlobal so no real network
 * requests are made. execa is mocked to suppress any claude-mode side-effects
 * that might surface through shared Runner code paths.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(async () => {}),
}));

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Mock execa (not used by caila mode, but Runner imports it at module level) ─
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// ── Mock node:fs/promises (not used by caila mode, suppresses real I/O) ───────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => 'prompt content'),
  writeFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { Runner } from '../src/runner.js';
import type { Automation } from '../src/types.js';
import type { Notifier } from '../src/notifier.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal Automation fixture for caila mode. */
function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    name: 'caila-test',
    description: 'test caila automation',
    trigger: 'manual',
    schedule: null,
    timeout: 30,
    mcp: [],
    model: 'some-caila-model',
    instructions: 'Summarise the quarterly results.',
    filePath: '/tmp/caila-test.md',
    mode: 'caila',
    sandbox: false,
    notify: false,
    maxRetries: 0,
    retryDelayMs: 100,
    conversation: false,
    ...overrides,
  };
}

/** Environment variables that satisfy the CAILA mode requirements. */
const CAILA_ENV = {
  CAILA_BASE_URL: 'https://caila.example.com',
  CAILA_API_KEY: 'test-api-key-abc123',
};

/**
 * Build a minimal mock fetch response for a successful CAILA call.
 * All parameters are optional so individual tests can override only what they need.
 */
function mockFetchSuccess(opts: {
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
}) {
  const body: Record<string, unknown> = {
    choices: [
      {
        message: {
          content: opts.content ?? 'This is the model response.',
        },
      },
    ],
  };

  if (opts.promptTokens !== undefined || opts.completionTokens !== undefined) {
    body.usage = {
      ...(opts.promptTokens !== undefined ? { prompt_tokens: opts.promptTokens } : {}),
      ...(opts.completionTokens !== undefined ? { completion_tokens: opts.completionTokens } : {}),
    };
  }

  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

/**
 * Build a mock fetch response that represents an HTTP error.
 */
function mockFetchError(status: number, bodyText = 'Internal Server Error') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.reject(new Error('not JSON')),
    text: () => Promise.resolve(bodyText),
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Runner — CAILA mode', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    const notifier = { notify: notifyMock } as unknown as Notifier;
    runner = new Runner(undefined, false, notifier);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  // ── Successful execution ───────────────────────────────────────────────────

  describe('successful execution', () => {
    it('returns the model output text', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'Quarterly revenue grew by 12%.' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Quarterly revenue grew by 12%.');
    });

    it('sets mode to caila on success', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.mode).toBe('caila');
    });

    it('sets automationName from the automation object', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok' }));

      const result = await runner.execute(makeAutomation({ name: 'my-caila-job' }), CAILA_ENV);

      expect(result.automationName).toBe('my-caila-job');
    });

    it('records a non-negative durationMs', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('extracts inputTokens from usage.prompt_tokens', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok', promptTokens: 512, completionTokens: 128 }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.inputTokens).toBe(512);
    });

    it('extracts outputTokens from usage.completion_tokens', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok', promptTokens: 512, completionTokens: 128 }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.outputTokens).toBe(128);
    });

    it('returns both token counts together', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok', promptTokens: 1000, completionTokens: 250 }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(250);
    });

    it('POSTs to the correct CAILA endpoint URL', async () => {
      const mockFetch = mockFetchSuccess({ content: 'ok' });
      vi.stubGlobal('fetch', mockFetch);

      await runner.execute(makeAutomation(), CAILA_ENV);

      const [calledUrl] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe(
        'https://caila.example.com/api/adapters/openai-direct/chat/completions',
      );
    });

    it('sends Authorization header with Bearer token', async () => {
      const mockFetch = mockFetchSuccess({ content: 'ok' });
      vi.stubGlobal('fetch', mockFetch);

      await runner.execute(makeAutomation(), CAILA_ENV);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBe('Bearer test-api-key-abc123');
    });

    it('sends model, messages, and max_tokens in the request body', async () => {
      const mockFetch = mockFetchSuccess({ content: 'ok' });
      vi.stubGlobal('fetch', mockFetch);

      const auto = makeAutomation({ model: 'gpt-4o', instructions: 'Say hello.' });
      await runner.execute(auto, CAILA_ENV);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.model).toBe('gpt-4o');
      expect(body.messages).toEqual([{ role: 'user', content: 'Say hello.' }]);
      expect(body.max_tokens).toBe(16384);
    });

    it('trims leading/trailing whitespace from the model response', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: '  answer with spaces  ' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.output).toBe('answer with spaces');
    });
  });

  // ── Missing credentials ────────────────────────────────────────────────────

  describe('missing credentials', () => {
    it('throws when CAILA_API_KEY is absent', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok' }));

      const result = await runner.execute(makeAutomation(), {
        CAILA_BASE_URL: 'https://caila.example.com',
        // CAILA_API_KEY intentionally omitted
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/CAILA_API_KEY/);
    });

    it('throws when CAILA_BASE_URL is absent', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok' }));

      const result = await runner.execute(makeAutomation(), {
        CAILA_API_KEY: 'some-key',
        // CAILA_BASE_URL intentionally omitted
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/CAILA_BASE_URL/);
    });

    it('throws when both CAILA env vars are absent', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok' }));

      const result = await runner.execute(makeAutomation(), {});

      expect(result.success).toBe(false);
      // Either key is acceptable — both are missing
      expect(result.error).toMatch(/CAILA_API_KEY|CAILA_BASE_URL/);
    });

    it('does not call fetch when CAILA_API_KEY is missing', async () => {
      const mockFetch = mockFetchSuccess({ content: 'ok' });
      vi.stubGlobal('fetch', mockFetch);

      await runner.execute(makeAutomation(), { CAILA_BASE_URL: 'https://caila.example.com' });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── HTTP error handling ────────────────────────────────────────────────────

  describe('HTTP error handling', () => {
    it('marks result as failed on HTTP 500', async () => {
      vi.stubGlobal('fetch', mockFetchError(500, 'Internal Server Error'));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.success).toBe(false);
    });

    it('includes the HTTP status in the error message for 500', async () => {
      vi.stubGlobal('fetch', mockFetchError(500, 'Service unavailable'));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.error).toContain('500');
    });

    it('does NOT include rate_limit prefix for HTTP 500', async () => {
      vi.stubGlobal('fetch', mockFetchError(500, 'Server exploded'));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.error).not.toMatch(/^rate_limit:/);
    });

    it('includes rate_limit prefix for HTTP 429', async () => {
      vi.stubGlobal('fetch', mockFetchError(429, 'Too Many Requests'));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/^rate_limit:/);
    });

    it('HTTP 429 error enables retry backoff — rate_limit prefix is present', async () => {
      vi.stubGlobal('fetch', mockFetchError(429, 'Rate limit exceeded'));

      const result = await runner.execute(makeAutomation({ maxRetries: 0 }), CAILA_ENV);

      // With maxRetries: 0 the loop does not retry, but we still confirm the prefix
      expect(result.error).toContain('rate_limit:');
    });

    it('includes the response body text in the error message', async () => {
      vi.stubGlobal('fetch', mockFetchError(503, 'upstream connect error'));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.error).toContain('upstream connect error');
    });
  });

  // ── Token values when usage is absent ─────────────────────────────────────

  describe('token values when usage is absent', () => {
    it('returns undefined inputTokens when usage object is missing', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'no usage' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.inputTokens).toBeUndefined();
    });

    it('returns undefined outputTokens when usage object is missing', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'no usage' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.outputTokens).toBeUndefined();
    });

    it('inputTokens is not NaN when usage is absent', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'no usage' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      // Must be undefined, not NaN
      expect(result.inputTokens).not.toEqual(NaN);
    });

    it('outputTokens is not NaN when usage is absent', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'no usage' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.outputTokens).not.toEqual(NaN);
    });

    it('inputTokens is not 0 when usage is absent (undefined, not defaulted)', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'no usage' }));

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.inputTokens).not.toBe(0);
    });

    it('returns undefined inputTokens when prompt_tokens key is absent from usage', async () => {
      // usage present but only completion_tokens
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: 'partial usage' } }],
              usage: { completion_tokens: 42 },
            }),
        }),
      );

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBe(42);
    });

    it('returns undefined outputTokens when completion_tokens key is absent from usage', async () => {
      // usage present but only prompt_tokens
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: 'partial usage' } }],
              usage: { prompt_tokens: 99 },
            }),
        }),
      );

      const result = await runner.execute(makeAutomation(), CAILA_ENV);

      expect(result.inputTokens).toBe(99);
      expect(result.outputTokens).toBeUndefined();
    });
  });

  // ── Timeout via AbortController ────────────────────────────────────────────

  describe('timeout handling', () => {
    it('throws a timeout error when the request is aborted', async () => {
      // Simulate a fetch that never resolves until the AbortController fires
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
          return new Promise<never>((_resolve, reject) => {
            if (opts?.signal) {
              opts.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }
          });
        }),
      );

      // Use a very short timeout so the test doesn't actually wait 30 s
      const result = await runner.execute(
        makeAutomation({ timeout: 0.001 }), // ~1 ms timeout
        CAILA_ENV,
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timed out/i);
    });

    it('timeout error message includes the configured timeout value', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
          return new Promise<never>((_resolve, reject) => {
            if (opts?.signal) {
              opts.signal.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }
          });
        }),
      );

      const result = await runner.execute(
        makeAutomation({ timeout: 0.001 }),
        CAILA_ENV,
      );

      // The message should mention the duration (in seconds) from automation.timeout
      expect(result.error).toMatch(/0\.001s/);
    });

    it('passes an AbortSignal to fetch so timeouts can be cancelled', async () => {
      const mockFetch = mockFetchSuccess({ content: 'ok' });
      vi.stubGlobal('fetch', mockFetch);

      await runner.execute(makeAutomation(), CAILA_ENV);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.signal).toBeDefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ── Retry integration with rate_limit prefix ───────────────────────────────

  describe('retry integration', () => {
    it('uses 10x delay multiplier when CAILA returns a 429 (rate_limit prefix)', async () => {
      vi.useFakeTimers();

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve('Too Many Requests'),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: 'recovered after rate limit' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
        });

      vi.stubGlobal('fetch', mockFetch);

      const promise = runner.execute(
        makeAutomation({ maxRetries: 1, retryDelayMs: 100 }),
        CAILA_ENV,
      );

      // Rate-limit delay = 100 * 2^0 * 10 = 1000 ms.
      // Advancing only 500 ms should NOT have triggered the second call yet.
      await vi.advanceTimersByTimeAsync(500);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Now pass the full 1000 ms threshold.
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.output).toBe('recovered after rate limit');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('succeeds on first attempt with no retries needed', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'first try', promptTokens: 20, completionTokens: 10 }));

      const result = await runner.execute(makeAutomation({ maxRetries: 2 }), CAILA_ENV);

      expect(result.success).toBe(true);
      expect(result.attemptNumber).toBe(1);
      expect(result.totalAttempts).toBe(1);
    });

    it('notifier is called exactly once after CAILA success', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ content: 'ok' }));

      await runner.execute(makeAutomation(), CAILA_ENV);

      expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it('notifier is called exactly once after final CAILA failure', async () => {
      vi.stubGlobal('fetch', mockFetchError(500, 'always fails'));

      await runner.execute(makeAutomation({ maxRetries: 0 }), CAILA_ENV);

      expect(notifyMock).toHaveBeenCalledTimes(1);
    });
  });
});
