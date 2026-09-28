import { Cron } from 'croner';
import { logger } from './logger.js';
import { Runner } from './runner.js';
import { Composer, isComposedAutomation } from './composer.js';
import { History, DEFAULT_THROTTLE, ThrottleConfigSchema } from './history.js';
import type { ThrottleConfig } from './history.js';
import { UsageTracker } from './usage-tracker.js';
import { SkipList } from './skip-list.js';
import type { Notifier } from './notifier.js';
import type { Automation, ConversationContext } from './types.js';
import { randomUUID } from 'node:crypto';

/** Settings key prefix for the per-automation cron on/off flag toggled from the web UI. */
export const CRON_ENABLED_PREFIX = 'cron_enabled::';

/** A cron automation runs only when its flag is explicitly `true` (unset = disabled). */
export async function isCronEnabled(history: History, name: string): Promise<boolean> {
  const val = await history.getSetting<boolean>(`${CRON_ENABLED_PREFIX}${name}`);
  return val === true;
}

/** Next fire time of a cron pattern without scheduling anything; null if invalid or none. */
export function nextCronRun(schedule: string): string | null {
  try {
    return new Cron(schedule).nextRun()?.toISOString() ?? null;
  } catch {
    return null;
  }
}

export interface SchedulerOptions {
  /**
   * Check the `cron_enabled::<name>` setting on every tick and skip disabled
   * automations. The daemon sets this so start/stop in the web UI (which only
   * flips the flag) takes effect without a restart.
   */
  honorCronFlags?: boolean;
}

export class Scheduler {
  private crons: Map<string, Cron> = new Map();
  private runner: Runner;
  private history: History;
  private automations: Automation[] = [];
  private running: Set<string> = new Set();
  private lastRunFinished: Map<string, number> = new Map();
  private usageTracker: UsageTracker;
  private skipList?: SkipList;
  private notifier?: Notifier;
  private shuttingDown = false;
  private honorCronFlags: boolean;

  constructor(runner: Runner, history: History, skipList?: SkipList, notifier?: Notifier, opts?: SchedulerOptions) {
    this.runner = runner;
    this.history = history;
    this.usageTracker = new UsageTracker(history);
    this.skipList = skipList;
    this.notifier = notifier;
    this.honorCronFlags = opts?.honorCronFlags ?? false;
  }

  /**
   * Set the full automations list (needed for composed automation lookups).
   */
  setAutomations(automations: Automation[]): void {
    this.automations = automations;
  }

  /**
   * Register all cron-triggered automations.
   */
  start(automations: Automation[]): void {
    this.automations = automations;
    const cronAutomations = automations.filter(
      (a) => a.trigger === 'cron' && a.schedule,
    );

    for (const automation of cronAutomations) {
      this.register(automation);
    }

    logger.info(
      { scheduled: cronAutomations.length },
      'Scheduler started',
    );
  }

  private async checkThrottle(name: string): Promise<{ allowed: boolean; reason?: string }> {
    const raw = await this.history.getSetting<ThrottleConfig>('throttle');
    const parsed = raw ? ThrottleConfigSchema.safeParse(raw) : null;
    const throttle = parsed?.success ? parsed.data : DEFAULT_THROTTLE;
    if (!throttle.enabled) return { allowed: true };

    // Use > instead of >= because the current automation is already in the
    // running set (added synchronously before preflight checks to prevent races).
    if (this.running.size > throttle.maxConcurrent) {
      return { allowed: false, reason: `max ${throttle.maxConcurrent} concurrent runs reached` };
    }

    if (throttle.cooldownSeconds > 0) {
      const lastFinish = this.lastRunFinished.get(name);
      if (lastFinish && Date.now() - lastFinish < throttle.cooldownSeconds * 1000) {
        const waitSec = Math.ceil((throttle.cooldownSeconds * 1000 - (Date.now() - lastFinish)) / 1000);
        return { allowed: false, reason: `cooldown ${waitSec}s remaining for "${name}"` };
      }
    }

    if (throttle.maxPerHour > 0) {
      const runsLastHour = await this.history.getRunsInWindow(60 * 60 * 1000, name);
      if (runsLastHour >= throttle.maxPerHour) {
        return { allowed: false, reason: `max ${throttle.maxPerHour} runs/hour reached for "${name}"` };
      }
    }

    return { allowed: true };
  }

