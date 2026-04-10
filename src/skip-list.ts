import { History } from './history.js';
import { logger } from './logger.js';
import type { SkipEntry } from './types.js';

const SKIP_LIST_KEY = 'skip_list';
const DEFAULT_THRESHOLD = 2;

export class SkipList {
  private history: History;
  private threshold: number;

  constructor(history: History, threshold = DEFAULT_THRESHOLD) {
    this.history = history;
    this.threshold = threshold;
  }

  async has(name: string): Promise<boolean> {
    const entries = await this.getEntries();
    return name in entries;
  }

  async list(): Promise<SkipEntry[]> {
    const entries = await this.getEntries();
    return Object.entries(entries).map(([automationName, entry]) => ({
      automationName,
      consecutiveFailures: entry.consecutiveFailures,
      addedAt: entry.addedAt,
    }));
  }

  async recordFailure(name: string): Promise<void> {
    const count = await this.history.getConsecutiveFailures(name, Math.max(this.threshold, 20));
    if (count >= this.threshold) {
      const entries = await this.getEntries();
      if (!(name in entries)) {
        entries[name] = {
          consecutiveFailures: count,
          addedAt: new Date().toISOString(),
        };
        await this.history.setSetting(SKIP_LIST_KEY, entries);
        logger.info(
          { name, consecutiveFailures: count, threshold: this.threshold },
          'Automation added to skip list',
        );
      }
    }
  }

  async recordSuccess(name: string): Promise<void> {
    const entries = await this.getEntries();
    if (name in entries) {
      delete entries[name];
      await this.history.setSetting(SKIP_LIST_KEY, entries);
      logger.info({ name }, 'Automation removed from skip list (success)');
    }
  }

  async remove(name: string): Promise<void> {
    const entries = await this.getEntries();
    if (name in entries) {
      delete entries[name];
      await this.history.setSetting(SKIP_LIST_KEY, entries);
      logger.info({ name }, 'Automation removed from skip list (manual)');
    }
  }

  async clear(): Promise<void> {
    await this.history.setSetting(SKIP_LIST_KEY, {});
    logger.info('Skip list cleared');
  }

  async prePopulate(): Promise<void> {
    const failedNames = await this.history.getFailedTasks(this.threshold);
    if (failedNames.length === 0) return;

    const entries = await this.getEntries();
    for (const name of failedNames) {
      if (!(name in entries)) {
        const count = await this.history.getConsecutiveFailures(name, Math.max(this.threshold, 20));
        entries[name] = {
          consecutiveFailures: count,
          addedAt: new Date().toISOString(),
        };
      }
    }
    await this.history.setSetting(SKIP_LIST_KEY, entries);
    logger.info(
      { count: failedNames.length, names: failedNames },
      'Skip list pre-populated from history',
    );
  }

  private async getEntries(): Promise<Record<string, { consecutiveFailures: number; addedAt: string }>> {
    const raw = await this.history.getSetting<Record<string, { consecutiveFailures: number; addedAt: string }>>(SKIP_LIST_KEY);
    return raw ?? {};
  }
}
