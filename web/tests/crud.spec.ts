import { test, expect } from '@playwright/test';

const BASE_NAME = 'e2e-test';

function uniqueName() {
  return `${BASE_NAME}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const TEST_DESCRIPTION = 'Created by Playwright e2e test';
const TEST_INSTRUCTIONS = '# Test\n\nThis is a test automation.';

test.describe('Automation CRUD', () => {
  test.describe.configure({ mode: 'serial' });

  let testName: string;

  test.beforeEach(() => {
    testName = uniqueName();
  });

  // Clean up test automation after each test via API
  test.afterEach(async ({ request }) => {
    await request.delete(`/api/automations/${encodeURIComponent(testName)}`).catch(() => {});
  });

  test('create automation via UI', async ({ page }) => {
    await page.goto('/automations/new');
    await expect(page.locator('h1')).toHaveText('New Automation');

    // Fill the form
    await page.locator('input[placeholder="my-automation"]').fill(testName);
    await page.locator('input[placeholder="What does this automation do?"]').fill(TEST_DESCRIPTION);
    await page.locator('.form-textarea').fill(TEST_INSTRUCTIONS);

    // Submit
    await page.getByRole('button', { name: 'Create Automation' }).click();

    // Should redirect to detail page
    await page.waitForURL(`/automations/${testName}`);
    await expect(page.locator('h1')).toHaveText(testName);
  });

  test('created automation appears in list', async ({ page, request }) => {
    // Create via API for setup
    await request.post('/api/automations', {
      data: {
        name: testName,
        description: TEST_DESCRIPTION,
        mode: 'claude',
        trigger: 'manual',
        schedule: null,
        timeout: 300,
        model: 'sonnet',
        mcp: [],
        sandbox: false,
        instructions: TEST_INSTRUCTIONS,
      },
    });

    await page.goto('/automations');
    await expect(page.locator('table.cs-table')).toBeVisible();
    await expect(page.locator('table.cs-table')).toContainText(testName);
  });

  test('edit automation via UI', async ({ page, request }) => {
    // Create via API for setup
    await request.post('/api/automations', {
      data: {
        name: testName,
        description: TEST_DESCRIPTION,
        mode: 'claude',
        trigger: 'manual',
        schedule: null,
        timeout: 300,
        model: 'sonnet',
        mcp: [],
        sandbox: false,
        instructions: TEST_INSTRUCTIONS,
      },
    });

    // Navigate to edit page
    await page.goto(`/automations/${testName}/edit`);
    await expect(page.locator('h1')).toContainText('Edit');

    // Change description
    const descriptionInput = page.locator('input[placeholder="What does this automation do?"]');
    await descriptionInput.clear();
    await descriptionInput.fill('Updated by e2e test');

    // Save
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await page.waitForURL(`/automations/${testName}`);

    // Verify the change persisted by going back to edit
    await page.goto(`/automations/${testName}/edit`);
    await expect(descriptionInput).toHaveValue('Updated by e2e test');
  });

  test('delete automation via UI', async ({ page, request }) => {
    // Create via API for setup
    await request.post('/api/automations', {
      data: {
        name: testName,
        description: TEST_DESCRIPTION,
        mode: 'claude',
        trigger: 'manual',
        schedule: null,
        timeout: 300,
        model: 'sonnet',
        mcp: [],
        sandbox: false,
        instructions: TEST_INSTRUCTIONS,
      },
    });

    // Register dialog handler BEFORE any navigation that could trigger it
    page.once('dialog', (dialog) => dialog.accept());

    // Navigate to edit page
    await page.goto(`/automations/${testName}/edit`);

    // Click delete
    await page.getByRole('button', { name: 'Delete' }).click();

    // Should redirect to automations list
    await page.waitForURL('/automations');

    // Verify it's gone from the rendered table/page
    await expect(page.locator('table.cs-table, .empty-state')).toBeVisible();
    const tableOrEmpty = page.locator('table.cs-table');
    const count = await tableOrEmpty.count();
    if (count > 0) {
      await expect(tableOrEmpty).not.toContainText(testName);
    }
  });

  test('automation detail page shows metadata', async ({ page, request }) => {
    // Create via API
    await request.post('/api/automations', {
      data: {
        name: testName,
        description: TEST_DESCRIPTION,
        mode: 'claude',
        trigger: 'manual',
        schedule: null,
        timeout: 300,
        model: 'sonnet',
        mcp: [],
        sandbox: false,
        instructions: TEST_INSTRUCTIONS,
      },
    });

    await page.goto(`/automations/${testName}`);
    await expect(page.locator('h1')).toHaveText(testName);
    await expect(page.locator('.meta-grid')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
  });
});
