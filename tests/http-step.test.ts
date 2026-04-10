/**
 * Tests for the HTTP step feature in YAML automations.
 *
 * Covers three layers:
 *   1. Schema — HttpStepSchema and ShellStepSchema validation (src/types.ts)
 *   2. Loader — YAML files with http steps are correctly serialized to instructions (src/loader.ts)
 *   3. Runner — executeShellMode HTTP step execution via global.fetch (src/runner.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const { execaMock, notifyMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
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

// ── Mock execa (shell steps use it; HTTP steps do not) ────────────────────────
vi.mock('execa', () => ({
  execa: execaMock,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { HttpStepSchema, ShellStepSchema } from '../src/types.js';
import { loadAutomations } from '../src/loader.js';
import { Runner } from '../src/runner.js';
import type { Automation } from '../src/types.js';
import type { Notifier } from '../src/notifier.js';

// ── Fixtures / helpers ────────────────────────────────────────────────────────

function makeShellAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    name: 'http-test',
    description: 'test',
    trigger: 'manual',
    schedule: null,
    timeout: 30,
    mcp: [],
    model: 'sonnet',
    instructions: '',
    filePath: '/tmp/http-test.yaml',
    mode: 'shell',
    sandbox: false,
    maxRetries: 0,
    retryDelayMs: 100,
    conversation: false,
    ...overrides,
  };
}

/**
 * Build a mock fetch that returns a successful 200 response with the given body text.
 */
function mockFetchOk(bodyText = 'ok response') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(bodyText),
  });
}

/**
 * Build a mock fetch that returns a non-2xx response.
 */
function mockFetchError(status: number, statusText: string, bodyText: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    text: () => Promise.resolve(bodyText),
  });
}

// ── 1. Schema tests ───────────────────────────────────────────────────────────

describe('HttpStepSchema', () => {
  it('parses a minimal config containing only the url field', () => {
    const result = HttpStepSchema.parse({ url: 'https://example.com' });
    expect(result.url).toBe('https://example.com');
  });

  it('defaults method to GET when not provided', () => {
    const result = HttpStepSchema.parse({ url: 'https://example.com' });
    expect(result.method).toBe('GET');
  });

  it('defaults timeout to 30 when not provided', () => {
    const result = HttpStepSchema.parse({ url: 'https://example.com' });
    expect(result.timeout).toBe(30);
  });

  it('accepts all supported HTTP methods', () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
    for (const method of methods) {
      const result = HttpStepSchema.parse({ url: 'https://example.com', method });
      expect(result.method).toBe(method);
    }
  });

  it('accepts optional headers as a string record', () => {
    const result = HttpStepSchema.parse({
      url: 'https://example.com',
      headers: { 'X-Custom': 'value', Authorization: 'Bearer token' },
    });
    expect(result.headers).toEqual({ 'X-Custom': 'value', Authorization: 'Bearer token' });
  });

  it('accepts a string body', () => {
    const result = HttpStepSchema.parse({ url: 'https://example.com', body: 'raw body' });
    expect(result.body).toBe('raw body');
  });

  it('accepts an object body', () => {
    const result = HttpStepSchema.parse({ url: 'https://example.com', body: { key: 'val' } });
    expect(result.body).toEqual({ key: 'val' });
  });

  it('accepts a custom timeout value', () => {
    const result = HttpStepSchema.parse({ url: 'https://example.com', timeout: 60 });
    expect(result.timeout).toBe(60);
  });

  it('rejects an unrecognised HTTP method', () => {
    expect(() => HttpStepSchema.parse({ url: 'https://example.com', method: 'CONNECT' })).toThrow();
  });

  it('leaves headers undefined when not provided', () => {
    const result = HttpStepSchema.parse({ url: 'https://example.com' });
    expect(result.headers).toBeUndefined();
  });

  it('leaves body undefined when not provided', () => {
    const result = HttpStepSchema.parse({ url: 'https://example.com' });
    expect(result.body).toBeUndefined();
  });
});

