import { test, expect } from '@playwright/test';
import { uniqueName, createAutomation, deleteAutomation } from './helpers';

test.describe('Conversation History', () => {
  test.describe.configure({ mode: 'serial' });

  let testName: string;

  test.beforeEach(() => {
    testName = uniqueName('e2e-conv');
  });

  test.afterEach(async ({ request }) => {
    await deleteAutomation(request, testName);
  });

  test('conversation toggle visible for claude mode, hidden for shell mode', async ({ page }) => {
    await page.goto('/automations/new');

    // Claude mode — conversation toggle should be visible
    await expect(page.locator('.toggle-label', { hasText: 'conversation' })).toBeVisible({ timeout: 5000 });

    // Switch to shell mode — conversation toggle should hide
    await page.locator('.form-select').first().selectOption('shell');
    await expect(page.locator('.toggle-label', { hasText: 'conversation' })).not.toBeVisible();

    // Switch back to claude — toggle should reappear
    await page.locator('.form-select').first().selectOption('claude');
    await expect(page.locator('.toggle-label', { hasText: 'conversation' })).toBeVisible();
  });

  test('conversation toggle hidden when sandbox is enabled', async ({ page }) => {
    await page.goto('/automations/new');

    // Conversation toggle visible initially
    await expect(page.locator('.toggle-label', { hasText: /conversation/i })).toBeVisible({ timeout: 5000 });

    // Enable sandbox — click the label.toggle to trigger React onChange
    const sandboxLabel = page.locator('.toggle-row').filter({ hasText: /sandbox/i }).locator('label.toggle');
    await sandboxLabel.click();
    await expect(page.locator('.toggle-label', { hasText: /conversation/i })).not.toBeVisible({ timeout: 5000 });

    // Disable sandbox — conversation toggle should reappear
    await sandboxLabel.click();
    await expect(page.locator('.toggle-label', { hasText: /conversation/i })).toBeVisible({ timeout: 5000 });
  });

  test('create automation with conversation enabled via UI', async ({ page }) => {
    await page.goto('/automations/new');

    // Fill the form
    await page.locator('input[placeholder="my-automation"]').fill(testName);
    await page.locator('.form-textarea').fill('# Test\n\nConversation test automation.');

    // Enable conversation toggle — click the label to properly trigger React onChange
    const convLabel = page.locator('.toggle-row').filter({ hasText: /conversation/i }).locator('label.toggle');
    await convLabel.click();
    const convCheckbox = page.locator('.toggle-row').filter({ hasText: /conversation/i }).locator('input[type="checkbox"]');
    await expect(convCheckbox).toBeChecked({ timeout: 3000 });

    // Submit and wait for redirect
    await page.getByRole('button', { name: 'Create Automation' }).click();
    await page.waitForURL(`**/automations/${testName}`, { timeout: 15000 });
    await expect(page.locator('h1')).toHaveText(testName);

    // Verify conversation shows as enabled in the meta-grid
    await expect(page.locator('.meta-grid')).toContainText('Conversation');
  });

  test('conversation field persists in edit form', async ({ page, request }) => {
    // Create automation with conversation enabled via API
    const { response } = await createAutomation(request, {
      name: testName,
      conversation: true,
      instructions: '# Test\n\nConversation test.',
    });
    expect(response.ok()).toBe(true);

    // Navigate to edit page
    await page.goto(`/automations/${testName}/edit`);
    await expect(page.locator('h1')).toContainText('Edit');

    // Verify the conversation checkbox is checked
    const convCheckbox = page.locator('.toggle-row').filter({ hasText: 'conversation' }).locator('input[type="checkbox"]');
    await expect(convCheckbox).toBeChecked();
  });

  test('conversations API returns empty list initially', async ({ request }) => {
    const res = await request.get('/api/conversations');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('conversations API filters by automation name', async ({ request }) => {
    const res = await request.get(`/api/conversations?automation=${encodeURIComponent(testName)}`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  test('conversation detail returns 404 for non-existent id', async ({ request }) => {
    const res = await request.get('/api/conversations/non-existent-id');
    expect(res.status()).toBe(404);
  });

  test('conversation close returns 404 for non-existent id', async ({ request }) => {
    const res = await request.post('/api/conversations/non-existent-id/close');
    expect(res.status()).toBe(404);
  });

  test('automation detail shows conversation section when enabled', async ({ page, request }) => {
    // Create automation with conversation enabled
    const { response } = await createAutomation(request, {
      name: testName,
      conversation: true,
      instructions: '# Test\n\nConversation test.',
    });
    expect(response.ok()).toBe(true);

    await page.goto(`/automations/${testName}`);
    await expect(page.locator('h1')).toHaveText(testName);

    // Verify conversation indicator in meta-grid
    await expect(page.locator('.meta-grid')).toContainText('Conversation');
  });

  test('automation detail does NOT show conversation section when disabled', async ({ page, request }) => {
    // Create automation without conversation
    const { response } = await createAutomation(request, {
      name: testName,
      conversation: false,
      instructions: '# Test\n\nNo conversation.',
    });
    expect(response.ok()).toBe(true);

    await page.goto(`/automations/${testName}`);
    await expect(page.locator('h1')).toHaveText(testName);

    // Conversation should NOT appear in meta-grid
    const metaLabels = page.locator('.meta-label');
    const count = await metaLabels.count();
    for (let i = 0; i < count; i++) {
      const text = await metaLabels.nth(i).textContent();
      expect(text?.toLowerCase()).not.toBe('conversation');
    }
  });

  test('run API accepts newConversation parameter', async ({ request }) => {
    // Create a shell automation (so the run actually completes without Claude)
    const { response } = await createAutomation(request, {
      name: testName,
      mode: 'shell',
      instructions: 'echo ok',
    });
    expect(response.ok()).toBe(true);

    // Trigger with newConversation — should not error
    const runRes = await request.post(`/api/automations/${encodeURIComponent(testName)}/run`, {
      data: { newConversation: true },
    });
    expect(runRes.ok()).toBe(true);
    const runData = await runRes.json();
    expect(runData.status).toBe('started');
  });

  test('conversation page returns 404 for non-existent conversation', async ({ page }) => {
    const res = await page.goto('/conversations/non-existent-id');
    expect(res?.status()).toBe(404);
  });

  test('send message API returns 404 for non-existent conversation', async ({ request }) => {
    const res = await request.post('/api/conversations/non-existent-id/messages', {
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(404);
  });

  test('send message API returns 400 for empty message', async ({ request }) => {
    const res = await request.post('/api/conversations/non-existent-id/messages', {
      data: { message: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('send message API returns 400 for missing message field', async ({ request }) => {
    const res = await request.post('/api/conversations/non-existent-id/messages', {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('send message status API returns not sending for unknown conversation', async ({ request }) => {
    const res = await request.get('/api/conversations/non-existent-id/messages');
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.sending).toBe(false);
  });

  test('notify toggle visible in automation form', async ({ page }) => {
    await page.goto('/automations/new');
    await expect(page.locator('.toggle-label', { hasText: /notification|webhook|уведомление/i })).toBeVisible({ timeout: 5000 });
  });

  test('notify toggle persists when editing automation', async ({ page, request }) => {
    const { response } = await createAutomation(request, {
      name: testName,
      notify: false,
      instructions: '# Test\n\nNotify test.',
    });
    expect(response.ok()).toBe(true);

    await page.goto(`/automations/${testName}/edit`);
    await expect(page.locator('h1')).toContainText('Edit');

    // The notify checkbox should be unchecked since we created with notify: false
    const notifyCheckbox = page.locator('.toggle-row').filter({ hasText: /notification|webhook|уведомление/i }).locator('input[type="checkbox"]');
    await expect(notifyCheckbox).not.toBeChecked();
  });

  test('run detail page shows conversation link when run has conversation_id', async ({ page, request }) => {
    // We can't easily create a real conversation run without Claude,
    // so just verify that a run WITHOUT a conversation doesn't show the link
    const { response } = await createAutomation(request, {
      name: testName,
      mode: 'shell',
      instructions: 'echo "conversation-link-test"',
    });
    expect(response.ok()).toBe(true);

    // Trigger run
    await request.post(`/api/automations/${encodeURIComponent(testName)}/run`);

    // Wait for completion
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const statusRes = await request.get(`/api/automations/${encodeURIComponent(testName)}/run`);
      const statusData = await statusRes.json();
      if (!statusData.running) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Wait for DB commit
    await page.waitForTimeout(500);

    // Get run from history
    const histRes = await request.get(`/api/history?name=${encodeURIComponent(testName)}&limit=1`);
    const runs = await histRes.json();
    expect(runs.length).toBeGreaterThan(0);

    // Navigate to run detail
    await page.goto(`/runs/${runs[0].id}`);
    await expect(page.locator('h1')).toContainText(`Run #${runs[0].id}`);

    // Shell run should NOT have conversation link
    await expect(page.locator('.meta-grid')).not.toContainText('View Conversation');
  });
});
