/**
 * Tests for the POST /api/webhook/gitlab handler in
 * web/app/api/webhook/gitlab/route.ts.
 *
 * The handler:
 *   1. Validates X-Gitlab-Token against GITLAB_WEBHOOK_SECRET (required —
 *      rejects with 503 when the secret is not configured)
 *   2. Normalizes the X-Gitlab-Event header into a short event type string
 *   3. Parses the JSON body and extracts convenience env vars
 *   4. Loads automations, filters to trigger === 'webhook'
 *   5. Calls triggerRun(name, { webhookEnv }) for each matching automation
 *   6. Returns { triggered, total, results }
 *
 * Strategy: mock next/server (not available in root node_modules), mock
 * ../web/lib/backend.ts at the resolved path used by vitest's @/ alias,
 * and mock transitive @cronagent/* deps so the real backend module
 * can be partially imported without touching the filesystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock next/server ──────────────────────────────────────────────────────────
//
// next/server lives in web/node_modules, not the root, so vitest cannot
// resolve it.  We provide a minimal stub whose only purpose is to satisfy
// the `import { NextRequest } from 'next/server'` inside the route file.
// The stub is never constructed by our tests — we pass plain objects instead.

vi.mock('next/server', () => ({
  NextRequest: class NextRequest {},
}));

// ── Mock @cronagent/* transitive dependencies ───────────────────────────
//
// backend.ts re-exports from these workspace packages.  Mocking them prevents
// vitest from loading the real implementations (which need a configured
// filesystem, DB, etc.).

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

// ── Mock node:fs/promises ─────────────────────────────────────────────────────

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
// We only override getAutomations and triggerRun — the functions the route
// actually calls.  Everything else falls through to the real module so that
// helper utilities (parseAutomationInput, etc.) remain functional if needed.

const mockGetAutomations = vi.fn();
const mockTriggerRun = vi.fn();

vi.mock('../web/lib/backend.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/lib/backend.ts')>();
  return {
    ...real,
    getAutomations: (...args: unknown[]) => mockGetAutomations(...args),
    triggerRun: (...args: unknown[]) => mockTriggerRun(...args),
  };
});

// ── Import route handler after all mocks are registered ──────────────────────

import { POST } from '../web/app/api/webhook/gitlab/route.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Secret configured in beforeEach; makeRequest sends it by default. */
const TEST_SECRET = 'test-webhook-secret';

/**
 * Build a minimal request-like object that satisfies the interface used by
 * the route handler: headers.get() and json().
 *
 * gitlabToken defaults to TEST_SECRET; pass null to omit the header.
 */
function makeRequest(options: {
  gitlabToken?: string | null;
  gitlabEvent?: string;
  body?: unknown;
}) {
  const headers: Record<string, string> = {};
  const token = options.gitlabToken === undefined ? TEST_SECRET : options.gitlabToken;
  if (token !== null) {
    headers['x-gitlab-token'] = token;
  }
  if (options.gitlabEvent !== undefined) {
    headers['x-gitlab-event'] = options.gitlabEvent;
  }

  return {
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    json: vi.fn().mockResolvedValue(options.body ?? {}),
  } as unknown as import('next/server').NextRequest;
}

/** A minimal automation fixture for webhook-triggered automations. */
function makeWebhookAutomation(name: string) {
  return { name, trigger: 'webhook' as const };
}

