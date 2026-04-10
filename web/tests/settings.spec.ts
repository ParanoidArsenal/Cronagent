import { test, expect } from '@playwright/test';

test.describe('Settings — Throttle', () => {
  // Reset throttle config after each test
  test.afterEach(async ({ request }) => {
    await request.put('/api/settings/throttle', {
      data: {
        maxConcurrent: 3,
        maxPerHour: 20,
        cooldownSeconds: 0,
        enabled: false,
      },
    });
  });

  test('throttle form loads with current values', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1')).toHaveText('Settings');

    // Wait for the throttle form to load (first toggle-label belongs to throttle)
    await expect(page.locator('.toggle-label').first()).toBeVisible();

    // Verify the form has numeric inputs for config fields
    const maxConcurrentInput = page.locator('.form-field').filter({ hasText: 'Max Concurrent' }).locator('input[type="number"]');
    await expect(maxConcurrentInput).toBeVisible();
  });

  test('toggle throttle, save, and verify persistence', async ({ page }) => {
    await page.goto('/settings');

    // Wait for form to load
    await expect(page.locator('.toggle-label').first()).toBeVisible();

    // Click the toggle-track (visible part) to trigger React onChange properly
    const checkbox = page.locator('.toggle-row input[type="checkbox"]').first();
    const wasChecked = await checkbox.isChecked();
    const toggleTrack = page.locator('.toggle-row .toggle-track').first();
    await toggleTrack.click({ force: true });

    // Wait for inputs to become enabled after toggling on
    const maxConcurrentInput = page.locator('.form-field').filter({ hasText: 'Max Concurrent' }).locator('input[type="number"]');
    await expect(maxConcurrentInput).toBeEnabled();

    // Change max concurrent
    await maxConcurrentInput.clear();
    await maxConcurrentInput.fill('5');

    // Save (first Save Settings button = throttle)
    await page.getByRole('button', { name: 'Save Settings' }).first().click();

    // Verify success message
    await expect(page.locator('.alert-success').first()).toBeVisible();

    // Wait for save cycle to fully complete
    await expect(page.getByRole('button', { name: 'Save Settings' }).first()).toBeEnabled();

    // Reload and verify persistence
    await page.reload();
    await expect(page.locator('.toggle-label').first()).toBeVisible();

    // Check the toggle state flipped
    const reloadedCheckbox = page.locator('.toggle-row input[type="checkbox"]').first();
    const isNowChecked = await reloadedCheckbox.isChecked();
    expect(isNowChecked).toBe(!wasChecked);

    // Check max concurrent persisted
    await expect(maxConcurrentInput).toHaveValue('5');
  });

  test('verify settings via API after UI save', async ({ page, request }) => {
    await page.goto('/settings');

    // Wait for form
    await expect(page.locator('.toggle-label').first()).toBeVisible();

    // Enable throttling: click toggle-track to trigger React onChange properly
    const checkbox = page.locator('.toggle-row input[type="checkbox"]').first();
    if (!(await checkbox.isChecked())) {
      const toggleTrack = page.locator('.toggle-row .toggle-track').first();
      await toggleTrack.click({ force: true });
    }

    // Wait for inputs to become enabled
    const maxPerHourInput = page.locator('.form-field').filter({ hasText: 'Max Runs Per Hour' }).locator('input[type="number"]');
    await expect(maxPerHourInput).toBeEnabled();

    // Set values
    await maxPerHourInput.clear();
    await maxPerHourInput.fill('10');

    // Save (first Save Settings button = throttle)
    await page.getByRole('button', { name: 'Save Settings' }).first().click();
    await expect(page.locator('.alert-success').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Settings' }).first()).toBeEnabled();

    // Verify via API
    const response = await request.get('/api/settings/throttle');
    const data = await response.json();
    expect(data.enabled).toBe(true);
    expect(data.maxPerHour).toBe(10);
  });
});
