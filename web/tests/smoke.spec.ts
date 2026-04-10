import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('Dashboard page loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.locator('.stat-grid')).toBeVisible();
  });

  test('Automations page loads', async ({ page }) => {
    await page.goto('/automations');
    await expect(page.locator('h1')).toHaveText('Automations');
    await expect(page.locator('table.cs-table, .empty-state')).toBeVisible();
  });

  test('History page loads', async ({ page }) => {
    await page.goto('/history');
    await expect(page.locator('h1')).toHaveText('Run History');
  });

  test('Settings page loads', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1')).toHaveText('Settings');
    // Wait for throttle form to finish loading
    await expect(page.locator('.toggle-label').first()).toBeVisible();
  });
});

test.describe('Navigation', () => {
  test('navigate between all main pages via sidebar', async ({ page }) => {
    await page.goto('/');

    // Dashboard -> Automations
    await page.getByRole('link', { name: 'Automations' }).click();
    await page.waitForURL('/automations');
    await expect(page.locator('h1')).toHaveText('Automations');

    // Automations -> History
    await page.getByRole('link', { name: 'History' }).click();
    await page.waitForURL('/history');
    await expect(page.locator('h1')).toHaveText('Run History');

    // History -> Settings
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL('/settings');
    await expect(page.locator('h1')).toHaveText('Settings');

    // Settings -> Dashboard
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.waitForURL('/');
    await expect(page.locator('h1')).toHaveText('Dashboard');
  });

  test('sidebar shows active link', async ({ page }) => {
    await page.goto('/automations');
    const automationsLink = page.locator('.sidebar-link', { hasText: 'Automations' });
    await expect(automationsLink).toHaveClass(/active/);

    const dashboardLink = page.locator('.sidebar-link', { hasText: 'Dashboard' });
    await expect(dashboardLink).not.toHaveClass(/active/);
  });
});
