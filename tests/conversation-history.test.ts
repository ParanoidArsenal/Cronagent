/**
 * Unit tests for conversation-related features:
 *
 *  1. History — CRUD methods for conversations and conversation_messages
 *  2. Runner  — message capture from stream-json, --resume flag, session_id extraction
 *  3. Types   — AutomationFrontmatterSchema `conversation` field defaults to false
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
}));

// ── Mock execa ────────────────────────────────────────────────────────────────

vi.mock('execa', () => ({
  execa: execaMock,
}));

// ── Mock node:fs/promises ─────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => 'test prompt content'),
  writeFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  appendFile: vi.fn(async () => {}),
}));

// ── Mock logger ───────────────────────────────────────────────────────────────

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Mock pg Pool ──────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockEnd = vi.fn(async () => {});

vi.mock('pg', () => {
  class Pool {
    query: typeof mockQuery;
    end: typeof mockEnd;
    constructor() {
      this.query = mockQuery;
      this.end = mockEnd;
    }
  }
  return { default: { Pool } };
});

// ── Imports under test ────────────────────────────────────────────────────────

import { History } from '../src/history.js';
import { Runner } from '../src/runner.js';
import { AutomationFrontmatterSchema } from '../src/types.js';
import type { Automation, ConversationContext } from '../src/types.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    name: 'test-auto',
    description: 'test',
    trigger: 'manual',
    schedule: null,
    timeout: 60,
    mcp: [],
    model: 'sonnet',
    instructions: 'Do the thing.',
    filePath: '/tmp/test.md',
    mode: 'claude',
    sandbox: false,
    maxRetries: 0,
    retryDelayMs: 1000,
    conversation: false,
    ...overrides,
  };
}

/**
 * Build a mock execa subprocess that yields the given NDJSON lines and
 * resolves with exitCode 0 on await.
 */
function mockClaudeStream(lines: string[], exitCode = 0) {
  const proc = Object.assign(
    Promise.resolve({ exitCode, stdout: lines, stderr: '', failed: false }),
    {
      async *[Symbol.asyncIterator]() {
        for (const line of lines) yield line;
      },
    },
  );
  execaMock.mockReturnValue(proc);
  return proc;
}

function resultLine(opts: {
  result?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
  isError?: boolean;
} = {}): string {
  return JSON.stringify({
    type: 'result',
    result: opts.result ?? 'done',
    is_error: opts.isError ?? false,
    total_cost_usd: opts.cost ?? 0.001,
    session_id: opts.sessionId,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 50,
    },
  });
}

function assistantTextLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    content: [{ type: 'text', text }],
  });
}

function assistantToolUseLine(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    content: [{ type: 'tool_use', name, input }],
  });
}

function userToolResultLine(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  });
}

// ── History — createConversation ──────────────────────────────────────────────

describe('History.createConversation()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Stub the schema migration query
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('inserts a row with the given id and automationName', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.createConversation('conv-123', 'my-automation');

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[0]).toMatch(/INSERT INTO conversations/i);
    expect(call[1]).toEqual(['conv-123', 'my-automation']);
  });
});

// ── History — getConversation ─────────────────────────────────────────────────

describe('History.getConversation()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('returns the matching ConversationRecord', async () => {
    const record = {
      id: 'conv-abc',
      automation_name: 'bot',
      claude_session_id: 'sess-1',
      created_at: new Date(),
      updated_at: new Date(),
      closed: false,
      total_cost_usd: 0.5,
      total_turns: 3,
    };
    mockQuery.mockResolvedValueOnce({ rows: [record] });

    const result = await history.getConversation('conv-abc');

    expect(result).toEqual(record);
  });

  it('returns undefined when no row matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await history.getConversation('nonexistent');

    expect(result).toBeUndefined();
  });

  it('queries by the provided id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.getConversation('target-id');

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[1]).toContain('target-id');
  });
});

// ── History — getActiveConversation ──────────────────────────────────────────

