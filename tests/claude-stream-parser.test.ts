/**
 * Behavioral unit tests for ClaudeStreamParser.
 *
 * The parser is pure state — no I/O, no subprocess. We feed it fixture
 * stream-json lines and assert on the parsed result, the messages array,
 * and the throttled progress callback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeStreamParser } from '../src/claude-stream-parser.ts';

// ── Fixture builders ─────────────────────────────────────────────────────────

const j = (obj: unknown): string => JSON.stringify(obj);

const assistantText = (text: string) =>
  j({ type: 'assistant', content: [{ type: 'text', text }] });

const assistantToolUse = (name: string, input: unknown = {}) =>
  j({ type: 'assistant', content: [{ type: 'tool_use', name, input }] });

const userToolResult = (toolUseId: string, content: unknown) =>
  j({ type: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] });

const successResult = (opts: {
  result?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
}) =>
  j({
    type: 'result',
    is_error: false,
    result: opts.result,
    total_cost_usd: opts.cost,
    usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
    session_id: opts.sessionId,
  });

const errorResult = (opts: { error?: string; errors?: string[]; result?: string }) =>
  j({ type: 'result', is_error: true, ...opts });

const standaloneError = (message: string, errorType?: string) =>
  j({ type: 'error', message, error_type: errorType });

// ── getResult / empty state ──────────────────────────────────────────────────

describe('ClaudeStreamParser — empty state', () => {
  it('returns sensible defaults when no lines have been processed', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    const result = parser.getResult();
    expect(result.textParts).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.costUsd).toBeUndefined();
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.streamError).toBeUndefined();
    expect(result.turnCount).toBe(0);
    expect(result.lineCount).toBe(0);
  });

  it('returns a defensive copy of arrays — mutating the result does not affect the parser', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: true });
    parser.recordUserMessage('hi');
    const r1 = parser.getResult();
    r1.messages.push({ role: 'assistant', content: 'leak', contentType: 'text' });
    r1.textParts.push('leak');
    const r2 = parser.getResult();
    expect(r2.messages).toHaveLength(1);
    expect(r2.textParts).toEqual([]);
  });
});

// ── recordUserMessage ────────────────────────────────────────────────────────

describe('ClaudeStreamParser — recordUserMessage', () => {
  it('appends a user message when captureMessages is true', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: true });
    parser.recordUserMessage('hello world');
    expect(parser.getResult().messages).toEqual([
      { role: 'user', content: 'hello world', contentType: 'text' },
    ]);
  });

  it('is a no-op when captureMessages is false', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: false });
    parser.recordUserMessage('hello world');
    expect(parser.getResult().messages).toEqual([]);
  });

  it('is a no-op when captureMessages is omitted', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.recordUserMessage('hello world');
    expect(parser.getResult().messages).toEqual([]);
  });
});

// ── handleLine — parsing behavior ────────────────────────────────────────────

describe('ClaudeStreamParser — handleLine: non-JSON and unknown events', () => {
  it('silently skips non-JSON lines but still increments lineCount', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine('this is not json');
    parser.handleLine('also not json');
    const r = parser.getResult();
    expect(r.lineCount).toBe(2);
    expect(r.textParts).toEqual([]);
    expect(r.streamError).toBeUndefined();
  });

  it('silently skips unknown event types', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'something_new', payload: 42 }));
    const r = parser.getResult();
    expect(r.lineCount).toBe(1);
    expect(r.streamError).toBeUndefined();
  });

  it('silently skips system events (no throw, just structured logging)', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'system', mcp_servers: [{ name: 'foo', status: 'ok' }] }));
    expect(parser.getResult().lineCount).toBe(1);
  });

  it('calls onRawLine for every line including non-JSON', () => {
    const onRawLine = vi.fn();
    const parser = new ClaudeStreamParser({ automationName: 'test', onRawLine });
    parser.handleLine('not json');
    parser.handleLine(assistantText('hi'));
    expect(onRawLine).toHaveBeenCalledTimes(2);
    expect(onRawLine).toHaveBeenNthCalledWith(1, 'not json');
    expect(onRawLine).toHaveBeenNthCalledWith(2, assistantText('hi'));
  });
});

describe('ClaudeStreamParser — handleLine: assistant events', () => {
  it('accumulates assistant text into textParts and increments turnCount', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(assistantText('first chunk'));
    parser.handleLine(assistantText('second chunk'));
    const r = parser.getResult();
    expect(r.textParts).toEqual(['first chunk', 'second chunk']);
    expect(r.turnCount).toBe(2);
  });

  it('captures assistant text as a message when captureMessages is true', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: true });
    parser.handleLine(assistantText('hello'));
    expect(parser.getResult().messages).toEqual([
      { role: 'assistant', content: 'hello', contentType: 'text' },
    ]);
  });

  it('captures tool_use blocks as messages with serialized input and toolName', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: true });
    parser.handleLine(assistantToolUse('Bash', { command: 'ls' }));
    expect(parser.getResult().messages).toEqual([
      {
        role: 'tool_use',
        content: '{"command":"ls"}',
        contentType: 'tool_use',
        toolName: 'Bash',
      },
    ]);
  });

  it('does not push messages for tool_use blocks when captureMessages is false', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(assistantToolUse('Bash', { command: 'ls' }));
    expect(parser.getResult().messages).toEqual([]);
    // turnCount should still increment because the assistant turn happened
    expect(parser.getResult().turnCount).toBe(1);
  });

  it('handles a single assistant event with mixed text and tool_use blocks', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: true });
    parser.handleLine(
      j({
        type: 'assistant',
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'tool_use', name: 'Read', input: { path: '/foo' } },
        ],
      }),
    );
    const r = parser.getResult();
    expect(r.textParts).toEqual(['thinking out loud']);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe('assistant');
    expect(r.messages[1].role).toBe('tool_use');
    expect(r.turnCount).toBe(1);
  });

  it('falls back to "unknown" tool name when name field is missing', () => {
    const onProgress = vi.fn();
    const parser = new ClaudeStreamParser({ automationName: 'test', onProgress });
    parser.handleLine(j({ type: 'assistant', content: [{ type: 'tool_use', input: {} }] }));
    expect(onProgress).toHaveBeenCalledWith('tool_use:unknown', { turn: 1 });
  });
});

describe('ClaudeStreamParser — handleLine: user (tool_result) events', () => {
  it('captures tool_result blocks as messages when captureMessages is true', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: true });
    parser.handleLine(userToolResult('toolu_123', 'file contents here'));
    expect(parser.getResult().messages).toEqual([
      {
        role: 'tool_result',
        content: 'file contents here',
        contentType: 'tool_result',
        toolName: 'toolu_123',
      },
    ]);
  });

  it('serializes non-string tool_result content as JSON', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: true });
    parser.handleLine(userToolResult('toolu_456', { exitCode: 0, stdout: 'ok' }));
    expect(parser.getResult().messages[0].content).toBe('{"exitCode":0,"stdout":"ok"}');
  });

  it('skips user events entirely when captureMessages is false', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(userToolResult('toolu_123', 'file contents'));
    expect(parser.getResult().messages).toEqual([]);
  });

  it('does not increment turnCount for user events', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test', captureMessages: true });
    parser.handleLine(userToolResult('toolu_123', 'x'));
    expect(parser.getResult().turnCount).toBe(0);
  });
});

describe('ClaudeStreamParser — handleLine: result events', () => {
  it('extracts cost, tokens, and sessionId from a successful result', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(
      successResult({
        result: 'final output',
        cost: 0.0123,
        inputTokens: 1500,
        outputTokens: 750,
        sessionId: 'sess_abc',
      }),
    );
    const r = parser.getResult();
    expect(r.costUsd).toBe(0.0123);
    expect(r.inputTokens).toBe(1500);
    expect(r.outputTokens).toBe(750);
    expect(r.sessionId).toBe('sess_abc');
    expect(r.streamError).toBeUndefined();
  });

  it('replaces accumulated textParts with result.result on successful completion', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(assistantText('partial'));
    parser.handleLine(assistantText('more partial'));
    parser.handleLine(successResult({ result: 'final consolidated answer' }));
    expect(parser.getResult().textParts).toEqual(['final consolidated answer']);
  });

  it('falls back to alternate cost field names', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'result', is_error: false, cost_usd: 0.05 }));
    expect(parser.getResult().costUsd).toBe(0.05);
  });

  it('ignores non-finite cost values (Infinity, NaN)', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'result', is_error: false, total_cost_usd: 'NaN' }));
    expect(parser.getResult().costUsd).toBeUndefined();
  });

  it('handles missing usage object gracefully', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'result', is_error: false, total_cost_usd: 0.01 }));
    const r = parser.getResult();
    expect(r.costUsd).toBe(0.01);
    expect(r.inputTokens).toBeUndefined();
    expect(r.outputTokens).toBeUndefined();
  });

  it('handles partial usage (only one of input/output tokens)', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'result', is_error: false, usage: { input_tokens: 100 } }));
    const r = parser.getResult();
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBeUndefined();
  });

  it('sets streamError from is_error result with error field', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(errorResult({ error: 'something went wrong' }));
    expect(parser.getResult().streamError).toBe('something went wrong');
  });

  it('joins errors[] array when error field is missing', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(errorResult({ errors: ['first', 'second', 'third'] }));
    expect(parser.getResult().streamError).toBe('first; second; third');
  });

  it('falls back to result.result when both error and errors are missing', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(errorResult({ result: 'malformed output as error' }));
    expect(parser.getResult().streamError).toBe('malformed output as error');
  });

  it('uses a generic message when no error details are provided', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'result', is_error: true }));
    expect(parser.getResult().streamError).toBe('Claude reported an error');
  });

  it('does NOT replace textParts when result is marked as error', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(assistantText('partial work'));
    parser.handleLine(errorResult({ error: 'crashed' }));
    expect(parser.getResult().textParts).toEqual(['partial work']);
    expect(parser.getResult().streamError).toBe('crashed');
  });
});

describe('ClaudeStreamParser — handleLine: standalone error events', () => {
  it('captures standalone error events as streamError', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(standaloneError('connection refused'));
    expect(parser.getResult().streamError).toBe('connection refused');
  });

  it('prefixes rate-limit messages with rate_limit:', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(standaloneError('rate limit exceeded'));
    expect(parser.getResult().streamError).toBe('rate_limit: rate limit exceeded');
  });

  it('detects rate limits via 429 in the message', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(standaloneError('HTTP 429 too many requests'));
    expect(parser.getResult().streamError).toMatch(/^rate_limit: /);
  });

  it('detects rate limits via overloaded_error error_type', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(standaloneError('server busy', 'overloaded_error'));
    expect(parser.getResult().streamError).toBe('rate_limit: server busy');
  });

  it('uses event.error when message is missing', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'error', error: 'fallback message' }));
    expect(parser.getResult().streamError).toBe('fallback message');
  });

  it('uses "Unknown error" when both message and error are missing', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(j({ type: 'error' }));
    expect(parser.getResult().streamError).toBe('Unknown error');
  });
});

// ── Progress throttling ──────────────────────────────────────────────────────

describe('ClaudeStreamParser — progress throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the first progress event immediately', () => {
    const onProgress = vi.fn();
    const parser = new ClaudeStreamParser({ automationName: 'test', onProgress });
    parser.handleLine(assistantText('hello'));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('thinking', { turn: 1 });
  });

  it('coalesces emits within the 1-second throttle window', () => {
    const onProgress = vi.fn();
    const parser = new ClaudeStreamParser({ automationName: 'test', onProgress });
    parser.handleLine(assistantText('one'));
    vi.advanceTimersByTime(200);
    parser.handleLine(assistantToolUse('Bash'));
    vi.advanceTimersByTime(200);
    parser.handleLine(assistantText('two'));
    expect(onProgress).toHaveBeenCalledTimes(1); // only the first emit got through
  });

  it('emits again once the throttle window has elapsed', () => {
    const onProgress = vi.fn();
    const parser = new ClaudeStreamParser({ automationName: 'test', onProgress });
    parser.handleLine(assistantText('one'));
    vi.advanceTimersByTime(1100);
    parser.handleLine(assistantText('two'));
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 'thinking', { turn: 2 });
  });

  it('flushProgress emits the most recently coalesced stage', () => {
    const onProgress = vi.fn();
    const parser = new ClaudeStreamParser({ automationName: 'test', onProgress });
    parser.handleLine(assistantText('first'));     // immediate emit (thinking, turn 1)
    vi.advanceTimersByTime(200);
    parser.handleLine(assistantToolUse('Read'));   // throttled, pendingStage = tool_use:Read
    vi.advanceTimersByTime(200);
    parser.handleLine(assistantToolUse('Write'));  // throttled, pendingStage = tool_use:Write
    expect(onProgress).toHaveBeenCalledTimes(1);
    parser.flushProgress();
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith('tool_use:Write', { turn: 3 });
  });

  it('flushProgress is a no-op when there is no pending stage', () => {
    const onProgress = vi.fn();
    const parser = new ClaudeStreamParser({ automationName: 'test', onProgress });
    parser.handleLine(assistantText('one'));   // immediate emit, clears pending
    expect(onProgress).toHaveBeenCalledTimes(1);
    parser.flushProgress();                    // nothing pending
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('flushProgress is a no-op when no onProgress callback is configured', () => {
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(assistantText('one'));
    // Should not throw
    expect(() => parser.flushProgress()).not.toThrow();
  });

  it('does not invoke onProgress at all when the callback is undefined', () => {
    // No spy can verify "not called" — instead, just confirm parsing still works.
    const parser = new ClaudeStreamParser({ automationName: 'test' });
    parser.handleLine(assistantText('one'));
    parser.handleLine(assistantToolUse('Bash'));
    expect(parser.getResult().turnCount).toBe(2);
  });

  it('isolates a throwing onProgress callback so the run continues', () => {
    const onProgress = vi.fn(() => {
      throw new Error('callback exploded');
    });
    const parser = new ClaudeStreamParser({ automationName: 'test', onProgress });
    expect(() => parser.handleLine(assistantText('one'))).not.toThrow();
    expect(parser.getResult().turnCount).toBe(1);
  });

  it('isolates a throwing onProgress callback during flushProgress', () => {
    const onProgress = vi.fn();
    onProgress.mockImplementationOnce(() => {}); // first call (immediate emit) succeeds
    onProgress.mockImplementationOnce(() => { throw new Error('boom'); }); // flush call throws

    const parser = new ClaudeStreamParser({ automationName: 'test', onProgress });
    parser.handleLine(assistantText('one'));
    vi.advanceTimersByTime(200);
    parser.handleLine(assistantText('two')); // throttled, becomes pending
    expect(() => parser.flushProgress()).not.toThrow();
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});

// ── End-to-end fixture ──────────────────────────────────────────────────────

describe('ClaudeStreamParser — end-to-end fixture', () => {
  it('parses a full successful run with text, tool_use, tool_result, and result', () => {
    const onProgress = vi.fn();
    const parser = new ClaudeStreamParser({
      automationName: 'e2e',
      captureMessages: true,
      onProgress,
    });

    parser.recordUserMessage('please run ls');
    parser.handleLine(j({ type: 'system', mcp_servers: [] }));
    parser.handleLine(assistantText("I'll run ls for you."));
    parser.handleLine(assistantToolUse('Bash', { command: 'ls' }));
    parser.handleLine(userToolResult('toolu_1', 'file1\nfile2\n'));
    parser.handleLine(assistantText('Found 2 files: file1 and file2.'));
    parser.handleLine(
      successResult({
        result: 'Found 2 files: file1 and file2.',
        cost: 0.0042,
        inputTokens: 200,
        outputTokens: 30,
        sessionId: 'sess_e2e',
      }),
    );
    parser.flushProgress();

    const r = parser.getResult();
    expect(r.lineCount).toBe(6); // recordUserMessage doesn't increment lineCount
    expect(r.turnCount).toBe(3); // 3 assistant events
    expect(r.textParts).toEqual(['Found 2 files: file1 and file2.']); // replaced by result
    expect(r.costUsd).toBe(0.0042);
    expect(r.inputTokens).toBe(200);
    expect(r.outputTokens).toBe(30);
    expect(r.sessionId).toBe('sess_e2e');
    expect(r.streamError).toBeUndefined();
    expect(r.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool_use',
      'tool_result',
      'assistant',
    ]);
  });

  it('parses a run that fails mid-stream with a rate-limit error', () => {
    const parser = new ClaudeStreamParser({ automationName: 'e2e-fail' });
    parser.handleLine(assistantText('starting...'));
    parser.handleLine(standaloneError('rate limit exceeded', 'overloaded_error'));
    const r = parser.getResult();
    expect(r.textParts).toEqual(['starting...']);
    expect(r.streamError).toBe('rate_limit: rate limit exceeded');
    expect(r.turnCount).toBe(1);
  });
});
