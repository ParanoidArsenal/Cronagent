import { NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getAutomations, triggerRun } from '@/lib/backend';

/**
 * GitLab webhook receiver.
 *
 * Receives GitLab webhook events and triggers all automations with `trigger: 'webhook'`.
 * Event data is injected as environment variables prefixed with GITLAB_EVENT_.
 *
 * GitLab webhook setup:
 *   URL: https://<host>/api/webhook/gitlab
 *   Secret token: value of GITLAB_WEBHOOK_SECRET env var (required — the
 *   endpoint rejects all requests with 503 when it is not configured)
 */

// GitLab event header → normalized short name
const EVENT_MAP: Record<string, string> = {
  'Push Hook': 'push',
  'Tag Push Hook': 'tag_push',
  'Merge Request Hook': 'merge_request',
  'Note Hook': 'note',
  'Pipeline Hook': 'pipeline',
  'Issue Hook': 'issue',
  'Confidential Issue Hook': 'confidential_issue',
  'Job Hook': 'job',
  'Deployment Hook': 'deployment',
  'Release Hook': 'release',
  'Wiki Page Hook': 'wiki_page',
};

/** Constant-time string comparison (SHA-256 digests are always equal length). */
function tokensMatch(token: string, secret: string): boolean {
  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  // Fail closed: the secret token is required
  const secret = process.env.GITLAB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook/gitlab] GITLAB_WEBHOOK_SECRET is not set — rejecting webhook request');
    return Response.json(
      { error: 'Webhook not configured: GITLAB_WEBHOOK_SECRET is not set' },
      { status: 503 },
    );
  }

  const token = req.headers.get('x-gitlab-token');
  if (token === null || !tokensMatch(token, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse event type from header
  const gitlabEvent = req.headers.get('x-gitlab-event');
  if (!gitlabEvent) {
    return Response.json({ error: 'Missing X-Gitlab-Event header' }, { status: 400 });
  }

  const eventType = EVENT_MAP[gitlabEvent] ?? gitlabEvent.toLowerCase().replace(/\s+hook$/i, '').replace(/\s+/g, '_');

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Build webhook env vars
  const webhookEnv: Record<string, string> = {
    GITLAB_EVENT_TYPE: eventType,
    GITLAB_EVENT_PAYLOAD: JSON.stringify(body),
  };

  // Extract convenience variables based on event type
  const project = body.project as Record<string, unknown> | undefined;
  if (project?.path_with_namespace) {
    webhookEnv.GITLAB_EVENT_PROJECT = String(project.path_with_namespace);
  }

  if (typeof body.ref === 'string') {
    webhookEnv.GITLAB_EVENT_REF = body.ref;
  }

  const objectAttrs = body.object_attributes as Record<string, unknown> | undefined;
  if (objectAttrs?.iid != null) {
    webhookEnv.GITLAB_EVENT_MR_IID = String(objectAttrs.iid);
  }
  if (objectAttrs?.action != null) {
    webhookEnv.GITLAB_EVENT_ACTION = String(objectAttrs.action);
  }
  if (objectAttrs?.status != null) {
    webhookEnv.GITLAB_EVENT_PIPELINE_STATUS = String(objectAttrs.status);
  }

  // Find all webhook-triggered automations
  const automations = await getAutomations();
  const webhookAutomations = automations.filter((a) => a.trigger === 'webhook');

  if (webhookAutomations.length === 0) {
    return Response.json({ triggered: 0, message: 'No webhook-triggered automations found' });
  }

  // Trigger each one (fire-and-forget via triggerRun)
  const results: Array<{ name: string; started: boolean; error?: string }> = [];
  for (const automation of webhookAutomations) {
    const result = await triggerRun(automation.name, { webhookEnv });
    results.push({ name: automation.name, started: result.started, error: result.error });
  }

  const triggered = results.filter((r) => r.started).length;
  return Response.json({ triggered, total: webhookAutomations.length, results });
}
