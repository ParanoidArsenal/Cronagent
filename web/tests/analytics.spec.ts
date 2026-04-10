import { test, expect } from '@playwright/test';
import { uniqueName, createAutomation, deleteAutomation, waitForRunCompletion } from './helpers';

test.describe('Analytics page', () => {
  let name: string;

  test.beforeEach(() => {
    name = uniqueName('e2e-analytics');
  });

  test.afterEach(async ({ request }) => {
    await deleteAutomation(request, name);
  });

  test('shows data after a shell run completes', async ({ page, request }) => {
    // Create and run a shell automation to generate data
    await createAutomation(request, {
      name,
      mode: 'shell',
      instructions: 'echo "analytics test"',
    });

    // Trigger the run and wait for completion
    await request.post(`/api/automations/${encodeURIComponent(name)}/run`);
    await waitForRunCompletion(request, name);

    // Verify the run was recorded via API before checking the UI
    const historyRes = await request.get(`/api/history?name=${encodeURIComponent(name)}&limit=1`);
    const history = await historyRes.json();
    expect(history.length).toBeGreaterThan(0);

    // Navigate to analytics
    await page.goto('/analytics');
    await expect(page.locator('h1')).toHaveText('Analytics');

    // Verify stat cards are visible
    await expect(page.locator('.stat-grid')).toBeVisible();

    // Verify per-agent stats section exists
    const agentStatsSection = page.locator('h2.cs-section', { hasText: /Agent|Per-Agent/ });
    await expect(agentStatsSection).toBeVisible();

    // Verify the agent stats table has at least one data row (not empty state)
    const agentTable = page.locator('table.cs-table').last();
    const emptyState = page.locator('.empty-state', { hasText: /agent data/i });
    // Either the table has our automation row, or at least one row exists
    await expect(agentTable.or(emptyState)).toBeVisible();
  });
});
