import { type APIRequestContext } from '@playwright/test';

export function uniqueName(prefix = 'e2e-test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function createAutomation(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {},
) {
  const defaults = {
    name: uniqueName(),
    description: 'Created by Playwright e2e test',
    mode: 'claude',
    trigger: 'manual',
    schedule: null,
    timeout: 300,
    model: 'sonnet',
    mcp: [],
    sandbox: false,
    instructions: '# Test\n\nThis is a test automation.',
  };
  const data = { ...defaults, ...overrides };
  const res = await request.post('/api/automations', { data });
  return { name: data.name as string, response: res };
}

export async function deleteAutomation(request: APIRequestContext, name: string) {
  await request.delete(`/api/automations/${encodeURIComponent(name)}`).catch(() => {});
}

export async function createMcpServer(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {},
) {
  const defaults = {
    name: uniqueName('e2e-mcp'),
    command: 'echo',
    args: '["hello"]',
    env: '{}',
    enabled: true,
  };
  const data = { ...defaults, ...overrides };
  const res = await request.post('/api/mcp', { data });
  return { name: data.name as string, response: res };
}

export async function deleteMcpServer(request: APIRequestContext, name: string) {
  await request.delete(`/api/mcp/${encodeURIComponent(name)}`).catch(() => {});
}

export async function resetThrottle(request: APIRequestContext) {
  const res = await request.put('/api/settings/throttle', {
    data: { maxConcurrent: 3, maxPerHour: 20, cooldownSeconds: 0, enabled: false },
  });
  if (!res.ok()) {
    console.warn(`resetThrottle failed: ${res.status()}`);
  }
}

export async function waitForRunCompletion(
  request: APIRequestContext,
  name: string,
  timeoutMs = 15000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request.get(`/api/automations/${encodeURIComponent(name)}/run`);
    if (!res.ok()) {
      throw new Error(`Run status check failed for "${name}": ${res.status()}`);
    }
    const data = await res.json();
    if (!data.running) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Run for "${name}" did not complete within ${timeoutMs}ms`);
}
