import { NextRequest } from 'next/server';
import { getAutomations, triggerRun } from '@/lib/backend';

/**
 * GitLab webhook receiver.
 *
 * Receives GitLab webhook events and triggers all automations with `trigger: 'webhook'`.
 * Event data is injected as environment variables prefixed with GITLAB_EVENT_.
 *
 * GitLab webhook setup:
 *   URL: https://<host>/api/webhook/gitlab
 *   Secret token: value of GITLAB_WEBHOOK_SECRET env var
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

export async function POST(req: NextRequest) {
  // Validate secret token if configured
  const secret = process.env.GITLAB_WEBHOOK_SECRET;
  if (secret) {
    const token = req.headers.get('x-gitlab-token');
    if (token !== secret) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
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