describe('History.getActiveConversation()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('returns the most-recently-updated open conversation for the automation', async () => {
    const record = {
      id: 'conv-open',
      automation_name: 'my-auto',
      claude_session_id: 'sess-open',
      created_at: new Date(),
      updated_at: new Date(),
      closed: false,
      total_cost_usd: 0,
      total_turns: 1,
    };
    mockQuery.mockResolvedValueOnce({ rows: [record] });

    const result = await history.getActiveConversation('my-auto');

    expect(result).toEqual(record);
  });

  it('returns undefined when no active conversation exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await history.getActiveConversation('ghost-auto');

    expect(result).toBeUndefined();
  });

  it('queries with the automation name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.getActiveConversation('specific-auto');

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[1]).toContain('specific-auto');
  });

  it('restricts to closed = false and a 24-hour window', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.getActiveConversation('any-auto');

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const sql: string = call[0];
    expect(sql).toMatch(/closed\s*=\s*false/i);
    expect(sql).toMatch(/24 hours/i);
  });
});

// ── History — updateConversationSession ──────────────────────────────────────

describe('History.updateConversationSession()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('updates claude_session_id for the given conversation id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.updateConversationSession('conv-1', 'new-session-id');

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[0]).toMatch(/UPDATE conversations/i);
    expect(call[1]).toContain('new-session-id');
    expect(call[1]).toContain('conv-1');
  });
});

// ── History — updateConversationStats ────────────────────────────────────────

describe('History.updateConversationStats()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('increments total_cost_usd by the costDelta and total_turns by 1', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.updateConversationStats('conv-2', 0.05);

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const sql: string = call[0];
    expect(sql).toMatch(/total_cost_usd\s*=\s*total_cost_usd\s*\+/i);
    expect(sql).toMatch(/total_turns\s*=\s*total_turns\s*\+\s*1/i);
    expect(call[1]).toContain(0.05);
    expect(call[1]).toContain('conv-2');
  });
});

// ── History — closeConversation ───────────────────────────────────────────────

describe('History.closeConversation()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('sets closed = true for the given conversation id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.closeConversation('conv-to-close');

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const sql: string = call[0];
    expect(sql).toMatch(/SET\s+closed\s*=\s*true/i);
    expect(call[1]).toContain('conv-to-close');
  });
});

// ── History — getConversationMessages ────────────────────────────────────────

describe('History.getConversationMessages()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('returns all messages ordered by seq', async () => {
    const messages = [
      { id: 1, conversation_id: 'conv-x', run_id: 10, role: 'user', content: 'hello', content_type: 'text', tool_name: null, created_at: new Date(), seq: 0 },
      { id: 2, conversation_id: 'conv-x', run_id: 10, role: 'assistant', content: 'hi', content_type: 'text', tool_name: null, created_at: new Date(), seq: 1 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: messages });

    const result = await history.getConversationMessages('conv-x');

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('returns an empty array when no messages exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await history.getConversationMessages('empty-conv');

    expect(result).toEqual([]);
  });

  it('queries with the conversation id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.getConversationMessages('target-conv');

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[1]).toContain('target-conv');
  });
});

// ── History — getMaxMessageSeq ────────────────────────────────────────────────

describe('History.getMaxMessageSeq()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('returns the maximum seq value when messages exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ max_seq: 7 }] });

    const result = await history.getMaxMessageSeq('conv-y');

    expect(result).toBe(7);
  });

  it('returns 0 when no messages exist (MAX returns NULL)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ max_seq: null }] });

    const result = await history.getMaxMessageSeq('empty-conv');

    expect(result).toBe(0);
  });

  it('queries for the correct conversation id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ max_seq: null }] });

    await history.getMaxMessageSeq('seq-conv-id');

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[1]).toContain('seq-conv-id');
  });
});

// ── History — insertConversationMessages ──────────────────────────────────────