  register(automation: Automation): void {
    if (this.shuttingDown) {
      logger.warn({ name: automation.name }, 'Cannot register cron — shutting down');
      return;
    }

    if (!automation.schedule) {
      logger.warn({ name: automation.name }, 'No schedule defined, skipping');
      return;
    }

    // Remove existing cron if any
    this.crons.get(automation.name)?.stop();

    const cron = new Cron(automation.schedule, async () => {
      if (this.shuttingDown) {
        logger.info({ name: automation.name }, 'Skipping — shutting down');
        return;
      }

      if (this.running.has(automation.name)) {
        logger.info({ name: automation.name }, 'Skipping — already running');
        return;
      }

      // Reserve the slot synchronously before any await to prevent race conditions.
      // A fast cron tick can fire again while we await preflight checks below;
      // without this, both invocations pass the has() guard above.
      this.running.add(automation.name);

      if (this.honorCronFlags) {
        let enabled = false;
        try {
          enabled = await isCronEnabled(this.history, automation.name);
        } catch (err) {
          logger.warn({ name: automation.name, err }, 'Cron skipped — failed to read enabled flag');
        }
        if (!enabled) {
          logger.debug({ name: automation.name }, 'Cron skipped — disabled');
          this.running.delete(automation.name);
          return;
        }
      }

      const check = await this.checkThrottle(automation.name);
      if (!check.allowed) {
        logger.info({ name: automation.name, reason: check.reason }, 'Cron throttled');
        this.running.delete(automation.name);
        return;
      }

      const budgetCheck = await this.usageTracker.checkBudget();
      if (!budgetCheck.allowed) {
        logger.info({ name: automation.name, reason: budgetCheck.reason }, 'Cron budget-gated');
        this.running.delete(automation.name);
        return;
      }

      if (this.skipList && await this.skipList.has(automation.name)) {
        logger.info({ name: automation.name }, 'Cron skipped — on skip list');
        this.running.delete(automation.name);
        return;
      }

      if (this.shuttingDown) {
        this.running.delete(automation.name);
        return;
      }
      logger.info(
        { name: automation.name, schedule: automation.schedule },
        'Cron triggered',
      );

      const startedAt = new Date();
      let runId: number | undefined;
      try {
        // Build conversation context for conversation-enabled automations
        let conversationCtx: ConversationContext | undefined;
        let conversationId: string | undefined;
        if (automation.conversation && automation.mode === 'claude' && !automation.sandbox) {
          const active = await this.history.getActiveConversation(automation.name);
          if (active?.claude_session_id) {
            conversationId = active.id;
            conversationCtx = { conversationId: active.id, sessionId: active.claude_session_id };
          } else if (active) {
            conversationId = active.id;
          } else {
            conversationId = randomUUID();
            await this.history.createConversation(conversationId, automation.name);
          }
        }

        const maybeRunId = await this.history.insertRunning({
          automationName: automation.name,
          mode: automation.mode,
          startedAt,
          conversationId: conversationId ?? null,
        });
        if (maybeRunId === null) {
          logger.info({ name: automation.name }, 'Skipping — already running (DB constraint)');
          return;
        }
        runId = maybeRunId;

        let lastProgressDbWrite = 0;
        const onProgress = (stage: string, meta: { turn: number }) => {
          const now = Date.now();
          if (now - lastProgressDbWrite < 750) return;
          lastProgressDbWrite = now;
          if (runId !== undefined) {
            this.history.updateProgress(runId, stage, meta.turn).catch((err) => {
              logger.warn({ err, runId }, 'updateProgress failed');
            });
          }
        };

        // Live log streaming: persist the log file path as soon as the runner
        // creates it, so the web UI can tail the file while the cron-triggered
        // run is still in progress.
        const onLogFile = (path: string) => {
          if (runId !== undefined) {
            this.history.updateLogFile(runId, path).catch((err) => {
              logger.warn({ err, runId }, 'updateLogFile failed');
            });
          }
        };

        let result;
        if (isComposedAutomation(automation.instructions)) {
          const composer = new Composer(this.runner, this.automations, this.notifier);
          result = await composer.execute(automation);
        } else {
          result = await this.runner.execute(automation, undefined, conversationCtx, onProgress, undefined, onLogFile);
        }

        if (conversationId) {
          result.conversationId = conversationId;
        }
        await this.history.finalizeRun(runId, result);

        // Update conversation state (session_id/stats always, messages only when present)
        if (conversationId && result.success) {
          if (result.sessionId) {
            await this.history.updateConversationSession(conversationId, result.sessionId);
          }
          await this.history.updateConversationStats(conversationId, result.costUsd ?? 0);
          if (result.messages?.length && runId !== undefined) {
            const startSeq = await this.history.getMaxMessageSeq(conversationId) + 1;
            await this.history.insertConversationMessages(conversationId, runId, result.messages, startSeq);
          }
        }

        if (result.success) {
          logger.info(
            { name: automation.name, durationMs: result.durationMs },
            'Cron execution succeeded',
          );
          await this.skipList?.recordSuccess(automation.name);
        } else {
          logger.warn(
            { name: automation.name, error: result.error },
            'Cron execution failed',
          );
          await this.skipList?.recordFailure(automation.name);
        }
      } catch (err) {
        logger.error(
          { name: automation.name, error: err },
          'Cron execution crashed',
        );
        if (runId !== undefined) {
          try {
            await this.history.finalizeRun(runId, {
              automationName: automation.name,
              success: false,
              output: '',
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - startedAt.getTime(),
              startedAt,
              finishedAt: new Date(),
              mode: automation.mode,
            });
          } catch (finalizeErr) {
            logger.error({ finalizeErr, runId }, 'finalizeRun fallback failed');
          }
        }
      } finally {
        this.running.delete(automation.name);
        this.lastRunFinished.set(automation.name, Date.now());
      }
    });

    this.crons.set(automation.name, cron);
    const next = cron.nextRun();
    logger.info(
      { name: automation.name, schedule: automation.schedule, nextRun: next?.toISOString() },
      'Cron job registered',
    );
  }

