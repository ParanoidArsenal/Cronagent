import { test, expect } from '@playwright/test';
import { uniqueName, createMcpServer, deleteMcpServer } from './helpers';

test.describe('MCP server management', () => {
  test.describe.configure({ mode: 'serial' });

  let name: string;

  test.beforeEach(() => {
    name = uniqueName('e2e-mcp');
  });

  test.afterEach(async ({ request }) => {
    await deleteMcpServer(request, name);
  });

  test('create MCP server via UI', async ({ page }) => {
    await page.goto('/mcp/new');
    await expect(page.locator('h1')).toContainText('Add MCP Server');

    // Fill form
    await page.locator('input[placeholder="e.g. jira, gitlab"]').fill(name);
    await page.locator('input[placeholder="e.g. node, npx, python"]').fill('echo');

    // Submit
    await page.getByRole('button', { name: 'Create Server' }).click();

    // Should redirect to MCP list
    await page.waitForURL('/mcp');

    // Verify it appears in the table
    await expect(page.locator('table.cs-table')).toContainText(name);
  });

  test('edit MCP server via UI', async ({ page, request }) => {
    // Create via helper — args/env must be proper types, not strings
    const { response } = await createMcpServer(request, {
      name,
      command: 'echo',
      args: [],
      env: {},
      enabled: true,
    });
    expect(response.ok()).toBe(true);

    // Navigate to edit page
    await page.goto(`/mcp/${name}/edit`);
    await expect(page.locator('h1')).toContainText(name);

    // Change command
    const commandInput = page.locator('input[placeholder="e.g. node, npx, python"]');
    await commandInput.clear();
    await commandInput.fill('cat');

    // Save
    await page.getByRole('button', { name: 'Update Server' }).click();
    await page.waitForURL('/mcp');

    // Verify update via API
    const res = await request.get(`/api/mcp/${encodeURIComponent(name)}`);
    const data = await res.json();
    expect(data.command).toBe('cat');
  });

  test('toggle MCP server enable/disable on list page', async ({ page, request }) => {
    // Create via helper (enabled: true) — args/env must be proper types
    const { response } = await createMcpServer(request, {
      name,
      command: 'echo',
      args: [],
      env: {},
      enabled: true,
    });
    expect(response.ok()).toBe(true);

    await page.goto('/mcp');
    await expect(page.locator('table.cs-table')).toContainText(name);

    // Find the toggle for our server row
    const row = page.locator('table.cs-table tbody tr', { hasText: name });
    const checkbox = row.locator('label.toggle input[type="checkbox"]');
    await expect(checkbox).toBeChecked();

    // Disable — click the label.toggle (force:true in case it's partially obscured in table)
    const toggleLabel = row.locator('label.toggle');
    await toggleLabel.click({ force: true });
    await expect(checkbox).not.toBeChecked({ timeout: 5000 });

    // Wait for the toggle API call to complete (checkbox re-enables when done)
    await expect(checkbox).toBeEnabled({ timeout: 5000 });

    // Verify via API
    const res = await request.get(`/api/mcp/${encodeURIComponent(name)}`);
    const data = await res.json();
    expect(data.enabled).toBe(false);
  });
});
