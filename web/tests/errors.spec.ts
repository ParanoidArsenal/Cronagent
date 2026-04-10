import { test, expect } from '@playwright/test';
import { uniqueName, createAutomation, deleteAutomation } from './helpers';

test.describe('Error handling', () => {
  test('duplicate automation name shows error', async ({ page, request }) => {
    const name = uniqueName('e2e-dup');

    // Create automation via API first
    await createAutomation(request, { name });

    try {
      // Try to create with the same name via UI
      await page.goto('/automations/new');
      await page.locator('input[placeholder="my-automation"]').fill(name);
      await page.locator('.form-textarea').fill('# Duplicate test');
      await page.getByRole('button', { name: 'Create Automation' }).click();

      // Should show error
      await expect(page.locator('.alert-error')).toBeVisible({ timeout: 5000 });
    } finally {
      await deleteAutomation(request, name);
    }
  });

  test('missing instructions shows validation error', async ({ page }) => {
    await page.goto('/automations/new');
    await page.locator('input[placeholder="my-automation"]').fill(uniqueName());

    // Explicitly clear the instructions textarea to ensure it's empty
    const textarea = page.locator('.form-textarea');
    await textarea.clear();

    // Submit without filling instructions
    await page.getByRole('button', { name: 'Create Automation' }).click();

    // Should show error about missing instructions
    await expect(page.locator('.alert-error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.alert-error')).toContainText(/[Ii]nstructions/);
  });

  test('missing cron schedule shows validation error', async ({ page }) => {
    await page.goto('/automations/new');
    await page.locator('input[placeholder="my-automation"]').fill(uniqueName());
    await page.locator('.form-textarea').fill('# Test');

    // Select cron trigger using the form-field label context
    const triggerField = page.locator('.form-field', { hasText: /^Trigger/ });
    await triggerField.locator('select.form-select').selectOption('cron');

    // Leave schedule empty and submit
    await page.getByRole('button', { name: 'Create Automation' }).click();

    // Should show error about missing schedule
    await expect(page.locator('.alert-error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.alert-error')).toContainText(/[Ss]chedule/);
  });

  test('invalid MCP args JSON shows error', async ({ page }) => {
    const name = uniqueName('e2e-mcp-err');

    await page.goto('/mcp/new');
    await page.locator('input[placeholder="e.g. jira, gitlab"]').fill(name);
    await page.locator('input[placeholder="e.g. node, npx, python"]').fill('echo');

    // Fill args with invalid JSON
    const argsTextarea = page.locator('textarea').first();
    await argsTextarea.fill('[not-valid');

    // Submit
    await page.getByRole('button', { name: 'Create Server' }).click();

    // Should show error about invalid JSON
    await expect(page.locator('.alert-error')).toBeVisible({ timeout: 5000 });
  });
});
