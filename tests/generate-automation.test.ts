/**
 * Tests for the POST /api/automations/generate handler in
 * web/app/api/automations/generate/route.ts.
 *
 * The handler:
 *   1. Parses { description } from the request body
 *   2. Returns 400 when description is missing, empty, or fewer than 5 chars
 *   3. Calls generateAutomationContent(description) from @/lib/backend
 *   4. Returns the GeneratedAutomation result as JSON with HTTP 200
 *   5. Returns 500 when generateAutomationContent throws
 *
 * Strategy: mock @/lib/backend (resolved via vitest alias to
 * ../web/lib/backend.ts) so the route is tested in complete isolation from
 * the real generation pipeline (execa, gray-matter, filesystem, etc.).
 *
 * The same importOriginal spread pattern used in webhook-gitlab.test.ts and
 * delete-automation.test.ts keeps the rest of the module intact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @cronagent/* transitive dependencies ───────────────────────────
//
// backend.ts re-exports from these workspace packages. Mocking them prevents
// vitest from loading the real implementations.

vi.mock('@cronagent/loader', () => ({
  loadAutomations: vi.fn().mockResolvedValue([]),
}));

vi.mock('@cronagent/runner', () => ({
  Runner: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/history', () => ({
  History: { create: vi.fn().mockResolvedValue({}) },
  DEFAULT_THROTTLE: { enabled: false, maxConcurrent: 5, cooldownSeconds: 0, maxPerHour: 0 },
  DEFAULT_BUDGET: { enabled: false, dailyLimitUsd: 0, monthlyLimitUsd: 0 },
  BudgetConfigSchema: { safeParse: vi.fn().mockReturnValue({ success: false }) },
}));

vi.mock('@cronagent/composer', () => ({
  Composer: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/notifier', () => ({
  Notifier: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/scheduler', () => ({
  Scheduler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/skip-list', () => ({
  SkipList: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/usage-tracker', () => ({
  UsageTracker: vi.fn().mockImplementation(() => ({})),
}));

// ── Mock node:fs/promises so no real filesystem access occurs ─────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock js-yaml ──────────────────────────────────────────────────────────────

vi.mock('js-yaml', () => ({
  default: { dump: vi.fn().mockReturnValue('name: test\n'), load: vi.fn() },
}));

// ── Mock @/lib/backend (resolved to ../web/lib/backend.ts by vitest alias) ────
//
// Only generateAutomationContent is overridden — every other export falls
// through to the real module, consistent with the pattern in the other tests.

const mockGenerateAutomationContent = vi.fn();

vi.mock('../web/lib/backend.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/lib/backend.ts')>();
  return {
    ...real,
    generateAutomationContent: (...args: unknown[]) =>
      mockGenerateAutomationContent(...args),
  };
});

// ── Import route handler after all mocks are registered ──────────────────────

import { POST } from '../web/app/api/automations/generate/route.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal GeneratedAutomation fixture. */
const GENERATED_FIXTURE = {
  name: 'daily-report',
  description: 'Sends a daily summary email',
  mode: 'claude' as const,
  trigger: 'cron' as const,
  schedule: '0 9 * * *',
  mcp: ['filesystem'],
  instructions: 'Generate and send the report.',
  rawContent: '---\nname: daily-report\n---\nGenerate and send the report.',
};

/**
 * Build a minimal Request-like object whose only requirement is a json()
 * method that resolves to the provided body value.
 */
function makeRequest(body: unknown): Request {
  return {
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Request;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/automations/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path: generation succeeds with the fixture.
    mockGenerateAutomationContent.mockResolvedValue(GENERATED_FIXTURE);
  });

  // ── Validation: missing / too-short description ───────────────────────────

  describe('input validation', () => {
    it('returns 400 when description is missing from the body', async () => {
      const req = makeRequest({});

      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it('returns an error message when description is missing', async () => {
      const req = makeRequest({});

      const res = await POST(req);
      const body = await res.json();

      expect(body).toHaveProperty('error');
    });

    it('returns 400 when description is an empty string', async () => {
      const req = makeRequest({ description: '' });

      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it('returns 400 when description is shorter than 5 characters', async () => {
      const req = makeRequest({ description: 'hi' });

      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it('returns 400 when description trims to fewer than 5 characters', async () => {
      // Four visible chars surrounded by whitespace — trims to "ab c" (4 chars)
      const req = makeRequest({ description: '  ab c  ' });

      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it('does not call generateAutomationContent when description is too short', async () => {
      const req = makeRequest({ description: 'abc' });

      await POST(req);

      expect(mockGenerateAutomationContent).not.toHaveBeenCalled();
    });
  });

  // ── Success path ──────────────────────────────────────────────────────────

  describe('successful generation', () => {
    it('returns HTTP 200 when description is valid', async () => {
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('calls generateAutomationContent with the trimmed description', async () => {
      const req = makeRequest({ description: '  Send a daily report email  ' });

      await POST(req);

      expect(mockGenerateAutomationContent).toHaveBeenCalledWith(
        'Send a daily report email',
      );
    });

    it('returns the name field from the generated automation', async () => {
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body.name).toBe(GENERATED_FIXTURE.name);
    });

    it('returns the description field from the generated automation', async () => {
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body.description).toBe(GENERATED_FIXTURE.description);
    });

    it('returns the mode field from the generated automation', async () => {
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body.mode).toBe(GENERATED_FIXTURE.mode);
    });

    it('returns the trigger field from the generated automation', async () => {
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body.trigger).toBe(GENERATED_FIXTURE.trigger);
    });

    it('returns the mcp field from the generated automation', async () => {
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body.mcp).toEqual(GENERATED_FIXTURE.mcp);
    });

    it('returns the instructions field from the generated automation', async () => {
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body.instructions).toBe(GENERATED_FIXTURE.instructions);
    });

    it('returns the full GeneratedAutomation object as JSON', async () => {
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body).toMatchObject({
        name: GENERATED_FIXTURE.name,
        description: GENERATED_FIXTURE.description,
        mode: GENERATED_FIXTURE.mode,
        trigger: GENERATED_FIXTURE.trigger,
        mcp: GENERATED_FIXTURE.mcp,
        instructions: GENERATED_FIXTURE.instructions,
      });
    });

    it('accepts a description that is exactly 5 characters long', async () => {
      const req = makeRequest({ description: 'hello' });

      const res = await POST(req);

      expect(res.status).toBe(200);
    });
  });

  // ── Error path ────────────────────────────────────────────────────────────

  describe('when generateAutomationContent throws', () => {
    it('returns HTTP 500', async () => {
      mockGenerateAutomationContent.mockRejectedValue(
        new Error('Claude CLI not found'),
      );
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);

      expect(res.status).toBe(500);
    });

    it('returns the error message in the response body', async () => {
      mockGenerateAutomationContent.mockRejectedValue(
        new Error('Claude CLI not found'),
      );
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body.error).toBe('Claude CLI not found');
    });

    it('returns a generic error message for non-Error throwables', async () => {
      mockGenerateAutomationContent.mockRejectedValue('something went wrong');
      const req = makeRequest({ description: 'Send a daily report email' });

      const res = await POST(req);
      const body = await res.json();

      expect(body.error).toBe('Generation failed');
    });
  });
});
