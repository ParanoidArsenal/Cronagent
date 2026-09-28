#!/usr/bin/env node

import { Command } from 'commander';
import { join } from 'node:path';
import { loadAutomations } from './loader.js';
import { Runner } from './runner.js';
import { History } from './history.js';
import { Scheduler, isCronEnabled } from './scheduler.js';
import { Composer, isComposedAutomation } from './composer.js';
import { Notifier } from './notifier.js';
import { SkipList } from './skip-list.js';
import { pruneOldLogs } from './log-rotation.js';
import { LOGS_DIR } from './runner.js';
import { Repl } from './repl.js';
import { seedDemos } from './seeder.js';
import { logger } from './logger.js';

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_AUTOMATIONS_DIR = join(process.cwd(), 'automations');
const DEFAULT_DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/cronagent';
const DEFAULT_MCP_CONFIG = join(process.cwd(), 'mcp.json');

// ── CLI ──────────────────────────────────────────────────

const program = new Command();

program
  .name('cronagent')
  .description('Personal automation hub — define, run, compose, and schedule automations')
  .version('0.1.0')
  .option('-d, --dir <path>', 'Automations directory', DEFAULT_AUTOMATIONS_DIR)
  .option('--database-url <url>', 'PostgreSQL connection URL', DEFAULT_DATABASE_URL)
  .option('--mcp <path>', 'MCP config path', DEFAULT_MCP_CONFIG);

// ── REPL Command (default) ──────────────────────────────────

program
  .command('repl', { isDefault: true })
  .description('Start interactive REPL')
  .action(async () => {
    const opts = program.opts();
    const { runner, history, scheduler, automations, skipList } = await setup(opts);

    const repl = new Repl(runner, history, scheduler, automations, opts.dir, skipList);
    await repl.start();
  });

// ── Run Command ──────────────────────────────────────────

program
  .command('run <name>')
  .description('Execute a single automation')
  .action(async (name: string) => {
    const opts = program.opts();
    const { runner, history, automations, notifier } = await setup(opts);

    const automation = automations.find((a) => a.name === name);
    if (!automation) {
      console.error(`Automation "${name}" not found.`);
      console.error('Available:', automations.map((a) => a.name).join(', '));
      process.exit(1);
    }

    // Check if composed
    let result;
    if (isComposedAutomation(automation.instructions)) {
      const composer = new Composer(runner, automations, notifier);
      result = await composer.execute(automation);
    } else {
      result = await runner.execute(automation);
    }

    await history.insert(result);

    if (result.success) {
      if (result.output) console.log(result.output);
      logger.info(
        { name, durationMs: result.durationMs, costUsd: result.costUsd },
        'Automation completed',
      );
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }

    await history.close();
  });

// ── Daemon Command ──────────────────────────────────────────

program
  .command('daemon')
  .description('Start cron scheduler daemon')
  .action(async () => {
    const opts = program.opts();
    const { scheduler, automations, history } = await setup(opts, { daemon: true });

    scheduler.start(automations);

    const status = scheduler.getStatus();
    logger.info({ jobs: status.length }, 'Daemon running');
    for (const s of status) {
      const enabled = await isCronEnabled(history, s.name);
      logger.info({ name: s.name, schedule: s.schedule, nextRun: s.nextRun, enabled }, 'Scheduled');
    }

    // Graceful shutdown
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutdown signal received');
      scheduler.shutdown();
      const { timedOut } = await scheduler.waitForIdle(30_000);
      await history.close();
      process.exit(timedOut ? 1 : 0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT').catch((err) => {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM').catch((err) => {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }));
  });

// ── List Command ────────────────────────────────────────────

program
  .command('list')
  .description('List all automations')
  .action(async () => {
    const opts = program.opts();
    const automations = await loadAutomations(opts.dir);

    if (automations.length === 0) {
      console.log('No automations found.');
      return;
    }

    for (const a of automations) {
      const trigger = a.trigger === 'cron' ? `cron(${a.schedule})` : a.trigger;
      console.log(`  ${a.name.padEnd(20)} ${a.mode.padEnd(8)} ${trigger.padEnd(25)} ${a.description}`);
    }
  });

