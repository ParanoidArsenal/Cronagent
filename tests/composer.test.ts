/**
 * Unit tests for the Composer class.
 *
 * Runner and Notifier are fully mocked so no real I/O occurs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock logger ───────────────────────────────────────────────────────────────
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { Composer, isComposedAutomation } from '../src/composer.js';
import type { Automation, ExecutionResult } from '../src/types.js';
import type { Runner } from '../src/runner.js';
import type { Notifier } from '../src/notifier.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    name: 'my-composed',
    description: 'A composed automation',
    trigger: 'manual',
    schedule: null,
    timeout: 300,
    mcp: [],
    model: 'sonnet',
    instructions: '{"compose":[]}',
    filePath: '/automations/my-composed.md',
    mode: 'claude',
    sandbox: false,
    maxRetries: 0,
    retryDelayMs: 1000,
    conversation: false,
    ...overrides,
  };
}

function makeStepAutomation(name: string, overrides: Partial<Automation> = {}): Automation {
  return makeAutomation({ name, filePath: `/automations/${name}.md`, ...overrides });
}

function makeExecutionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    automationName: 'step-a',
    success: true,
    output: 'step output',
    durationMs: 100,
    startedAt: new Date(),
    finishedAt: new Date(),
    mode: 'claude',
    ...overrides,
  };
}

function makeMockRunner(): Pick<Runner, 'execute'> {
  return {
    execute: vi.fn(),
  };
}

function makeMockNotifier(): Pick<Notifier, 'notify' | 'sendMessage'> {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Composer', () => {
  let runner: ReturnType<typeof makeMockRunner>;
  let notifier: ReturnType<typeof makeMockNotifier>;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = makeMockRunner();
    notifier = makeMockNotifier();
  });

  // 1. Invalid JSON in instructions
  it('returns an error result when instructions is invalid JSON', async () => {
    const composer = new Composer(runner as unknown as Runner, [], notifier as unknown as Notifier);
    const automation = makeAutomation({ instructions: 'not valid json' });

    const result = await composer.execute(automation);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid compose definition');
    expect(result.mode).toBe('composed');
    expect(result.automationName).toBe(automation.name);
  });

  // 2. All steps succeed — combined output returned
  it('runs steps in sequence and returns combined output on all-success', async () => {
    const stepA = makeStepAutomation('step-a');
    const stepB = makeStepAutomation('step-b');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA, stepB],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeExecutionResult({ automationName: 'step-a', output: 'output-a' }))
      .mockResolvedValueOnce(makeExecutionResult({ automationName: 'step-b', output: 'output-b' }));

    const automation = makeAutomation({
      instructions: JSON.stringify({ compose: ['step-a', 'step-b'] }),
    });

    const result = await composer.execute(automation);

    expect(result.success).toBe(true);
    expect(result.output).toContain('output-a');
    expect(result.output).toContain('output-b');
    expect(runner.execute).toHaveBeenCalledTimes(2);
  });

  // 3. First failure stops execution
  it('stops on first failure and marks result as failed', async () => {
    const stepA = makeStepAutomation('step-a');
    const stepB = makeStepAutomation('step-b');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA, stepB],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a', success: false, error: 'step-a failed' }),
    );

    const automation = makeAutomation({
      instructions: JSON.stringify({ compose: ['step-a', 'step-b'] }),
    });

    const result = await composer.execute(automation);

    expect(result.success).toBe(false);
    // step-b must never have been called
    expect(runner.execute).toHaveBeenCalledTimes(1);
    expect(runner.execute).toHaveBeenCalledWith(stepA, undefined);
  });

  // 4. Unknown step name → skip and fail
  it('skips unknown step names and marks result as failed', async () => {
    const composer = new Composer(
      runner as unknown as Runner,
      [], // no automations registered
      notifier as unknown as Notifier,
    );

    const automation = makeAutomation({
      instructions: JSON.stringify({ compose: ['nonexistent-step'] }),
    });

    const result = await composer.execute(automation);

    expect(result.success).toBe(false);
    expect(result.output).toContain('[SKIP] nonexistent-step');
    expect(runner.execute).not.toHaveBeenCalled();
  });

  // 5. extraEnv is forwarded to runner.execute for every step
  it('passes extraEnv to runner.execute for each step', async () => {
    const stepA = makeStepAutomation('step-a');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a' }),
    );

    const extraEnv = { MY_VAR: 'hello' };
    const automation = makeAutomation({
      instructions: JSON.stringify({ compose: ['step-a'] }),
    });

    await composer.execute(automation, extraEnv);

    expect(runner.execute).toHaveBeenCalledWith(stepA, extraEnv);
  });

  // 6. notifier.notify is called with the composed result
  it('calls notifier.notify with the composed result', async () => {
    const stepA = makeStepAutomation('step-a');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a' }),
    );

    const automation = makeAutomation({
      instructions: JSON.stringify({ compose: ['step-a'] }),
    });

    const result = await composer.execute(automation);

    expect(notifier.notify).toHaveBeenCalledOnce();
    expect(notifier.notify).toHaveBeenCalledWith(result, automation);
  });

  // 7. notify: false → sendMessage is not called
  it('does NOT call notifier.sendMessage when automation.notify is false', async () => {
    const stepA = makeStepAutomation('step-a');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a' }),
    );

    const automation = makeAutomation({
      notify: false,
      instructions: JSON.stringify({
        compose: ['step-a'],
        on_complete: { webhook: 'Done!' },
      }),
    });

    await composer.execute(automation);

    expect(notifier.sendMessage).not.toHaveBeenCalled();
  });

  // 8. on_complete entries each trigger sendMessage
  it('calls notifier.sendMessage for each on_complete entry', async () => {
    const stepA = makeStepAutomation('step-a');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a' }),
    );

    const automation = makeAutomation({
      instructions: JSON.stringify({
        compose: ['step-a'],
        on_complete: {
          webhook: 'Message one',
          telegram: 'Message two',
        },
      }),
    });

    await composer.execute(automation);

    expect(notifier.sendMessage).toHaveBeenCalledTimes(2);
  });

  // 9. Named channel keys are routed as channel targets
  it('routes on_complete keys to named channels (webhook, telegram, mattermost)', async () => {
    const stepA = makeStepAutomation('step-a');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a' }),
    );

    const automation = makeAutomation({
      instructions: JSON.stringify({
        compose: ['step-a'],
        on_complete: { mattermost: 'Post to Mattermost' },
      }),
    });

    await composer.execute(automation);

    expect(notifier.sendMessage).toHaveBeenCalledWith('Post to Mattermost', 'mattermost');
  });

  // 10. Non-channel keys call sendMessage without a channel argument
  it('calls sendMessage without a channel target for non-channel on_complete keys', async () => {
    const stepA = makeStepAutomation('step-a');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a' }),
    );

    const automation = makeAutomation({
      instructions: JSON.stringify({
        compose: ['step-a'],
        on_complete: { custom_key: 'Custom message' },
      }),
    });

    await composer.execute(automation);

    expect(notifier.sendMessage).toHaveBeenCalledWith('Custom message', undefined);
  });

  // 11. {{summary}} placeholder is replaced in on_complete messages
  it('replaces {{summary}} placeholder in on_complete messages', async () => {
    const stepA = makeStepAutomation('step-a');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA],
      notifier as unknown as Notifier,
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a', output: 'the-actual-output' }),
    );

    const automation = makeAutomation({
      instructions: JSON.stringify({
        compose: ['step-a'],
        on_complete: { webhook: 'Result: {{summary}}' },
      }),
    });

    await composer.execute(automation);

    const [calledMessage] = (notifier.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledMessage).toContain('the-actual-output');
    expect(calledMessage).not.toContain('{{summary}}');
  });

  // 12. Result mode is 'composed'
  it('always sets result mode to "composed"', async () => {
    const composer = new Composer(runner as unknown as Runner, [], notifier as unknown as Notifier);
    const automation = makeAutomation({ instructions: '{"compose":[]}' });

    const result = await composer.execute(automation);

    expect(result.mode).toBe('composed');
  });

  // 13. durationMs is positive
  it('returns a positive durationMs in the result', async () => {
    const composer = new Composer(runner as unknown as Runner, [], notifier as unknown as Notifier);
    const automation = makeAutomation({ instructions: '{"compose":[]}' });

    const result = await composer.execute(automation);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // 14. Works without a notifier (notifier is optional)
  it('executes without errors when no notifier is provided', async () => {
    const stepA = makeStepAutomation('step-a');
    const composer = new Composer(
      runner as unknown as Runner,
      [stepA],
      // no notifier
    );

    (runner.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeExecutionResult({ automationName: 'step-a' }),
    );

    const automation = makeAutomation({
      instructions: JSON.stringify({
        compose: ['step-a'],
        on_complete: { webhook: 'Done' },
      }),
    });

    await expect(composer.execute(automation)).resolves.toMatchObject({
      success: true,
      mode: 'composed',
    });
  });
});

// ── isComposedAutomation ──────────────────────────────────────────────────────

describe('isComposedAutomation', () => {
  // 1. Valid composed automation JSON with a compose array
  it('returns true for valid JSON with a compose array', () => {
    expect(isComposedAutomation('{"compose":["step-a","step-b"]}')).toBe(true);
  });

  it('returns true for valid JSON with an empty compose array', () => {
    expect(isComposedAutomation('{"compose":[]}')).toBe(true);
  });

  // 2. Valid JSON without a compose key
  it('returns false for valid JSON that has no compose key', () => {
    expect(isComposedAutomation('{"steps":["step-a"]}')).toBe(false);
  });

  it('returns false for a plain JSON object with no relevant keys', () => {
    expect(isComposedAutomation('{}')).toBe(false);
  });

  // 3. Valid JSON where compose is not an array
  it('returns false when compose is a string', () => {
    expect(isComposedAutomation('{"compose":"step-a"}')).toBe(false);
  });

  it('returns false when compose is a number', () => {
    expect(isComposedAutomation('{"compose":42}')).toBe(false);
  });

  it('returns false when compose is a boolean true', () => {
    expect(isComposedAutomation('{"compose":true}')).toBe(false);
  });

  it('returns false when compose is null', () => {
    expect(isComposedAutomation('{"compose":null}')).toBe(false);
  });

  it('returns false when compose is a plain object', () => {
    expect(isComposedAutomation('{"compose":{"step":"a"}}')).toBe(false);
  });

  // 4. Invalid JSON (plain text / markdown)
  it('returns false for plain markdown text', () => {
    expect(isComposedAutomation('# Run the deployment\nDo something useful.')).toBe(false);
  });

  it('returns false for arbitrary non-JSON text', () => {
    expect(isComposedAutomation('not json at all')).toBe(false);
  });

  it('returns false for malformed JSON', () => {
    expect(isComposedAutomation('{compose: ["step-a"]}')).toBe(false);
  });

  // 5. Empty string
  it('returns false for an empty string', () => {
    expect(isComposedAutomation('')).toBe(false);
  });
});
