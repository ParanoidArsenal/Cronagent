import { logger } from './logger.js';
import { Runner } from './runner.js';
import type { Notifier } from './notifier.js';
import type { Automation, ExecutionResult } from './types.js';

/** Check whether instructions represent a composed automation (JSON with compose array). */
export function isComposedAutomation(instructions: string): boolean {
  try {
    const parsed = JSON.parse(instructions);
    return Array.isArray(parsed?.compose);
  } catch {
    return false;
  }
}

/**
 * Runs a sequence of automations, passing context between them.
 */
export class Composer {
  private runner: Runner;
  private automationMap: Map<string, Automation>;
  private notifier?: Notifier;

  constructor(runner: Runner, automations: Automation[], notifier?: Notifier) {
    this.runner = runner;
    this.automationMap = new Map(automations.map((a) => [a.name, a]));
    this.notifier = notifier;
  }

  /**
   * Execute a composed automation — run each referenced automation in sequence.
   */
  async execute(automation: Automation, extraEnv?: Record<string, string>, signal?: AbortSignal): Promise<ExecutionResult> {
    const startedAt = new Date();
    let composeDef: { compose: string[]; on_complete?: Record<string, string> };

    try {
      composeDef = JSON.parse(automation.instructions);
    } catch {
      return {
        automationName: automation.name,
        success: false,
        output: '',
        error: 'Invalid compose definition',
        durationMs: Date.now() - startedAt.getTime(),
        startedAt,
        finishedAt: new Date(),
        mode: 'composed',
      };
    }

    const outputs: string[] = [];
    let allSuccess = true;
    let error: string | undefined;
    // Sum spend across steps so composed runs count toward the daily budget.
    let costUsd: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for (const stepName of composeDef.compose) {
      if (signal?.aborted) {
        allSuccess = false;
        error = 'Run stopped by user';
        break;
      }
      const step = this.automationMap.get(stepName);
      if (!step) {
        outputs.push(`[SKIP] ${stepName}: not found`);
        logger.warn({ composed: automation.name, step: stepName }, 'Step not found');
        allSuccess = false;
        break;
      }

      logger.info({ composed: automation.name, step: stepName }, 'Running composed step');

      const result = await this.runner.execute(step, extraEnv, undefined, undefined, signal);
      if (result.costUsd !== undefined) costUsd = (costUsd ?? 0) + result.costUsd;
      if (result.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + result.inputTokens;
      if (result.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + result.outputTokens;
      outputs.push(`--- ${stepName} (${result.success ? 'OK' : 'FAIL'}) ---`);
      outputs.push(result.output || result.error || '(no output)');

      if (!result.success) {
        allSuccess = false;
        break;
      }
    }

    const summary = outputs.join('\n\n');

    const execResult: ExecutionResult = {
      automationName: automation.name,
      success: allSuccess,
      output: summary,
      error,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt,
      finishedAt: new Date(),
      mode: 'composed',
      costUsd,
      inputTokens,
      outputTokens,
    };

    // Send webhook notification
    await this.notifier?.notify(execResult, automation);

    // Honour on_complete messages — route to named channels when key matches
    if (composeDef.on_complete && this.notifier && automation.notify !== false) {
      const channelNames = new Set(['webhook', 'telegram', 'mattermost']);
      for (const [key, message] of Object.entries(composeDef.on_complete)) {
        const rendered = message.replace(/\{\{summary\}\}/g, summary.slice(0, 500));
        const channel = channelNames.has(key) ? (key as 'webhook' | 'telegram' | 'mattermost') : undefined;
        await this.notifier.sendMessage(rendered, channel);
      }
    }

    return execResult;
  }
}
