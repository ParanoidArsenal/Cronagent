import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BudgetConfig } from '@cronagent/history';
import { DEFAULT_BUDGET } from '@cronagent/history';

// ── Mock logger ──────────────────────────────────────────────
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { UsageTracker } from '../src/usage-tracker.js';

// ── Fake History ────────────────────────────────────────────

function makeFakeHistory(overrides: {
  todaySpent?: number;
  recentCosts?: number[];
  rateLimits?: number;
  budgetConfig?: BudgetConfig | null;
} = {}) {
  return {
    getTodaySpent: vi.fn().mockResolvedValue(overrides.todaySpent ?? 0),
    getRecentRunCosts: vi.fn().mockResolvedValue(overrides.recentCosts ?? []),
    getConsecutiveRateLimits: vi.fn().mockResolvedValue(overrides.rateLimits ?? 0),
    getSetting: vi.fn().mockResolvedValue(overrides.budgetConfig ?? null),
  } as any;
}

const enabledConfig: BudgetConfig = {
  ...DEFAULT_BUDGET,
  enabled: true,
  dailyBudget: 10,
  reservePercent: 10,
};

// ── Tests ──────────────────────────────────────────────────

describe('UsageTracker', () => {
  describe('predict()', () => {
    it('allows runs when budget has room', async () => {
      const history = makeFakeHistory({
        todaySpent: 2,
        recentCosts: [0.5, 0.5, 0.5, 0.5, 0.5],
      });
      const tracker = new UsageTracker(history);
      const prediction = await tracker.predict(enabledConfig);

      expect(prediction.shouldRun).toBe(true);
      expect(prediction.todaySpent).toBe(2);
      expect(prediction.remaining).toBe(7); // 10 - 10% reserve - 2 spent
      expect(prediction.confidence).toBe('medium');
    });

    it('blocks runs when budget exhausted', async () => {
      const history = makeFakeHistory({
        todaySpent: 9,
        recentCosts: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      });
      const tracker = new UsageTracker(history);
      const prediction = await tracker.predict(enabledConfig);

      expect(prediction.shouldRun).toBe(false);
      expect(prediction.reason).toContain('budget exhausted');
    });

    it('allows runs with low confidence even near budget', async () => {
      const history = makeFakeHistory({
        todaySpent: 8.5,
        recentCosts: [1.0], // only 1 sample → low confidence
      });
      const tracker = new UsageTracker(history);
      const prediction = await tracker.predict(enabledConfig);

      expect(prediction.confidence).toBe('low');
      expect(prediction.shouldRun).toBe(true);
    });

    it('blocks on consecutive rate-limit errors', async () => {
      const history = makeFakeHistory({
        todaySpent: 0,
        recentCosts: [0.5, 0.5, 0.5],
        rateLimits: 3,
      });
      const tracker = new UsageTracker(history);
      const prediction = await tracker.predict(enabledConfig);

      expect(prediction.shouldRun).toBe(false);
      expect(prediction.reason).toContain('rate-limit backoff');
    });

    it('returns remaining=0 when overspent', async () => {
      const history = makeFakeHistory({
        todaySpent: 15,
        recentCosts: [0.5, 0.5, 0.5],
      });
      const tracker = new UsageTracker(history);
      const prediction = await tracker.predict(enabledConfig);

      expect(prediction.remaining).toBe(0);
    });

    it('handles empty cost history', async () => {
      const history = makeFakeHistory({ recentCosts: [] });
      const tracker = new UsageTracker(history);
      const prediction = await tracker.predict(enabledConfig);

      expect(prediction.estimatedRunCost).toBe(0);
      expect(prediction.confidence).toBe('low');
      expect(prediction.shouldRun).toBe(true);
    });

    it('computes EMA weighting recent costs more heavily', async () => {
      // Use a config where multiplier is 1 (all hours are work hours)
      const allDayConfig: BudgetConfig = {
        ...enabledConfig,
        workHoursStart: 0,
        workHoursEnd: 0,
      };
      const history = makeFakeHistory({
        recentCosts: [2.0, 1.0, 1.0, 1.0, 1.0], // most recent is 2.0
      });
      const tracker = new UsageTracker(history);
      const prediction = await tracker.predict(allDayConfig);

      // EMA should be between 1.0 and 2.0, weighted toward 2.0
      expect(prediction.estimatedRunCost).toBeGreaterThan(1.0);
      expect(prediction.estimatedRunCost).toBeLessThan(2.0);
    });
  });

  describe('checkBudget()', () => {
    it('returns allowed=true when budget is disabled', async () => {
      const history = makeFakeHistory({ budgetConfig: null });
      const tracker = new UsageTracker(history);
      const result = await tracker.checkBudget();

      expect(result.allowed).toBe(true);
    });

    it('returns allowed=true when config.enabled=false', async () => {
      const history = makeFakeHistory({
        budgetConfig: { ...enabledConfig, enabled: false },
      });
      const tracker = new UsageTracker(history);
      const result = await tracker.checkBudget();

      expect(result.allowed).toBe(true);
    });

    it('gates when budget is enabled and exhausted', async () => {
      const history = makeFakeHistory({
        budgetConfig: enabledConfig,
        todaySpent: 9.5,
        recentCosts: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      });
      const tracker = new UsageTracker(history);
      const result = await tracker.checkBudget();

      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('allows when budget is enabled and has room', async () => {
      const history = makeFakeHistory({
        budgetConfig: enabledConfig,
        todaySpent: 1,
        recentCosts: [0.5, 0.5, 0.5],
      });
      const tracker = new UsageTracker(history);
      const result = await tracker.checkBudget();

      expect(result.allowed).toBe(true);
    });
  });
});