/** A minimal automation fixture for non-webhook automations. */
function makeOtherAutomation(name: string, trigger: string) {
  return { name, trigger };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/webhook/gitlab', () => {
  const originalEnv = process.env.GITLAB_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no automations, triggerRun resolves to started:true
    mockGetAutomations.mockResolvedValue([]);
    mockTriggerRun.mockResolvedValue({ started: true });
    // Secret is required; configure it for every test by default
    process.env.GITLAB_WEBHOOK_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    // Restore original env value
    if (originalEnv !== undefined) {
      process.env.GITLAB_WEBHOOK_SECRET = originalEnv;
    } else {
      delete process.env.GITLAB_WEBHOOK_SECRET;
    }
  });

  // ── Authentication ──────────────────────────────────────────────────────────

  describe('secret token validation', () => {
    it('returns 401 when secret is set and token does not match', async () => {
      process.env.GITLAB_WEBHOOK_SECRET = 'correct-secret';
      const req = makeRequest({ gitlabToken: 'wrong-secret', gitlabEvent: 'Push Hook' });

      const res = await POST(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty('error');
    });

    it('returns 401 when secret is set and token is missing entirely', async () => {
      process.env.GITLAB_WEBHOOK_SECRET = 'correct-secret';
      const req = makeRequest({ gitlabToken: null, gitlabEvent: 'Push Hook' }); // no token header

      const res = await POST(req);

      expect(res.status).toBe(401);
    });

    it('returns 200 when secret is set and token matches', async () => {
      process.env.GITLAB_WEBHOOK_SECRET = 'correct-secret';
      const req = makeRequest({ gitlabToken: 'correct-secret', gitlabEvent: 'Push Hook' });

      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('returns 401 when token differs only in length (prefix of secret)', async () => {
      process.env.GITLAB_WEBHOOK_SECRET = 'correct-secret';
      const req = makeRequest({ gitlabToken: 'correct', gitlabEvent: 'Push Hook' });

      const res = await POST(req);

      expect(res.status).toBe(401);
    });

    it('returns 401 when token is an empty string', async () => {
      process.env.GITLAB_WEBHOOK_SECRET = 'correct-secret';
      const req = makeRequest({ gitlabToken: '', gitlabEvent: 'Push Hook' });

      const res = await POST(req);

      expect(res.status).toBe(401);
    });

    it('returns 503 when GITLAB_WEBHOOK_SECRET is not set (fails closed)', async () => {
      delete process.env.GITLAB_WEBHOOK_SECRET;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGetAutomations.mockResolvedValue([makeWebhookAutomation('job-a')]);
      const req = makeRequest({ gitlabToken: null, gitlabEvent: 'Push Hook' });

      const res = await POST(req);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/GITLAB_WEBHOOK_SECRET/);
      expect(errSpy).toHaveBeenCalled();
      expect(mockTriggerRun).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('returns 503 when GITLAB_WEBHOOK_SECRET is empty, even if a token is sent', async () => {
      process.env.GITLAB_WEBHOOK_SECRET = '';
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const req = makeRequest({ gitlabToken: '', gitlabEvent: 'Push Hook' });

      const res = await POST(req);

      expect(res.status).toBe(503);
      errSpy.mockRestore();
    });

    it('does not trigger automations when token is wrong', async () => {
      mockGetAutomations.mockResolvedValue([makeWebhookAutomation('job-a')]);
      const req = makeRequest({ gitlabToken: 'nope', gitlabEvent: 'Push Hook' });

      const res = await POST(req);

      expect(res.status).toBe(401);
      expect(mockTriggerRun).not.toHaveBeenCalled();
    });
  });

  // ── Event header validation ─────────────────────────────────────────────────

  describe('X-Gitlab-Event header', () => {
    it('returns 400 when X-Gitlab-Event header is missing', async () => {
      const req = makeRequest({}); // no gitlabEvent

      const res = await POST(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/X-Gitlab-Event/i);
    });
  });

  // ── Event type normalization ────────────────────────────────────────────────

  describe('event type normalization', () => {
    async function getEventType(gitlabEvent: string): Promise<string> {
      const webhookAutomation = makeWebhookAutomation('my-job');
      mockGetAutomations.mockResolvedValue([webhookAutomation]);
      mockTriggerRun.mockResolvedValue({ started: true });

      const req = makeRequest({ gitlabEvent, body: {} });
      await POST(req);

      // Inspect the webhookEnv passed to triggerRun
      const [, opts] = mockTriggerRun.mock.calls[0];
      return opts.webhookEnv.GITLAB_EVENT_TYPE;
    }

    it('normalizes "Push Hook" to "push"', async () => {
      expect(await getEventType('Push Hook')).toBe('push');
    });

    it('normalizes "Merge Request Hook" to "merge_request"', async () => {
      expect(await getEventType('Merge Request Hook')).toBe('merge_request');
    });

    it('normalizes "Tag Push Hook" to "tag_push"', async () => {
      expect(await getEventType('Tag Push Hook')).toBe('tag_push');
    });

    it('normalizes "Pipeline Hook" to "pipeline"', async () => {
      expect(await getEventType('Pipeline Hook')).toBe('pipeline');
    });

    it('normalizes "Issue Hook" to "issue"', async () => {
      expect(await getEventType('Issue Hook')).toBe('issue');
    });

    it('normalizes an unknown event type by lowercasing and stripping " hook"', async () => {
      // e.g. "Custom Event Hook" → "custom_event"
      expect(await getEventType('Custom Event Hook')).toBe('custom_event');
    });
  });

  // ── Convenience env var extraction ─────────────────────────────────────────

  describe('GITLAB_EVENT_PROJECT extraction', () => {
    it('extracts GITLAB_EVENT_PROJECT from body.project.path_with_namespace', async () => {
      const webhookAutomation = makeWebhookAutomation('my-job');
      mockGetAutomations.mockResolvedValue([webhookAutomation]);

      const body = {
        project: { path_with_namespace: 'myorg/myrepo' },
      };
      const req = makeRequest({ gitlabEvent: 'Push Hook', body });
      await POST(req);

      const [, opts] = mockTriggerRun.mock.calls[0];
      expect(opts.webhookEnv.GITLAB_EVENT_PROJECT).toBe('myorg/myrepo');
    });

    it('omits GITLAB_EVENT_PROJECT when project is absent', async () => {
      const webhookAutomation = makeWebhookAutomation('my-job');
      mockGetAutomations.mockResolvedValue([webhookAutomation]);

      const req = makeRequest({ gitlabEvent: 'Push Hook', body: {} });
      await POST(req);

      const [, opts] = mockTriggerRun.mock.calls[0];
      expect(opts.webhookEnv).not.toHaveProperty('GITLAB_EVENT_PROJECT');
    });
  });

  describe('GITLAB_EVENT_REF extraction', () => {
    it('extracts GITLAB_EVENT_REF from body.ref', async () => {
      const webhookAutomation = makeWebhookAutomation('my-job');
      mockGetAutomations.mockResolvedValue([webhookAutomation]);

      const body = { ref: 'refs/heads/main' };
      const req = makeRequest({ gitlabEvent: 'Push Hook', body });
      await POST(req);

      const [, opts] = mockTriggerRun.mock.calls[0];
      expect(opts.webhookEnv.GITLAB_EVENT_REF).toBe('refs/heads/main');
    });
  });

  describe('GITLAB_EVENT_MR_IID extraction', () => {
    it('extracts GITLAB_EVENT_MR_IID from body.object_attributes.iid', async () => {
      const webhookAutomation = makeWebhookAutomation('my-job');
      mockGetAutomations.mockResolvedValue([webhookAutomation]);

      const body = { object_attributes: { iid: 42, action: 'open' } };
      const req = makeRequest({ gitlabEvent: 'Merge Request Hook', body });
      await POST(req);

      const [, opts] = mockTriggerRun.mock.calls[0];
      expect(opts.webhookEnv.GITLAB_EVENT_MR_IID).toBe('42');
    });

    it('extracts GITLAB_EVENT_ACTION from body.object_attributes.action', async () => {
      const webhookAutomation = makeWebhookAutomation('my-job');
      mockGetAutomations.mockResolvedValue([webhookAutomation]);

      const body = { object_attributes: { iid: 42, action: 'merge' } };
      const req = makeRequest({ gitlabEvent: 'Merge Request Hook', body });
      await POST(req);

      const [, opts] = mockTriggerRun.mock.calls[0];
      expect(opts.webhookEnv.GITLAB_EVENT_ACTION).toBe('merge');
    });

    it('extracts GITLAB_EVENT_PIPELINE_STATUS from body.object_attributes.status', async () => {
      const webhookAutomation = makeWebhookAutomation('my-job');
      mockGetAutomations.mockResolvedValue([webhookAutomation]);

      const body = { object_attributes: { status: 'success' } };
      const req = makeRequest({ gitlabEvent: 'Pipeline Hook', body });
      await POST(req);

      const [, opts] = mockTriggerRun.mock.calls[0];
      expect(opts.webhookEnv.GITLAB_EVENT_PIPELINE_STATUS).toBe('success');
    });
  });

  describe('GITLAB_EVENT_PAYLOAD', () => {
    it('sets GITLAB_EVENT_PAYLOAD to the JSON-stringified body', async () => {
      const webhookAutomation = makeWebhookAutomation('my-job');
      mockGetAutomations.mockResolvedValue([webhookAutomation]);

      const body = { project: { path_with_namespace: 'org/repo' }, ref: 'main' };
      const req = makeRequest({ gitlabEvent: 'Push Hook', body });
      await POST(req);

      const [, opts] = mockTriggerRun.mock.calls[0];
      expect(opts.webhookEnv.GITLAB_EVENT_PAYLOAD).toBe(JSON.stringify(body));
    });
  });

  // ── Automation filtering ────────────────────────────────────────────────────

  describe('automation filtering', () => {
    it('only triggers automations with trigger === "webhook"', async () => {
      mockGetAutomations.mockResolvedValue([
        makeWebhookAutomation('webhook-job'),
        makeOtherAutomation('manual-job', 'manual'),
        makeOtherAutomation('cron-job', 'cron'),
      ]);

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      await POST(req);

      expect(mockTriggerRun).toHaveBeenCalledTimes(1);
      expect(mockTriggerRun).toHaveBeenCalledWith('webhook-job', expect.any(Object));
    });

    it('does not call triggerRun for manual-trigger automations', async () => {
      mockGetAutomations.mockResolvedValue([
        makeOtherAutomation('manual-job', 'manual'),
      ]);

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      await POST(req);

      expect(mockTriggerRun).not.toHaveBeenCalled();
    });

    it('does not call triggerRun for cron-trigger automations', async () => {
      mockGetAutomations.mockResolvedValue([
        makeOtherAutomation('cron-job', 'cron'),
      ]);

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      await POST(req);

      expect(mockTriggerRun).not.toHaveBeenCalled();
    });
  });

  // ── No webhook automations ──────────────────────────────────────────────────

  describe('when no webhook automations exist', () => {
    it('returns { triggered: 0 }', async () => {
      mockGetAutomations.mockResolvedValue([
        makeOtherAutomation('cron-job', 'cron'),
      ]);

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.triggered).toBe(0);
    });

    it('does not call triggerRun at all', async () => {
      mockGetAutomations.mockResolvedValue([]);

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      await POST(req);

      expect(mockTriggerRun).not.toHaveBeenCalled();
    });
  });

  // ── triggerRun call correctness ─────────────────────────────────────────────

  describe('triggerRun invocation', () => {
    it('calls triggerRun with the automation name as first argument', async () => {
      mockGetAutomations.mockResolvedValue([makeWebhookAutomation('deploy-on-push')]);

      const req = makeRequest({ gitlabEvent: 'Push Hook', body: { ref: 'refs/heads/main' } });
      await POST(req);

      expect(mockTriggerRun).toHaveBeenCalledWith('deploy-on-push', expect.any(Object));
    });

    it('calls triggerRun with webhookEnv containing GITLAB_EVENT_TYPE', async () => {
      mockGetAutomations.mockResolvedValue([makeWebhookAutomation('deploy-on-push')]);

      const req = makeRequest({ gitlabEvent: 'Push Hook', body: {} });
      await POST(req);

      const [, opts] = mockTriggerRun.mock.calls[0];
      expect(opts.webhookEnv).toMatchObject({ GITLAB_EVENT_TYPE: 'push' });
    });

    it('calls triggerRun once per webhook automation', async () => {
      mockGetAutomations.mockResolvedValue([
        makeWebhookAutomation('job-a'),
        makeWebhookAutomation('job-b'),
        makeWebhookAutomation('job-c'),
      ]);

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      await POST(req);

      expect(mockTriggerRun).toHaveBeenCalledTimes(3);
    });
  });

  // ── Response shape ──────────────────────────────────────────────────────────

  describe('response body', () => {
    it('returns the correct triggered count when all runs start', async () => {
      mockGetAutomations.mockResolvedValue([
        makeWebhookAutomation('job-a'),
        makeWebhookAutomation('job-b'),
      ]);
      mockTriggerRun.mockResolvedValue({ started: true });

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      const res = await POST(req);
      const body = await res.json();

      expect(body.triggered).toBe(2);
      expect(body.total).toBe(2);
    });

    it('counts only started runs in triggered', async () => {
      mockGetAutomations.mockResolvedValue([
        makeWebhookAutomation('job-a'),
        makeWebhookAutomation('job-b'),
        makeWebhookAutomation('job-c'),
      ]);
      mockTriggerRun
        .mockResolvedValueOnce({ started: true })
        .mockResolvedValueOnce({ started: false, error: 'Already running' })
        .mockResolvedValueOnce({ started: true });

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      const res = await POST(req);
      const body = await res.json();

      expect(body.triggered).toBe(2);
      expect(body.total).toBe(3);
    });

    it('includes a results array with per-automation outcomes', async () => {
      mockGetAutomations.mockResolvedValue([makeWebhookAutomation('job-a')]);
      mockTriggerRun.mockResolvedValue({ started: true });

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      const res = await POST(req);
      const body = await res.json();

      expect(body.results).toBeInstanceOf(Array);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({ name: 'job-a', started: true });
    });

    it('returns HTTP 200 on a successful request', async () => {
      mockGetAutomations.mockResolvedValue([makeWebhookAutomation('job-a')]);

      const req = makeRequest({ gitlabEvent: 'Push Hook' });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });
  });
});