  /**
   * Stop and remove a single cron job by name.
   */
  stopOne(name: string): void {
    const cron = this.crons.get(name);
    if (cron) {
      cron.stop();
      this.crons.delete(name);
      logger.info({ name }, 'Cron job stopped');
    }
  }

  /**
   * Start (or re-register) a single cron job.
   */
  startOne(automation: Automation): void {
    this.register(automation);
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.stop();
  }

  waitForIdle(timeoutMs: number): Promise<{ timedOut: boolean }> {
    return new Promise((resolve) => {
      if (this.running.size === 0) {
        resolve({ timedOut: false });
        return;
      }

      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (this.running.size === 0 || Date.now() >= deadline) {
          clearInterval(timer);
          const timedOut = this.running.size > 0;
          if (timedOut) {
            logger.warn(
              { stillRunning: [...this.running] },
              'Shutdown timeout — force exiting with in-flight runs',
            );
          }
          resolve({ timedOut });
        }
      }, 200);
    });
  }

  stop(): void {
    for (const [name, cron] of this.crons) {
      cron.stop();
      logger.debug({ name }, 'Cron job stopped');
    }
    this.crons.clear();
  }

  getStatus(): Array<{ name: string; schedule: string | undefined; nextRun: string | null; running: boolean }> {
    const status = [];
    for (const [name, cron] of this.crons) {
      const next = cron.nextRun();
      status.push({
        name,
        schedule: cron.getPattern(),
        nextRun: next?.toISOString() ?? null,
        running: this.running.has(name),
      });
    }
    return status;
  }
}