describe('History.insertConversationMessages()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('does nothing when messages array is empty', async () => {
    const callsBefore = mockQuery.mock.calls.length;

    await history.insertConversationMessages('conv-z', 1, [], 0);

    expect(mockQuery.mock.calls.length).toBe(callsBefore);
  });

  it('inserts a single message with correct fields and seq', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.insertConversationMessages('conv-a', 42, [
      { role: 'user', content: 'hello', contentType: 'text' },
    ], 0);

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const sql: string = call[0];
    expect(sql).toMatch(/INSERT INTO conversation_messages/i);
    const values = call[1] as unknown[];
    expect(values).toContain('conv-a');
    expect(values).toContain(42);
    expect(values).toContain('user');
    expect(values).toContain('hello');
    expect(values).toContain('text');
    expect(values).toContain(0); // seq = startSeq + 0
  });

  it('inserts multiple messages with sequential seq values starting from startSeq', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.insertConversationMessages('conv-b', 7, [
      { role: 'user', content: 'msg 1', contentType: 'text' },
      { role: 'assistant', content: 'msg 2', contentType: 'text' },
      { role: 'tool_use', content: '{}', contentType: 'tool_use', toolName: 'bash' },
    ], 5);

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const values = call[1] as unknown[];
    // startSeq = 5, so seq values should be 5, 6, 7
    expect(values).toContain(5);
    expect(values).toContain(6);
    expect(values).toContain(7);
    // toolName is included
    expect(values).toContain('bash');
  });

  it('stores null for toolName when it is absent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.insertConversationMessages('conv-c', 1, [
      { role: 'user', content: 'plain text', contentType: 'text' },
    ], 0);

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const values = call[1] as unknown[];
    expect(values).toContain(null);
  });
});

// ── History — getConversationHistory ─────────────────────────────────────────

describe('History.getConversationHistory()', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('returns all conversations ordered by updated_at when no automation filter', async () => {
    const records = [
      { id: 'c1', automation_name: 'a', claude_session_id: null, created_at: new Date(), updated_at: new Date(), closed: false, total_cost_usd: 0, total_turns: 0 },
      { id: 'c2', automation_name: 'b', claude_session_id: null, created_at: new Date(), updated_at: new Date(), closed: true, total_cost_usd: 1.0, total_turns: 5 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: records });

    const result = await history.getConversationHistory();

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('c1');
  });

  it('filters by automation name when provided', async () => {
    const records = [
      { id: 'c3', automation_name: 'filtered-auto', claude_session_id: null, created_at: new Date(), updated_at: new Date(), closed: false, total_cost_usd: 0, total_turns: 0 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: records });

    const result = await history.getConversationHistory('filtered-auto');

    expect(result).toHaveLength(1);
    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[1]).toContain('filtered-auto');
  });

  it('passes the default limit of 10 in the no-filter path', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.getConversationHistory();

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[1]).toContain(10);
  });

  it('respects a custom limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await history.getConversationHistory(undefined, 25);

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(call[1]).toContain(25);
  });

  it('returns an empty array when no conversations match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await history.getConversationHistory('nonexistent');

    expect(result).toEqual([]);
  });
});

// ── History — insert() returns id and accepts conversationId/sessionId ────────

describe('History.insert() — conversation fields', () => {
  let history: History;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    history = await History.create('postgres://localhost/test');
  });

  it('returns the numeric id from the inserted row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });

    const id = await history.insert({
      automationName: 'test',
      success: true,
      output: 'output',
      durationMs: 100,
      startedAt: new Date(),
      finishedAt: new Date(),
      mode: 'claude',
    });

    expect(id).toBe(42);
  });

  it('passes conversationId and sessionId through when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await history.insert({
      automationName: 'test',
      success: true,
      output: 'output',
      durationMs: 100,
      startedAt: new Date(),
      finishedAt: new Date(),
      mode: 'claude',
      conversationId: 'conv-999',
      sessionId: 'sess-777',
    });

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const values = call[1] as unknown[];
    expect(values).toContain('conv-999');
    expect(values).toContain('sess-777');
  });

  it('passes null for conversationId and sessionId when omitted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 2 }] });

    await history.insert({
      automationName: 'test',
      success: true,
      output: 'output',
      durationMs: 100,
      startedAt: new Date(),
      finishedAt: new Date(),
      mode: 'claude',
    });

    const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const values = call[1] as unknown[];
    // Last two params are conversationId and sessionId
    expect(values[values.length - 2]).toBeNull();
    expect(values[values.length - 1]).toBeNull();
  });
});

