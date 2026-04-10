import { test, expect } from '@playwright/test';
import { uniqueName, deleteAutomation, deleteMcpServer, resetThrottle, waitForRunCompletion } from './helpers';

/**
 * Happy-path E2E test — walks through the core user journey:
 *
 *  1. Dashboard loads with stats
 *  2. Create a shell automation via UI
 *  3. Verify it appears in the automations list
 *  4. View automation detail page
 *  5. Edit it (add description, change timeout)
 *  6. Run it and wait for completion
 *  7. Verify run appears in history (automation detail + global history)
 *  8. View run detail with output
 *  9. Add an MCP server
 * 10. Configure throttle settings
 * 11. Check analytics page shows the run
 * 12. Delete the automation
 * 13. Clean up MCP server
 */
test.describe('Happy path', () => {
  test.describe.configure({ mode: 'serial' });

  const automationName = uniqueName('e2e-happy');
  const mcpName = uniqueName('e2e-happy-mcp');
  const outputMarker = `happy-${Date.now()}`;
  let runId: string;

  test.afterAll(async ({ request }) => {
    await deleteAutomation(request, automationName);
    await deleteMcpServer(request, mcpName);
    await resetThrottle(request);
  });

  // ── 1. Dashboard ──────────────────────────────────────────

  test('dashboard loads with stat cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.stat-card').first()).toBeVisible();
  });

  // ── 2. Create automation via UI ───────────────────────────

  test('create shell automation via form', async ({ page }) => {
    await page.goto('/automations/new');

    // Fill form
    await page.locator('input[placeholder="my-automation"]').fill(automationName);
    await page.locator('input[placeholder*="What does this"]').fill('Happy path test automation');

    // Switch to shell mode
    await page.locator('.form-select').first().selectOption('shell');

    // Set timeout (first number input is timeout)
    const timeoutInput = page.locator('input[type="number"]').first();
    await timeoutInput.clear();
    await timeoutInput.fill('60');

    // Write shell instructions (textarea appears after mode switch)
    await page.locator('.form-textarea').fill(`echo "${outputMarker}"`);

    // Submit
    await page.getByRole('button', { name: /Create Automation/i }).click();

    // Should redirect to detail page
    await page.waitForURL(new RegExp(`/automations/${automationName}`));
    await expect(page.locator('h1')).toHaveText(automationName);
  });

  // ── 3. Verify in automations list ─────────────────────────

  test('automation appears in list', async ({ page }) => {
    await page.goto('/automations');
    await expect(page.locator('table.cs-table')).toContainText(automationName);
    await expect(page.locator('table.cs-table')).toContainText('Happy path test automation');
  });

  // ── 4. View detail page ───────────────────────────────────

  test('detail page shows metadata', async ({ page }) => {
    await page.goto(`/automations/${automationName}`);
    await expect(page.locator('h1')).toHaveText(automationName);
    await expect(page.locator('.meta-grid')).toBeVisible();
    await expect(page.locator('.output-block')).toContainText(outputMarker);
  });

  // ── 5. Edit automation ────────────────────────────────────

  test('edit automation via UI', async ({ page }) => {
    await page.goto(`/automations/${automationName}/edit`);
    await expect(page.locator('h1')).toContainText('Edit');

    // Change description
    const descInput = page.locator('input[placeholder*="What does this"]');
    await descInput.clear();
    await descInput.fill('Updated by happy-path test');

    // Save
    await page.getByRole('button', { name: /Save Changes/i }).click();
    await page.waitForURL(new RegExp(`/automations/${automationName}`));

    // Verify change on detail page
    await expect(page.locator('body')).toContainText('Updated by happy-path test');
  });

  // ── 6. Run the automation ─────────────────────────────────

  test('run automation and wait for completion', async ({ page, request }) => {
    await page.goto(`/automations/${automationName}`);

    await page.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByRole('button', { name: /Running/i })).toBeVisible({ timeout: 5000 });

    await waitForRunCompletion(request, automationName);
  });

  // ── 7. Verify run in history ──────────────────────────────

  test('run appears in automation run history', async ({ page }) => {
    await page.goto(`/automations/${automationName}`);
    await page.reload(); // ensure server-rendered data is fresh

    const runLink = page.getByRole('link', { name: /#\d+/ });
    await expect(runLink.first()).toBeVisible({ timeout: 10000 });

    // Capture run ID for the next test
    const text = await runLink.first().textContent();
    runId = text?.replace('#', '') ?? '';
    expect(runId).toBeTruthy();
  });

  test('run appears in global history page', async ({ page }) => {
    await page.goto('/history');
    await expect(page.locator('table.cs-table')).toContainText(automationName);
  });

  // ── 8. View run detail ────────────────────────────────────

  test('run detail shows output', async ({ page }) => {
    expect(runId).toBeTruthy();
    await page.goto(`/runs/${runId}`);
    await expect(page.locator('h1')).toContainText(`Run #${runId}`);
    await expect(page.locator('.output-block')).toContainText(outputMarker);
  });

  // ── 9. MCP server management ──────────────────────────────

  test('add MCP server via UI', async ({ page }) => {
    await page.goto('/mcp/new');

    await page.locator('input[placeholder*="jira"]').fill(mcpName);
    await page.locator('input[placeholder*="node"]').fill('echo');
    // args and env use defaults

    await page.getByRole('button', { name: /Create Server/i }).click();
    await page.waitForURL('/mcp');

    await expect(page.locator('table.cs-table')).toContainText(mcpName);
  });

  // ── 10. Configure throttle ────────────────────────────────

  test('configure throttle settings', async ({ page }) => {
    await page.goto('/settings');

    // Wait for form to load
    await expect(page.locator('.toggle-label').first()).toBeVisible();

    // Enable throttle — click toggle-track to trigger React onChange properly
    const checkbox = page.locator('.toggle-row input[type="checkbox"]').first();
    if (!(await checkbox.isChecked())) {
      const toggleTrack = page.locator('.toggle-row .toggle-track').first();
      await toggleTrack.click({ force: true });
    }

    // Set max concurrent to 5
    const maxConcurrentInput = page.locator('.form-field').filter({ hasText: 'Max Concurrent' }).locator('input[type="number"]');
    await maxConcurrentInput.clear();
    await maxConcurrentInput.fill('5');

    // Save
    await page.getByRole('button', { name: /Save Settings/i }).first().click();

    // Verify success message
    await expect(page.locator('.alert-success').first()).toBeVisible({ timeout: 5000 });

    // Verify persisted via API
    const res = await page.request.get('/api/settings/throttle');
    const data = await res.json();
    expect(data.enabled).toBe(true);
    expect(data.maxConcurrent).toBe(5);
  });

  // ── 11. Analytics ─────────────────────────────────────────

  test('analytics page shows run data', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.locator('h1')).toBeVisible();

    // At least the stat cards should be visible
    await expect(page.locator('.stat-card').first()).toBeVisible();

    // Per-agent stats should contain our automation
    await expect(page.locator('table.cs-table')).toContainText(automationName, { timeout: 10000 });
  });

  // ── 12. Delete automation ─────────────────────────────────

  test('delete automation via UI', async ({ page }) => {
    page.once('dialog', (dialog) => dialog.accept());

    await page.goto(`/automations/${automationName}/edit`);
    await page.getByRole('button', { name: /Delete/i }).click();

    await page.waitForURL('/automations');

    // Verify gone
    const table = page.locator('table.cs-table');
    const tableCount = await table.count();
    if (tableCount > 0) {
      await expect(table).not.toContainText(automationName);
    }
  });
});