describe('ShellStepSchema — http variant', () => {
  it('accepts a step object containing an http key', () => {
    const result = ShellStepSchema.parse({ http: { url: 'https://example.com' } });
    expect('http' in result).toBe(true);
  });

  it('keeps accepting a shell step after adding the http variant', () => {
    const result = ShellStepSchema.parse({ shell: 'echo hello' });
    expect('shell' in result).toBe(true);
  });

  it('keeps accepting an on_failure step', () => {
    const result = ShellStepSchema.parse({ on_failure: { alert: 'oops' } });
    expect('on_failure' in result).toBe(true);
  });

  it('applies HttpStepSchema defaults inside the http variant', () => {
    const result = ShellStepSchema.parse({ http: { url: 'https://api.example.com/data' } });
    if (!('http' in result)) throw new Error('Expected http step');
    expect(result.http.method).toBe('GET');
    expect(result.http.timeout).toBe(30);
  });
});

// ── 2. Loader tests ───────────────────────────────────────────────────────────

describe('loadAutomations() — HTTP steps', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'http-step-loader-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads a YAML file with a single http step into shell mode', async () => {
    await writeFile(
      join(tempDir, 'fetch.yaml'),
      `name: fetch-data
description: Fetch from API
steps:
  - http:
      url: https://api.example.com/data
      method: GET
`,
      'utf-8',
    );

    const automations = await loadAutomations(tempDir);

    expect(automations).toHaveLength(1);
    const a = automations[0];
    expect(a.name).toBe('fetch-data');
    expect(a.mode).toBe('shell');
  });

  it('serialises an http step as an "http: <JSON>" line in instructions', async () => {
    await writeFile(
      join(tempDir, 'post.yaml'),
      `name: post-event
steps:
  - http:
      url: https://hooks.example.com/notify
      method: POST
`,
      'utf-8',
    );

    const [a] = await loadAutomations(tempDir);

    expect(a.instructions).toMatch(/^http: /);
    const jsonPart = a.instructions.slice('http: '.length);
    const parsed = JSON.parse(jsonPart);
    expect(parsed.url).toBe('https://hooks.example.com/notify');
    expect(parsed.method).toBe('POST');
  });

  it('applies default method GET and timeout 30 in the serialised JSON', async () => {
    await writeFile(
      join(tempDir, 'minimal.yaml'),
      `name: minimal-http
steps:
  - http:
      url: https://example.com/ping
`,
      'utf-8',
    );

    const [a] = await loadAutomations(tempDir);

    const jsonPart = a.instructions.slice('http: '.length);
    const parsed = JSON.parse(jsonPart);
    expect(parsed.method).toBe('GET');
    expect(parsed.timeout).toBe(30);
  });

  it('loads a YAML file with mixed shell and http steps preserving order', async () => {
    await writeFile(
      join(tempDir, 'mixed.yaml'),
      `name: mixed-steps
steps:
  - shell: echo before
  - http:
      url: https://api.example.com/hook
      method: POST
  - shell: echo after
`,
      'utf-8',
    );

    const [a] = await loadAutomations(tempDir);

    const lines = a.instructions.split('\n');
    expect(lines[0]).toBe('$ echo before');
    expect(lines[1]).toMatch(/^http: /);
    expect(lines[2]).toBe('$ echo after');
  });

  it('round-trips http step JSON without data loss for headers and body', async () => {
    await writeFile(
      join(tempDir, 'full-http.yaml'),
      `name: full-http
steps:
  - http:
      url: https://api.example.com/items
      method: POST
      headers:
        Authorization: Bearer secret
        X-Request-ID: abc123
      body:
        action: create
        value: 42
      timeout: 15
`,
      'utf-8',
    );

    const [a] = await loadAutomations(tempDir);

    const jsonPart = a.instructions.slice('http: '.length);
    const parsed = JSON.parse(jsonPart);
    expect(parsed.url).toBe('https://api.example.com/items');
    expect(parsed.method).toBe('POST');
    expect(parsed.headers).toEqual({ Authorization: 'Bearer secret', 'X-Request-ID': 'abc123' });
    expect(parsed.body).toEqual({ action: 'create', value: 42 });
    expect(parsed.timeout).toBe(15);
  });

  it('a YAML with only http steps produces instructions with no "$ " shell lines', async () => {
    await writeFile(
      join(tempDir, 'http-only.yaml'),
      `name: http-only
steps:
  - http:
      url: https://a.example.com
  - http:
      url: https://b.example.com
`,
      'utf-8',
    );

    const [a] = await loadAutomations(tempDir);

    const lines = a.instructions.split('\n');
    expect(lines).toHaveLength(2);
    lines.forEach((line) => expect(line).toMatch(/^http: /));
  });
});