// ── Runner — conversation message capture ─────────────────────────────────────

describe('Runner — conversation message capture', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new Runner(undefined, false);
  });

  it('returns undefined messages when conversation is false', async () => {
    mockClaudeStream([
      assistantTextLine('Response text.'),
      resultLine({ result: 'done', sessionId: 'sess-1' }),
    ]);

    const result = await runner.execute(makeAutomation({ conversation: false }));

    expect(result.messages).toBeUndefined();
  });

  it('captures the user prompt as the first message when conversation is true', async () => {
    mockClaudeStream([resultLine()]);

    const result = await runner.execute(makeAutomation({ conversation: true }));

    expect(result.messages).toBeDefined();
    const first = result.messages![0];
    expect(first.role).toBe('user');
    expect(first.content).toBe('test prompt content');
    expect(first.contentType).toBe('text');
  });

  it('captures assistant text blocks', async () => {
    mockClaudeStream([
      assistantTextLine('Hello from Claude.'),
      resultLine(),
    ]);

    const result = await runner.execute(makeAutomation({ conversation: true }));

    expect(result.messages).toBeDefined();
    const assistantMsg = result.messages!.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe('Hello from Claude.');
    expect(assistantMsg!.contentType).toBe('text');
  });

  it('captures tool_use blocks with toolName and serialised input', async () => {
    mockClaudeStream([
      assistantToolUseLine('bash', { command: 'ls -la' }),
      resultLine(),
    ]);

    const result = await runner.execute(makeAutomation({ conversation: true }));

    const toolUseMsg = result.messages!.find((m) => m.role === 'tool_use');
    expect(toolUseMsg).toBeDefined();
    expect(toolUseMsg!.toolName).toBe('bash');
    expect(toolUseMsg!.contentType).toBe('tool_use');
    expect(JSON.parse(toolUseMsg!.content)).toEqual({ command: 'ls -la' });
  });

  it('captures tool_result blocks with the tool_use_id as toolName', async () => {
    mockClaudeStream([
      userToolResultLine('tu-abc', 'result output'),
      resultLine(),
    ]);

    const result = await runner.execute(makeAutomation({ conversation: true }));

    const toolResultMsg = result.messages!.find((m) => m.role === 'tool_result');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.toolName).toBe('tu-abc');
    expect(toolResultMsg!.contentType).toBe('tool_result');
    expect(toolResultMsg!.content).toBe('result output');
  });

  it('captures multiple messages in order: user, assistant, tool_use', async () => {
    mockClaudeStream([
      assistantTextLine('Thinking...'),
      assistantToolUseLine('read_file', { path: '/etc/hosts' }),
      resultLine(),
    ]);

    const result = await runner.execute(makeAutomation({ conversation: true }));

    const messages = result.messages!;
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('tool_use');
  });

  it('does not add assistant messages when conversation is false', async () => {
    mockClaudeStream([
      assistantTextLine('This text should not be captured as a message.'),
      resultLine(),
    ]);

    const result = await runner.execute(makeAutomation({ conversation: false }));

    expect(result.messages).toBeUndefined();
  });
});

// ── Runner — session_id extraction from result event ─────────────────────────

