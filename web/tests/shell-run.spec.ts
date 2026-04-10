import { test, expect } from '@playwright/test';
import { uniqueName, createAutomation, deleteAutomation, waitForRunCompletion } from './helpers';

test.describe('Shell automation run', () => {
  test.describe.configure({ mode: 'serial' });

  let name: string;

  test.beforeEach(() => {
    name = uniqueName('e2e-shell');
  });

  test.afterEach(async ({ request }) => {
    await deleteAutomation(request, name);
  });

  test('create shell automation, run, and verify output in run detail', async ({
    page,
    request,
  }) => {
    const outputMarker = `e2e-output-marker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Create shell automation via API
    await createAutomation(request, {
      name,
      mode: 'shell',
      instructions: `echo "${outputMarker}"`,
    });

    // Navigate to detail page
    await page.goto(`/automations/${name}`);
    await expect(page.locator('h1')).toHaveText(name);

    // Click Run button
    await page.getByRole('button', { name: 'Run' }).click();

    // Wait for run to complete via API polling
    await waitForRunCompletion(request, name);

    // Wait a moment for DB commit, then reload
    await page.waitForTimeout(500);
    await page.reload();

    // Wait for the history table run link to appear
    const runLink = page.getByRole('link', { name: /#\d+/ });
    await expect(runLink.first()).toBeVisible({ timeout: 10000 });
    await runLink.first().click();

    // Verify we're on the run detail page
    await expect(page.locator('h1')).toContainText('Run #');

    // Verify output contains our marker
    await expect(page.locator('.output-block')).toContainText(outputMarker);
  });

  test('run button shows Running state during execution', async ({ page, request }) => {
    // Create shell automation with a slightly longer command
    await createAutomation(request, {
      name,
      mode: 'shell',
      instructions: 'sleep 2 && echo done',
    });

    await page.goto(`/automations/${name}`);
    await page.getByRole('button', { name: 'Run' }).click();

    // Should show "Running..." state
    await expect(page.getByRole('button', { name: 'Running...' })).toBeVisible({ timeout: 5000 });

    // Wait for completion
    await waitForRunCompletion(request, name, 20000);
  });
});
