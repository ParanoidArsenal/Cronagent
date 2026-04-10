import { test, expect } from '@playwright/test';

test.describe('Navigation — extended', () => {
  // Reset locale to English after each test to prevent leaking Russian state
  test.afterEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test('navigate to MCP Servers page via sidebar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'MCP Servers' }).click();
    await page.waitForURL('/mcp');
    await expect(page.locator('h1')).toHaveText('MCP Servers');
  });

  test('navigate to Analytics page via sidebar', async ({ page }) => {
    await page.goto('/');
    // Use exact match to avoid matching dashboard content containing "analytics"
    await page.getByRole('complementary').getByRole('link', { name: 'Analytics' }).click();
    await page.waitForURL('/analytics');
    await expect(page.locator('h1')).toHaveText('Analytics');
  });

  test('locale toggle switches to Russian and back', async ({ page }) => {
    await page.goto('/automations');
    await expect(page.locator('h1')).toHaveText('Automations');

    // Click RU button in sidebar (scope to complementary/aside to avoid matching "Run" buttons)
    await page.getByRole('complementary').getByRole('button', { name: 'RU', exact: true }).click();

    // Wait for Russian heading to appear (router.refresh, no URL change)
    await expect(page.locator('h1')).toHaveText('Автоматизации', { timeout: 10000 });

    // Sidebar links should also be in Russian
    await expect(page.locator('.sidebar-link', { hasText: 'Панель' })).toBeVisible();

    // Switch back to English
    await page.getByRole('complementary').getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.locator('h1')).toHaveText('Automations', { timeout: 10000 });
  });
});