// ── History Command ─────────────────────────────────────────

program
  .command('history [name]')
  .description('Show execution history')
  .option('-n, --limit <n>', 'Number of records', '10')
  .action(async (name: string | undefined, cmdOpts: { limit: string }) => {
    const opts = program.opts();
    const history = await History.create(opts.databaseUrl);
    const records = await history.getHistory(name, parseInt(cmdOpts.limit, 10));

    if (records.length === 0) {
      console.log('No history found.');
    } else {
      for (const r of records) {
        const status = r.success ? 'OK' : 'FAIL';
        const cost = r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : '-';
        console.log(
          `  ${r.started_at.toISOString()}  ${r.automation_name.padEnd(20)} ${status.padEnd(6)} ${String(r.duration_ms).padEnd(8)}ms  ${cost}`,
        );
      }
    }

    await history.close();
  });

// ── Seed Command ──────────────────────────────────────────

program
  .command('seed')
  .description('Populate automations directory with demo examples')
  .option('--force', 'Overwrite existing demo files', false)
  .action(async (cmdOpts: { force: boolean }) => {
    try {
      const opts = program.opts();
      const { created, skipped } = await seedDemos(opts.dir, cmdOpts.force);

      if (created.length > 0) {
        console.log(`Created ${created.length} demo automation(s):`);
        for (const f of created) console.log(`  + ${f}`);
      }
      if (skipped.length > 0) {
        console.log(`Skipped ${skipped.length} (already exist):`);
        for (const f of skipped) console.log(`  - ${f}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`seed failed: ${msg}`);
      process.exit(1);
    }
  });

// ── Setup Helper ────────────────────────────────────────────

async function setup(opts: Record<string, string>, mode?: { daemon?: boolean }) {
  const isDaemon = mode?.daemon ?? false;
  const automations = await loadAutomations(opts.dir);
  const notifier = new Notifier({
    webhookUrl: process.env.WEBHOOK_URL,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    mattermostWebhookUrl: process.env.MATTERMOST_WEBHOOK_URL,
  });
  const runner = new Runner(opts.mcp, true, notifier);
  // Only the daemon may sweep every `running` row: `run`/`repl` would otherwise
  // mark the daemon's in-flight runs as crashed. Others get the stale-only sweep.
  const history = await History.create(opts.databaseUrl, { sweepOrphans: isDaemon });
  // Notify about runs that crashed before they could finalize themselves.
  await notifyOrphanedRuns(history, notifier);
  // Prune log files older than retention threshold.
  const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS ?? '30', 10);
  await pruneOldLogs(LOGS_DIR, retentionDays);
  const skipList = new SkipList(history);
  await skipList.prePopulate();
  const scheduler = new Scheduler(runner, history, skipList, notifier, { honorCronFlags: isDaemon });

  return { runner, history, scheduler, automations, notifier, skipList };
}

/**
 * Drain orphan rows swept by History.create() and dispatch notifications for
 * each one. Best-effort — failures are logged but never thrown.
 */
async function notifyOrphanedRuns(history: History, notifier: Notifier): Promise<void> {
  const orphans = history.takePendingOrphanNotifications();
  if (orphans.length === 0) return;
  for (const row of orphans) {
    const finishedAt = row.finished_at ?? new Date();
    const startedAt = row.started_at ?? finishedAt;
    try {
      await notifier.notify({
        automationName: row.automation_name,
        success: false,
        output: '',
        error: row.error || 'process crash',
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        startedAt,
        finishedAt,
        mode: (row.mode as 'claude' | 'caila' | 'shell' | 'composed') ?? 'claude',
      });
    } catch (err) {
      logger.warn(
        { id: row.id, error: err instanceof Error ? err.message : String(err) },
        'Failed to notify about orphaned run',
      );
    }
  }
  logger.info({ count: orphans.length }, 'Sent notifications for orphaned runs');
}

// ── Parse ──────────────────────────────────────────────────

program.parse();
