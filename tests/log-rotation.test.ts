import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readdir, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneOldLogs } from '../src/log-rotation.ts';

describe('pruneOldLogs', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = await mkdtemp(join(tmpdir(), 'log-rotation-test-'));
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('deletes files older than retention threshold', async () => {
    const oldFile = join(logsDir, 'test_2026-01-01T00-00-00-000Z.log');
    const freshFile = join(logsDir, 'test_2026-04-10T00-00-00-000Z.log');

    await writeFile(oldFile, 'old log data');
    await writeFile(freshFile, 'fresh log data');

    // Set old file mtime to 31 days ago
    const past = new Date(Date.now() - 31 * 86_400_000);
    await utimes(oldFile, past, past);

    await pruneOldLogs(logsDir, 30);

    const remaining = await readdir(logsDir);
    expect(remaining).toEqual([
      'test_2026-04-10T00-00-00-000Z.log',
    ]);
  });

  it('keeps all files when none exceed retention', async () => {
    await writeFile(join(logsDir, 'a.log'), 'data');
    await writeFile(join(logsDir, 'b.log'), 'data');

    await pruneOldLogs(logsDir, 30);

    const remaining = await readdir(logsDir);
    expect(remaining.sort()).toEqual(['a.log', 'b.log']);
  });

  it('tolerates a missing logs directory', async () => {
    const missingDir = join(logsDir, 'nonexistent');
    // Should not throw
    await pruneOldLogs(missingDir, 30);
  });

  it('handles an empty logs directory', async () => {
    await pruneOldLogs(logsDir, 30);
    const remaining = await readdir(logsDir);
    expect(remaining).toEqual([]);
  });
});
