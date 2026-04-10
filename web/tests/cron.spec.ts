import { test, expect } from '@playwright/test';
import { uniqueName, createAutomation, deleteAutomation } from './helpers';

test.describe('Cron management', () => {
  test.describe.configure({ mode: 'serial' });

  let name: string;

  test.beforeEach(() => {
    name = uniqueName('e2e-cron');
  });

  test.afterEach(async ({ request }) => {
    // Stop cron before deleting to avoid orphaned scheduler entries
    await request.post(`/api/scheduler/${encodeURIComponent(name)}/stop`).catch(() => {});
    await deleteAutomation(request, name);
  });

  test('toggle cron start/stop and verify next-run display', async ({ page, request }) => {
    // Create a cron-triggered automation via API
    const { response } = await createAutomation(request, {
      name,
      mode: 'shell',
      trigger: 'cron',
      schedule: '*/5 * * * *',
      instructions: 'echo "cron test"',
    });
    expect(response.ok()).toBe(true);

    // Navigate to detail page (retry once if 404 due to file system sync)
    await page.goto(`/automations/${name}`);
    if (await page.locator('h1').textContent() === '404') {
      await page.waitForTimeout(1000);
      await page.reload();
    }
    await expect(page.locator('h1')).toHaveText(name);

    // Verify cron section is visible
    const cronSection = page.locator('h2.cs-section', { hasText: /Cron/ });
    await expect(cronSection).toBeVisible();

    // Verify schedule is displayed (multiple <code> elements on page; target by content)
    await expect(page.locator('code', { hasText: '*/5 * * * *' })).toBeVisible();

    // Click toggle-track to trigger React onChange properly
    const toggleTrack = page.locator('.toggle-row .toggle-track');

    // Click start toggle
    await toggleTrack.click({ force: true });

    // Wait for "Cron enabled" label to appear (loading state clears)
    await expect(page.locator('.toggle-label')).toContainText('enabled', { timeout: 10000 });

    // Verify "Next run:" text appears
    await expect(page.getByText('Next run:')).toBeVisible({ timeout: 10000 });

    // Click stop toggle
    await toggleTrack.click({ force: true });

    // Wait for "Cron disabled" label
    await expect(page.locator('.toggle-label')).toContainText('disabled', { timeout: 10000 });

    // "Next run:" should no longer be visible
    await expect(page.getByText('Next run:')).not.toBeVisible();
  });
});
