import { History, BudgetConfigSchema, DEFAULT_BUDGET } from './history.js';
import type { BudgetConfig } from './history.js';
import type { UsagePrediction } from './types.js';

export class UsageTracker {
  private history: History;

  constructor(history: History) {
    this.history = history;
  }

  async predict(config: BudgetConfig): Promise<UsagePrediction> {
    const [todaySpent, recentCosts, rateLimits] = await Promise.all([
      this.history.getTodaySpent(),
      this.history.getRecentRunCosts(10),
      this.history.getConsecutiveRateLimits(),
    ]);

    const estimatedRunCost = this.computeEma(recentCosts);
    const confidence = this.getConfidence(recentCosts.length);
    const multiplier = this.getTimeMultiplier(config);
    const adjustedCost = estimatedRunCost * multiplier;

    const reserveAmount = config.dailyBudget * (config.reservePercent / 100);
    const effectiveBudget = config.dailyBudget - reserveAmount;
    const remaining = Math.max(0, effectiveBudget - todaySpent);

    // Rate-limit backoff: exponentially increase effective cost estimate
    const backoffFactor = rateLimits > 0 ? Math.pow(2, rateLimits) : 1;
    const gatedCost = adjustedCost * backoffFactor;

    let shouldRun = true;
    let reason: string | undefined;

    if (rateLimits >= 3) {
      shouldRun = false;
      reason = `rate-limit backoff: ${rateLimits} consecutive rate-limit errors`;
    } else if (confidence !== 'low' && gatedCost > remaining) {
      shouldRun = false;
      reason = `budget exhausted: $${todaySpent.toFixed(4)} spent, $${remaining.toFixed(4)} remaining, estimated cost $${adjustedCost.toFixed(4)}`;
    }

    return {
      todaySpent,
      remaining,
      estimatedRunCost: adjustedCost,
      confidence,
      shouldRun,
      reason,
    };
  }

  async checkBudget(): Promise<{ allowed: boolean; reason?: string }> {
    const raw = await this.history.getSetting<BudgetConfig>('budget');
    const parsed = raw ? BudgetConfigSchema.safeParse(raw) : null;
    const config = parsed?.success ? parsed.data : DEFAULT_BUDGET;
    if (!config.enabled) return { allowed: true };

    const prediction = await this.predict(config);
    return { allowed: prediction.shouldRun, reason: prediction.reason };
  }

  private computeEma(costs: number[]): number {
    if (costs.length === 0) return 0;
    // EMA with smoothing factor alpha = 2 / (N + 1)
    const alpha = 2 / (costs.length + 1);
    // costs[0] is the most recent — iterate in reverse for chronological order
    let ema = costs[costs.length - 1];
    for (let i = costs.length - 2; i >= 0; i--) {
      ema = alpha * costs[i] + (1 - alpha) * ema;
    }
    return ema;
  }

  private getConfidence(sampleSize: number): 'low' | 'medium' | 'high' {
    if (sampleSize < 3) return 'low';
    if (sampleSize < 7) return 'medium';
    return 'high';
  }

  private getTimeMultiplier(config: BudgetConfig): number {
    const hour = new Date().getUTCHours();
    const { workHoursStart, workHoursEnd, offHoursMultiplier } = config;
    const inWorkHours = workHoursStart < workHoursEnd
      ? hour >= workHoursStart && hour < workHoursEnd
      : hour >= workHoursStart || hour < workHoursEnd;
    return inWorkHours ? 1 : offHoursMultiplier;
  }
}