// ── 3. Runner tests ───────────────────────────────────────────────────────────

describe('Runner — HTTP steps in executeShellMode', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    const notifier = { notify: notifyMock } as unknown as Notifier;
    runner = new Runner(undefined, false, notifier);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  // ── GET request ─────────────────────────────────────────────────────────────

  it('fetches the correct URL for a GET step', async () => {
    const mockFetch = mockFetchOk('{"status":"ok"}');
    vi.stubGlobal('fetch', mockFetch);

    const automation = makeShellAutomation({
      instructions: 'http: {"url":"https://api.example.com/status","method":"GET","timeout":30}',
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(true);
    const [calledUrl] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('https://api.example.com/status');
  });

  it('captures the response body text as output for a GET step', async () => {
    vi.stubGlobal('fetch', mockFetchOk('{"items":[1,2,3]}'));

    const automation = makeShellAutomation({
      instructions: 'http: {"url":"https://api.example.com/items","method":"GET","timeout":30}',
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(true);
    expect(result.output).toContain('{"items":[1,2,3]}');
  });

  it('uses GET as the default method when none is specified in the JSON', async () => {
    const mockFetch = mockFetchOk('pong');
    vi.stubGlobal('fetch', mockFetch);

    const automation = makeShellAutomation({
      // No "method" key — runner should fall back to GET
      instructions: 'http: {"url":"https://api.example.com/ping","timeout":30}',
    });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe('GET');
  });

  // ── POST request with body ───────────────────────────────────────────────────

  it('sends a POST request with the correct method', async () => {
    const mockFetch = mockFetchOk('created');
    vi.stubGlobal('fetch', mockFetch);

    const httpConfig = JSON.stringify({
      url: 'https://api.example.com/events',
      method: 'POST',
      body: { event: 'deploy', env: 'production' },
      timeout: 30,
    });

    const automation = makeShellAutomation({
      instructions: `http: ${httpConfig}`,
    });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe('POST');
  });

  it('auto-adds Content-Type: application/json when an object body is present', async () => {
    const mockFetch = mockFetchOk('created');
    vi.stubGlobal('fetch', mockFetch);

    const httpConfig = JSON.stringify({
      url: 'https://api.example.com/events',
      method: 'POST',
      body: { action: 'ping' },
      timeout: 30,
    });

    const automation = makeShellAutomation({ instructions: `http: ${httpConfig}` });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('serialises an object body to JSON before sending', async () => {
    const mockFetch = mockFetchOk('ok');
    vi.stubGlobal('fetch', mockFetch);

    const payload = { action: 'deploy', version: '1.2.3' };
    const httpConfig = JSON.stringify({
      url: 'https://api.example.com/deploy',
      method: 'POST',
      body: payload,
      timeout: 30,
    });

    const automation = makeShellAutomation({ instructions: `http: ${httpConfig}` });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.body).toBe(JSON.stringify(payload));
  });

  it('sends a raw string body as-is', async () => {
    const mockFetch = mockFetchOk('ok');
    vi.stubGlobal('fetch', mockFetch);

    const httpConfig = JSON.stringify({
      url: 'https://api.example.com/raw',
      method: 'POST',
      body: 'raw=data&foo=bar',
      timeout: 30,
    });

    const automation = makeShellAutomation({ instructions: `http: ${httpConfig}` });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.body).toBe('raw=data&foo=bar');
  });

  // ── Headers ──────────────────────────────────────────────────────────────────

  it('passes custom headers through to fetch', async () => {
    const mockFetch = mockFetchOk('ok');
    vi.stubGlobal('fetch', mockFetch);

    const httpConfig = JSON.stringify({
      url: 'https://api.example.com/secure',
      method: 'GET',
      headers: { Authorization: 'Bearer mytoken', 'X-Trace-ID': 'abc-123' },
      timeout: 30,
    });

    const automation = makeShellAutomation({ instructions: `http: ${httpConfig}` });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Authorization']).toBe('Bearer mytoken');
    expect(options.headers['X-Trace-ID']).toBe('abc-123');
  });

  it('does not add Content-Type header when no body is present', async () => {
    const mockFetch = mockFetchOk('ok');
    vi.stubGlobal('fetch', mockFetch);

    const httpConfig = JSON.stringify({
      url: 'https://api.example.com/data',
      method: 'GET',
      timeout: 30,
    });

    const automation = makeShellAutomation({ instructions: `http: ${httpConfig}` });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Content-Type']).toBeUndefined();
    expect(options.headers['content-type']).toBeUndefined();
  });

  it('does not overwrite an explicit Content-Type header provided in the step', async () => {
    const mockFetch = mockFetchOk('ok');
    vi.stubGlobal('fetch', mockFetch);

    const httpConfig = JSON.stringify({
      url: 'https://api.example.com/form',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'foo=bar',
      timeout: 30,
    });

    const automation = makeShellAutomation({ instructions: `http: ${httpConfig}` });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  // ── Non-2xx error handling ───────────────────────────────────────────────────

  it('marks result as failed on a 404 response', async () => {
    vi.stubGlobal('fetch', mockFetchError(404, 'Not Found', 'resource missing'));

    const automation = makeShellAutomation({
      instructions: 'http: {"url":"https://api.example.com/missing","method":"GET","timeout":30}',
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(false);
  });

  it('includes the HTTP status code in the error message', async () => {
    vi.stubGlobal('fetch', mockFetchError(503, 'Service Unavailable', 'down for maintenance'));

    const automation = makeShellAutomation({
      instructions: 'http: {"url":"https://api.example.com/busy","method":"GET","timeout":30}',
    });

    const result = await runner.execute(automation);

    expect(result.error).toContain('503');
  });

  it('includes the status text in the error message', async () => {
    vi.stubGlobal('fetch', mockFetchError(502, 'Bad Gateway', 'upstream failed'));

    const automation = makeShellAutomation({
      instructions: 'http: {"url":"https://api.example.com/proxy","method":"GET","timeout":30}',
    });

    const result = await runner.execute(automation);

    expect(result.error).toContain('Bad Gateway');
  });

  it('includes a snippet of the response body in the error message', async () => {
    vi.stubGlobal('fetch', mockFetchError(422, 'Unprocessable Entity', 'validation failed: name is required'));

    const automation = makeShellAutomation({
      instructions: 'http: {"url":"https://api.example.com/create","method":"POST","timeout":30}',
    });

    const result = await runner.execute(automation);

    expect(result.error).toContain('validation failed');
  });

  it('truncates very long response bodies in the error message to 500 chars', async () => {
    const longBody = 'E'.repeat(600);
    vi.stubGlobal('fetch', mockFetchError(500, 'Internal Server Error', longBody));

    const automation = makeShellAutomation({
      instructions: 'http: {"url":"https://api.example.com/boom","method":"GET","timeout":30}',
    });

    const result = await runner.execute(automation);

    // error message body snippet must not exceed 500 chars
    expect(result.error).not.toContain('E'.repeat(501));
  });

  // ── Timeout / AbortController ────────────────────────────────────────────────

  it('passes an AbortSignal to fetch for timeout enforcement', async () => {
    const mockFetch = mockFetchOk('ok');
    vi.stubGlobal('fetch', mockFetch);

    const automation = makeShellAutomation({
      instructions: 'http: {"url":"https://api.example.com/data","method":"GET","timeout":30}',
    });

    await runner.execute(automation);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('marks result as failed when fetch is aborted due to timeout', async () => {
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

    const automation = makeShellAutomation({
      // Very short timeout so the AbortController fires almost immediately
      instructions: 'http: {"url":"https://api.example.com/slow","method":"GET","timeout":0.001}',
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(false);
  });

  // ── Mixed shell + http steps ─────────────────────────────────────────────────

  it('executes shell steps via execa and http steps via fetch in the same run', async () => {
    const mockFetch = mockFetchOk('http-response');
    vi.stubGlobal('fetch', mockFetch);

    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'shell-output', stderr: '' });

    const automation = makeShellAutomation({
      instructions: [
        '$ echo hello',
        'http: {"url":"https://api.example.com/hook","method":"POST","timeout":30}',
      ].join('\n'),
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(true);
    // execa should have been called for the shell step
    expect(execaMock).toHaveBeenCalledOnce();
    // fetch should have been called for the http step
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('collects output from both shell and http steps', async () => {
    vi.stubGlobal('fetch', mockFetchOk('http-data'));
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'shell-data', stderr: '' });

    const automation = makeShellAutomation({
      instructions: [
        '$ echo shell',
        'http: {"url":"https://api.example.com/data","method":"GET","timeout":30}',
      ].join('\n'),
    });

    const result = await runner.execute(automation);

    expect(result.output).toContain('shell-data');
    expect(result.output).toContain('http-data');
  });

  it('stops execution and reports failure when an http step fails mid-sequence', async () => {
    vi.stubGlobal('fetch', mockFetchError(500, 'Internal Server Error', 'boom'));
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'first ok', stderr: '' });

    const automation = makeShellAutomation({
      instructions: [
        '$ echo first',
        'http: {"url":"https://api.example.com/fail","method":"GET","timeout":30}',
        '$ echo second',
      ].join('\n'),
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(false);
    // The second shell step must NOT have been reached
    expect(execaMock).toHaveBeenCalledOnce();
  });

  it('skips blank lines without calling fetch or execa', async () => {
    const mockFetch = mockFetchOk('ok');
    vi.stubGlobal('fetch', mockFetch);
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'done', stderr: '' });

    const automation = makeShellAutomation({
      instructions: '\n\n$ echo hi\n\n',
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(true);
    expect(execaMock).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips on_failure lines without calling fetch', async () => {
    const mockFetch = mockFetchOk('ok');
    vi.stubGlobal('fetch', mockFetch);

    const automation = makeShellAutomation({
      instructions: 'on_failure: {"alert":"something went wrong"}',
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── Multiple http steps ──────────────────────────────────────────────────────

  it('executes multiple consecutive http steps in order', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK',
        text: () => Promise.resolve('response-1'),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK',
        text: () => Promise.resolve('response-2'),
      });

    vi.stubGlobal('fetch', mockFetch);

    const automation = makeShellAutomation({
      instructions: [
        'http: {"url":"https://a.example.com","method":"GET","timeout":30}',
        'http: {"url":"https://b.example.com","method":"GET","timeout":30}',
      ].join('\n'),
    });

    const result = await runner.execute(automation);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.output).toContain('response-1');
    expect(result.output).toContain('response-2');
  });

  it('calls the first URL before the second URL', async () => {
    const callOrder: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        callOrder.push(url);
        return Promise.resolve({
          ok: true, status: 200, statusText: 'OK',
          text: () => Promise.resolve('ok'),
        });
      }),
    );

    const automation = makeShellAutomation({
      instructions: [
        'http: {"url":"https://first.example.com","method":"GET","timeout":30}',
        'http: {"url":"https://second.example.com","method":"GET","timeout":30}',
      ].join('\n'),
    });

    await runner.execute(automation);

    expect(callOrder).toEqual(['https://first.example.com', 'https://second.example.com']);
  });
});
