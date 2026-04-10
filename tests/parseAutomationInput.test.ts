/**
 * Unit tests for parseAutomationInput() in web/lib/backend.ts.
 *
 * The function wraps an AutomationInputSchema (Zod) and returns either
 * { success: true, data } or { success: false, error }.
 *
 * Because backend.ts imports heavy runtime modules (Next.js path aliases,
 * postgres via History, filesystem via Runner), those are mocked here so
 * only the pure validation logic under test is exercised.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mock all runtime-heavy @cronagent/* packages ───────────────────────
// These are resolved by the vitest.config.ts aliases to src/*.ts.
// We don't need their real implementations for pure schema tests.
vi.mock('@cronagent/loader', () => ({
  loadAutomations: vi.fn().mockResolvedValue([]),
}));

vi.mock('@cronagent/runner', () => ({
  Runner: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/history', () => ({
  History: { create: vi.fn().mockResolvedValue({}) },
  DEFAULT_THROTTLE: { enabled: false, maxConcurrent: 5, cooldownSeconds: 0, maxPerHour: 0 },
}));

vi.mock('@cronagent/composer', () => ({
  Composer: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/notifier', () => ({
  Notifier: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@cronagent/scheduler', () => ({
  Scheduler: vi.fn().mockImplementation(() => ({})),
}));

// ── Import the module under test ──────────────────────────────────────────────
import { parseAutomationInput } from '../web/lib/backend.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid payload — all required fields present and correct. */
function validInput() {
  return {
    name: 'my-automation',
    description: 'Does something useful',
    mode: 'claude' as const,
    trigger: 'manual' as const,
    schedule: null,
    timeout: 300,
    model: 'sonnet',
    mcp: [],
    sandbox: false,
    instructions: 'Run the daily report.',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseAutomationInput()', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  describe('valid input', () => {
    it('returns success:true with data when all required fields are provided', () => {
      const result = parseAutomationInput(validInput());

      expect(result.success).toBe(true);
      if (!result.success) return; // narrow type
      expect(result.data.name).toBe('my-automation');
      expect(result.data.instructions).toBe('Run the daily report.');
    });

    it('trims leading/trailing whitespace from name and instructions', () => {
      const input = {
        ...validInput(),
        name: '  spaced-name  ',
        instructions: '  do the thing  ',
      };

      const result = parseAutomationInput(input);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name).toBe('spaced-name');
      expect(result.data.instructions).toBe('do the thing');
    });

    it('applies default description when omitted', () => {
      const { description: _omitted, ...input } = validInput();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.description).toBe('');
    });

    it('applies default model when omitted', () => {
      const { model: _omitted, ...input } = validInput();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.model).toBe('sonnet');
    });

    it('applies default mcp:[] when omitted', () => {
      const { mcp: _omitted, ...input } = validInput();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.mcp).toEqual([]);
    });

    it('applies default sandbox:false when omitted', () => {
      const { sandbox: _omitted, ...input } = validInput();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.sandbox).toBe(false);
    });

    it('accepts all three trigger values', () => {
      const triggers = ['manual', 'cron', 'webhook'] as const;
      for (const trigger of triggers) {
        const result = parseAutomationInput({ ...validInput(), trigger });
        expect(result.success, `trigger="${trigger}" should be valid`).toBe(true);
      }
    });

    it('accepts both mode values', () => {
      for (const mode of ['claude', 'shell'] as const) {
        const result = parseAutomationInput({ ...validInput(), mode });
        expect(result.success, `mode="${mode}" should be valid`).toBe(true);
      }
    });

    it('accepts timeout at boundary values (1 and 86400)', () => {
      expect(parseAutomationInput({ ...validInput(), timeout: 1 }).success).toBe(true);
      expect(parseAutomationInput({ ...validInput(), timeout: 86400 }).success).toBe(true);
    });

    it('strips extra/unknown fields from the output', () => {
      const input = {
        ...validInput(),
        unknownField: 'should be removed',
        anotherExtra: 42,
      };

      const result = parseAutomationInput(input);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).not.toHaveProperty('unknownField');
      expect(result.data).not.toHaveProperty('anotherExtra');
    });
  });

  // ── Name validation ────────────────────────────────────────────────────────

  describe('name validation', () => {
    it('returns success:false when name is an empty string', () => {
      const result = parseAutomationInput({ ...validInput(), name: '' });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Name is required');
    });

    it('rejects whitespace-only name (must contain at least one letter or digit)', () => {
      const result = parseAutomationInput({ ...validInput(), name: '   ' });

      expect(result.success).toBe(false);
    });

    it('returns success:false when name is missing entirely', () => {
      const { name: _omitted, ...input } = validInput();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('name');
    });
  });

  // ── Timeout validation ─────────────────────────────────────────────────────

  describe('timeout validation', () => {
    it('returns success:false when timeout is 0 (below minimum of 1)', () => {
      const result = parseAutomationInput({ ...validInput(), timeout: 0 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Timeout must be at least 1 second');
    });

    it('returns success:false when timeout is negative', () => {
      const result = parseAutomationInput({ ...validInput(), timeout: -60 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('timeout');
    });

    it('returns success:false when timeout exceeds 86400', () => {
      const result = parseAutomationInput({ ...validInput(), timeout: 86401 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('timeout');
    });

    it('returns success:false when timeout is a float (not integer)', () => {
      const result = parseAutomationInput({ ...validInput(), timeout: 300.5 });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('timeout');
    });

    it('returns success:false when timeout is a string', () => {
      const result = parseAutomationInput({ ...validInput(), timeout: '300' as unknown as number });

      expect(result.success).toBe(false);
    });
  });

  // ── Trigger validation ─────────────────────────────────────────────────────

  describe('trigger validation', () => {
    it('returns success:false when trigger is an unrecognised value', () => {
      const result = parseAutomationInput({
        ...validInput(),
        trigger: 'timer' as 'manual',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('trigger');
    });

    it('returns success:false when trigger is missing', () => {
      const { trigger: _omitted, ...input } = validInput();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('trigger');
    });
  });

  // ── Mode validation ────────────────────────────────────────────────────────

  describe('mode validation', () => {
    it('returns success:false when mode is an unrecognised value', () => {
      const result = parseAutomationInput({
        ...validInput(),
        mode: 'python' as 'claude',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('mode');
    });

    it('returns success:false when mode is missing', () => {
      const { mode: _omitted, ...input } = validInput();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(false);
    });
  });

  // ── Instructions validation ────────────────────────────────────────────────

  describe('instructions validation', () => {
    it('returns success:false when instructions is an empty string', () => {
      const result = parseAutomationInput({ ...validInput(), instructions: '' });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Instructions are required');
    });

    it('returns success:false when instructions is whitespace-only', () => {
      // The refine checks trimmed length, so whitespace-only fails
      const result = parseAutomationInput({ ...validInput(), instructions: '   ' });

      expect(result.success).toBe(false);
    });

    it('returns success:false when instructions is missing', () => {
      const { instructions: _omitted, ...input } = validInput();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('instructions');
    });
  });

  // ── Error message format ───────────────────────────────────────────────────

  describe('error message format', () => {
    it('joins multiple validation errors with "; "', () => {
      // Both name and instructions are empty → two issues
      const result = parseAutomationInput({
        ...validInput(),
        name: '',
        instructions: '',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      // Error message should contain both issues separated by "; "
      expect(result.error).toContain('; ');
    });

    it('includes the field path in each error segment', () => {
      const result = parseAutomationInput({ ...validInput(), name: '' });

      expect(result.success).toBe(false);
      if (result.success) return;
      // Format is "fieldPath: message"
      expect(result.error).toMatch(/^name:/);
    });
  });

  // ── Composed mode ──────────────────────────────────────────────────────────

  describe('composed mode', () => {
    /** Minimal valid composed payload — instructions is omitted intentionally. */
    function validComposed() {
      return {
        name: 'composed-automation',
        description: 'Runs two steps',
        mode: 'composed' as const,
        trigger: 'manual' as const,
        schedule: null,
        timeout: 300,
        model: 'sonnet',
        mcp: [],
        sandbox: false,
        composeSteps: 'step-one\nstep-two',
      };
    }

    it('returns success:true when mode is composed and composeSteps is non-empty', () => {
      const result = parseAutomationInput(validComposed());

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.mode).toBe('composed');
      expect(result.data.composeSteps).toBe('step-one\nstep-two');
    });

    it('returns success:false when mode is composed and composeSteps is empty string', () => {
      const result = parseAutomationInput({ ...validComposed(), composeSteps: '' });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('At least one compose step is required');
    });

    it('returns success:false when mode is composed and composeSteps is whitespace-only', () => {
      const result = parseAutomationInput({ ...validComposed(), composeSteps: '   ' });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('At least one compose step is required');
    });

    it('returns success:false when mode is composed and composeSteps is absent', () => {
      const { composeSteps: _omitted, ...input } = validComposed();

      const result = parseAutomationInput(input);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('At least one compose step is required');
    });

    it('does not require instructions when mode is composed', () => {
      // instructions is absent — composed mode skips that check
      const input = validComposed(); // no instructions field

      const result = parseAutomationInput(input);

      expect(result.success).toBe(true);
      if (!result.success) return;
      // instructions defaults to '' and is accepted
      expect(result.data.instructions).toBe('');
    });

    it('accepts onComplete alongside composeSteps', () => {
      const input = {
        ...validComposed(),
        onComplete: 'notify=slack\nreport=email',
      };

      const result = parseAutomationInput(input);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.onComplete).toBe('notify=slack\nreport=email');
    });

    it('ignores composeSteps for non-composed mode (claude) and requires instructions instead', () => {
      // Providing composeSteps with mode=claude but no instructions should fail
      const result = parseAutomationInput({
        ...validInput(),
        mode: 'claude' as const,
        instructions: '',
        composeSteps: 'step-one\nstep-two',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain('Instructions are required');
    });

    it('ignores composeSteps for non-composed mode (claude) when instructions are present', () => {
      // composeSteps is extra data and should be stripped; instructions drives validation
      const result = parseAutomationInput({
        ...validInput(),
        mode: 'claude' as const,
        instructions: 'do the thing',
        composeSteps: 'step-one\nstep-two',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      // composeSteps is passed through as an optional field when provided
      expect(result.data.mode).toBe('claude');
      expect(result.data.instructions).toBe('do the thing');
    });
  });

  // ── Non-object inputs ──────────────────────────────────────────────────────

  describe('non-object inputs', () => {
    it('returns success:false for null', () => {
      expect(parseAutomationInput(null).success).toBe(false);
    });

    it('returns success:false for undefined', () => {
      expect(parseAutomationInput(undefined).success).toBe(false);
    });

    it('returns success:false for a plain string', () => {
      expect(parseAutomationInput('{"name":"x"}').success).toBe(false);
    });

    it('returns success:false for an array', () => {
      expect(parseAutomationInput([]).success).toBe(false);
    });

    it('returns success:false for a number', () => {
      expect(parseAutomationInput(42).success).toBe(false);
    });
  });
});
