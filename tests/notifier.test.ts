/**
 * Unit tests for the Notifier class.
 *
 * Mocks global.fetch and logger to test notification behaviour in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Automation, ExecutionResult } from '@cronagent/types';

// ── Mock logger ──────────────────────────────────────────────────────────────
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import after mocks ───────────────────────────────────────────────────────
import { Notifier } from '../src/notifier.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const makeAutomation = (overrides: Partial<Automation> = {}): Automation => ({
  name: 'My Automation',
  description: 'A test automation',
  trigger: 'manual',
  schedule: null,
  timeout: 300,
  mcp: [],
  model: 'sonnet',
  instructions: 'Do the thing.',
  filePath: '/automations/my-automation.md',
  mode: 'claude',
  sandbox: false,
  maxRetries: 0,
  retryDelayMs: 1000,
  conversation: false,
  ...overrides,
});

const makeResult = (overrides: Partial<ExecutionResult> = {}): ExecutionResult => ({
  automationName: 'My Automation',
  success: true,
  output: 'All done.',
  durationMs: 2500,
  startedAt: new Date('2026-04-02T10:00:00Z'),
  finishedAt: new Date('2026-04-02T10:00:02.5Z'),
  mode: 'claude',
  costUsd: 0.0012,
  ...overrides,
});

const mockOkResponse = () =>
  Promise.resolve({ ok: true, status: 200 } as Response);

const mockNotOkResponse = (status = 500) =>
  Promise.resolve({ ok: false, status } as Response);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Notifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation(mockOkResponse);
  });

  // 1. No webhook URL — fetch must never be called
  it('does not send when webhookUrl is undefined', async () => {
    const notifier = new Notifier(undefined);
    await notifier.notify(makeResult());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 2. Happy path — POST is issued with correct shape
  it('sends a POST request when webhookUrl is set', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    await notifier.notify(makeResult());

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://hooks.example.com/abc');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(() => JSON.parse(init.body)).not.toThrow();
  });

  // 3. Message content — automation name, emoji, duration, cost
  it('formats message with automation name, status emoji, duration, and cost', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');

    // Success case
    await notifier.notify(makeResult({ success: true, durationMs: 3200, costUsd: 0.0025 }));
    let body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toContain('My Automation');
    expect(body.text).toContain('✅');
    expect(body.text).toContain('3.2s');
    expect(body.text).toContain('$0.0025');

    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation(mockOkResponse);

    // Failure case
    await notifier.notify(makeResult({ success: false, durationMs: 1000, costUsd: 0.0001 }));
    body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toContain('❌');
    expect(body.text).toContain('FAILED');
  });

  // 4. Per-automation opt-out via notify: false
  it('does not send when automation has notify: false', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    await notifier.notify(makeResult(), makeAutomation({ notify: false }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 4b. Sends when automation has notify: true
  it('sends when automation has notify: true', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    await notifier.notify(makeResult(), makeAutomation({ notify: true }));
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  // 5a. Error field is truncated to 2000 chars
  it('truncates error field to 2000 characters', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    const longError = 'E'.repeat(3000);
    await notifier.notify(makeResult({ success: false, error: longError }));

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toContain('E'.repeat(1997) + '...');
    expect(body.text).not.toContain('E'.repeat(2001));
  });

  // 5b. Output field is truncated to 10000 chars
  it('truncates output field to 10000 characters', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    const longOutput = 'O'.repeat(11000);
    await notifier.notify(makeResult({ output: longOutput }));

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toContain('O'.repeat(9997) + '...');
    expect(body.text).not.toContain('O'.repeat(10001));
  });

  // 5c. Short strings are not truncated
  it('does not truncate short error and output fields', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    const shortError = 'short error';
    const shortOutput = 'short output';
    await notifier.notify(makeResult({ success: false, error: shortError, output: shortOutput }));

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toContain(shortError);
    expect(body.text).toContain(shortOutput);
  });

  // 6. Network failure — must not throw
  it('never throws when fetch rejects with a network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));
    const notifier = new Notifier('https://hooks.example.com/abc');
    await expect(notifier.notify(makeResult())).resolves.toBeUndefined();
  });

  // 7. Non-OK HTTP response — must not throw
  it('never throws when fetch returns a non-OK status', async () => {
    global.fetch = vi.fn().mockImplementation(() => mockNotOkResponse(503));
    const notifier = new Notifier('https://hooks.example.com/abc');
    await expect(notifier.notify(makeResult())).resolves.toBeUndefined();
  });

  // 8. sendMessage() posts custom text
  it('sendMessage posts custom text to the webhook', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    await notifier.sendMessage('Hello from composed automation!');

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://hooks.example.com/abc');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.text).toBe('Hello from composed automation!');
  });

  // 8b. sendMessage does nothing when webhookUrl is undefined
  it('sendMessage does not send when webhookUrl is undefined', async () => {
    const notifier = new Notifier(undefined);
    await notifier.sendMessage('This should not be sent');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 8c. sendMessage never throws on network error
  it('sendMessage never throws when fetch rejects', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('DNS failure'));
    const notifier = new Notifier('https://hooks.example.com/abc');
    await expect(notifier.sendMessage('test')).resolves.toBeUndefined();
  });

  // 9. AbortController is passed as signal (verifies timeout wiring)
  it('passes an AbortSignal to fetch for timeout enforcement', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    await notifier.notify(makeResult());

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes an AbortSignal to fetch in sendMessage for timeout enforcement', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    await notifier.sendMessage('ping');

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // Cost display when costUsd is undefined
  it('displays a dash for cost when costUsd is not provided', async () => {
    const notifier = new Notifier('https://hooks.example.com/abc');
    const result = makeResult();
    delete result.costUsd;
    await notifier.notify(result);

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toContain('Cost: -');
  });

  // ── Multi-channel tests ───────────────────────────────────────────────────

  // 10. Constructor backward compat: string shorthand still works
  it('accepts a plain string URL in the constructor (backward compat)', async () => {
    const notifier = new Notifier('https://hooks.example.com/legacy');
    await notifier.notify(makeResult());

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://hooks.example.com/legacy');
  });

  // 11. Telegram channel: sends to Telegram API when bot token + chat id are set
  it('sends to Telegram API when telegramBotToken and telegramChatId are configured', async () => {
    const notifier = new Notifier({
      telegramBotToken: 'mytoken123',
      telegramChatId: '-100987654321',
    });
    await notifier.notify(makeResult());

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('api.telegram.org');
  });

  // 12. Mattermost channel: sends to mattermostWebhookUrl when configured
  it('sends to mattermostWebhookUrl when mattermost channel is configured', async () => {
    const notifier = new Notifier({
      mattermostWebhookUrl: 'https://mattermost.example.com/hooks/xyz',
    });
    await notifier.notify(makeResult());

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://mattermost.example.com/hooks/xyz');
  });

  // 13. Multi-channel dispatch: all 3 channels configured → fetch called 3 times
  it('calls fetch three times when all three channels are configured', async () => {
    const notifier = new Notifier({
      webhookUrl: 'https://hooks.example.com/abc',
      telegramBotToken: 'mytoken123',
      telegramChatId: '-100987654321',
      mattermostWebhookUrl: 'https://mattermost.example.com/hooks/xyz',
    });
    await notifier.notify(makeResult());

    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  // 14. Per-automation channel selection: notify: { telegram: true } only sends to Telegram
  it('only sends to Telegram when automation notify config specifies telegram: true', async () => {
    const notifier = new Notifier({
      webhookUrl: 'https://hooks.example.com/abc',
      telegramBotToken: 'mytoken123',
      telegramChatId: '-100987654321',
      mattermostWebhookUrl: 'https://mattermost.example.com/hooks/xyz',
    });
    await notifier.notify(makeResult(), makeAutomation({ notify: { telegram: true } }));

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('api.telegram.org');
  });

  // 15. on_failure condition: webhook notified on failure, silent on success
  it('sends to webhook on failure but not on success when condition is on_failure', async () => {
    const notifier = new Notifier({ webhookUrl: 'https://hooks.example.com/abc' });
    const automation = makeAutomation({ notify: { webhook: 'on_failure' } });

    // Should send for a failed run
    await notifier.notify(makeResult({ success: false }), automation);
    expect(global.fetch).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation(mockOkResponse);

    // Should NOT send for a successful run
    await notifier.notify(makeResult({ success: true }), automation);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 16. on_success condition: Telegram notified on success, silent on failure
  it('sends to Telegram on success but not on failure when condition is on_success', async () => {
    const notifier = new Notifier({
      telegramBotToken: 'mytoken123',
      telegramChatId: '-100987654321',
    });
    const automation = makeAutomation({ notify: { telegram: 'on_success' } });

    // Should send for a successful run
    await notifier.notify(makeResult({ success: true }), automation);
    expect(global.fetch).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation(mockOkResponse);

    // Should NOT send for a failed run
    await notifier.notify(makeResult({ success: false }), automation);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 17. sendMessage with channel target: only sends to the specified channel
  it('sendMessage targets only Telegram when channel argument is "telegram"', async () => {
    const notifier = new Notifier({
      webhookUrl: 'https://hooks.example.com/abc',
      telegramBotToken: 'mytoken123',
      telegramChatId: '-100987654321',
    });
    await notifier.sendMessage('hello targeted', 'telegram');

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('api.telegram.org');
  });

  // 18. Telegram URL format: must match the expected Telegram Bot API pattern
  it('constructs the Telegram URL as https://api.telegram.org/bot{token}/sendMessage', async () => {
    const token = 'abc123XYZ';
    const notifier = new Notifier({
      telegramBotToken: token,
      telegramChatId: '42',
    });
    await notifier.sendMessage('url format check');

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
  });

  // 19. Telegram body format: must contain chat_id, text, and parse_mode
  it('sends correct Telegram body with chat_id, text, and parse_mode fields', async () => {
    const notifier = new Notifier({
      telegramBotToken: 'mytoken123',
      telegramChatId: '-100987654321',
    });
    await notifier.sendMessage('body format check');

    expect(global.fetch).toHaveBeenCalledOnce();
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe('-100987654321');
    expect(body.text).toBe('body format check');
    expect(body.parse_mode).toBe('Markdown');
  });
});
