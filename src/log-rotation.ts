import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';

/**
 * Delete log files older than `retentionDays` from `logsDir`.
 * Best-effort: logs warnings on per-file failures, tolerates missing directory.
 */
export async function pruneOldLogs(logsDir: string, retentionDays: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return; // logs/ doesn't exist yet — nothing to prune
    }
    throw err;
  }

  const cutoff = Date.now() - retentionDays * 86_400_000;
  let deleted = 0;
  let failed = 0;

  for (const name of entries) {
    const filePath = join(logsDir, name);
    try {
      const info = await stat(filePath);
      if (info.mtimeMs < cutoff) {
        await unlink(filePath);
        deleted++;
      }
    } catch (err) {
      failed++;
      logger.warn({ err, filePath }, 'Failed to prune old log file');
    }
  }

  if (deleted > 0 || failed > 0) {
    logger.info({ deleted, failed, retentionDays }, 'Log rotation complete');
  }
}