describe('Runner — session_id captured from result event', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new Runner(undefined, false);
  });

  it('extracts session_id from a result event', async () => {
    mockClaudeStream([resultLine({ sessionId: 'claude-session-xyz' })]);

    const result = await runner.execute(makeAutomation());

    expect(result.sessionId).toBe('claude-session-xyz');
  });

  it('returns undefined sessionId when result event has no session_id', async () => {
    mockClaudeStream([
      JSON.stringify({
        type: 'result',
        result: 'done',
        is_error: false,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
        // no session_id field
      }),
    ]);

    const result = await runner.execute(makeAutomation());

    expect(result.sessionId).toBeUndefined();
  });

  it('ignores session_id when it is not a string', async () => {
    mockClaudeStream([
      JSON.stringify({
        type: 'result',
        result: 'done',
        is_error: false,
        total_cost_usd: 0.001,
        session_id: 12345, // number — should be ignored
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);

    const result = await runner.execute(makeAutomation());

    expect(result.sessionId).toBeUndefined();
  });
});

// ── Runner — --resume flag when conversationCtx is provided ──────────────────

describe('Runner — --resume flag', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new Runner(undefined, false);
  });

  it('passes --resume <sessionId> when conversationCtx is provided', async () => {
    mockClaudeStream([resultLine()]);

    const ctx: ConversationContext = {
      conversationId: 'conv-111',
      sessionId: 'sess-previous',
    };

    await runner.execute(makeAutomation(), undefined, ctx);

    const call = execaMock.mock.calls[0];
    const args: string[] = call[1];
    const idx = args.indexOf('--resume');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('sess-previous');
  });

  it('does not pass --resume when conversationCtx is undefined', async () => {
    mockClaudeStream([resultLine()]);

    await runner.execute(makeAutomation());

    const call = execaMock.mock.calls[0];
    const args: string[] = call[1];
    expect(args).not.toContain('--resume');
  });

  it('does not pass --resume when conversationCtx has an empty sessionId', async () => {
    mockClaudeStream([resultLine()]);

    const ctx: ConversationContext = {
      conversationId: 'conv-222',
      sessionId: '',
    };

    await runner.execute(makeAutomation(), undefined, ctx);

    const call = execaMock.mock.calls[0];
    const args: string[] = call[1];
    expect(args).not.toContain('--resume');
  });
});

// ── Runner — --resume in sandbox mode ────────────────────────────────────────

describe('Runner — --resume in sandbox mode', () => {
  let runner: Runner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new Runner(undefined, true);
  });

  it('does NOT include --resume in sandbox mode (session files live on host)', async () => {
    mockClaudeStream([resultLine()]);

    const ctx: ConversationContext = {
      conversationId: 'conv-sandbox',
      sessionId: 'sess-sandbox',
    };

    await runner.execute(makeAutomation({ sandbox: true }), undefined, ctx);

    const call = execaMock.mock.calls[0];
    const dockerArgs: string[] = call[1];
    // The last docker arg is the bash -c command string
    const claudeCmd = dockerArgs[dockerArgs.length - 1];
    expect(claudeCmd).not.toContain('--resume');
    expect(claudeCmd).not.toContain('sess-sandbox');
  });
});

// ── Types — AutomationFrontmatterSchema conversation field ────────────────────

describe('AutomationFrontmatterSchema — conversation field', () => {
  const base = {
    name: 'test-auto',
  };

  it('defaults conversation to false when the field is omitted', () => {
    const result = AutomationFrontmatterSchema.parse(base);

    expect(result.conversation).toBe(false);
  });

  it('accepts conversation: true', () => {
    const result = AutomationFrontmatterSchema.parse({ ...base, conversation: true });

    expect(result.conversation).toBe(true);
  });

  it('accepts conversation: false explicitly', () => {
    const result = AutomationFrontmatterSchema.parse({ ...base, conversation: false });

    expect(result.conversation).toBe(false);
  });

  it('rejects non-boolean values for conversation', () => {
    expect(() =>
      AutomationFrontmatterSchema.parse({ ...base, conversation: 'yes' }),
    ).toThrow();
  });
});
