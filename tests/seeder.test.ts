import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedDemos, DEMOS } from '../src/seeder.js';
import { loadAutomations } from '../src/loader.js';

describe('seedDemos', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'seeder-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates all demo files in an empty directory', async () => {
    const result = await seedDemos(tempDir, false);

    expect(result.created).toHaveLength(DEMOS.length);
    expect(result.skipped).toHaveLength(0);

    const files = await readdir(tempDir);
    expect(files.sort()).toEqual(DEMOS.map((d) => d.filename).sort());
  });

  it('skips existing files without --force', async () => {
    // Pre-create one file
    await writeFile(join(tempDir, DEMOS[0].filename), 'existing content', 'utf-8');

    const result = await seedDemos(tempDir, false);

    expect(result.skipped).toContain(DEMOS[0].filename);
    expect(result.created).toHaveLength(DEMOS.length - 1);

    // Original content preserved
    const content = await readFile(join(tempDir, DEMOS[0].filename), 'utf-8');
    expect(content).toBe('existing content');
  });

  it('overwrites existing files with --force', async () => {
    await writeFile(join(tempDir, DEMOS[0].filename), 'old content', 'utf-8');

    const result = await seedDemos(tempDir, true);

    expect(result.created).toHaveLength(DEMOS.length);
    expect(result.skipped).toHaveLength(0);

    const content = await readFile(join(tempDir, DEMOS[0].filename), 'utf-8');
    expect(content).not.toBe('old content');
  });

  it('creates the directory if it does not exist', async () => {
    const nestedDir = join(tempDir, 'nested', 'automations');

    const result = await seedDemos(nestedDir, false);

    expect(result.created).toHaveLength(DEMOS.length);
    const files = await readdir(nestedDir);
    expect(files).toHaveLength(DEMOS.length);
  });

  it('all demo files are loadable by the automation loader', async () => {
    await seedDemos(tempDir, false);

    const automations = await loadAutomations(tempDir);

    // All 6 should load without errors
    expect(automations).toHaveLength(DEMOS.length);

    const names = automations.map((a) => a.name).sort();
    expect(names).toEqual([
      'demo-code-review',
      'demo-daily-digest',
      'demo-disk-usage',
      'demo-full-review',
      'demo-git-cleanup',
      'demo-summarize-readme',
    ]);
  });

  it('claude-mode demos have correct fields', async () => {
    await seedDemos(tempDir, false);
    const automations = await loadAutomations(tempDir);

    const claudeDemos = automations.filter((a) => a.mode === 'claude');
    expect(claudeDemos.length).toBeGreaterThanOrEqual(3);

    for (const a of claudeDemos) {
      expect(a.model).toBe('sonnet');
      expect(a.sandbox).toBe(false);
      expect(a.instructions).toBeTruthy();
    }
  });

  it('shell-mode demos have steps', async () => {
    await seedDemos(tempDir, false);
    const automations = await loadAutomations(tempDir);

    const shellDemos = automations.filter(
      (a) => a.mode === 'shell' && !a.name.includes('full-review'),
    );
    expect(shellDemos.length).toBeGreaterThanOrEqual(2);

    for (const a of shellDemos) {
      expect(a.instructions).toContain('$');
    }
  });
});
