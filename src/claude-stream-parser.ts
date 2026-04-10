/**
 * Parses Claude CLI stream-json output into structured results.
 *
 * The CLI emits newline-delimited JSON events on stdout, one per line. This
 * class accumulates state across events and exposes the final result via
 * {@link getResult}. It is pure state — no I/O — so it can be unit-tested by
 * feeding fixture lines directly, without mocking execa/fs/subprocess.
 *
 * The parser also owns progress throttling: callers pass an `onProgress`
 * callback and the parser guarantees at most one invocation per
 * {@link PROGRESS_MIN_INTERVAL_MS}, flushing the last pending stage on
 * {@link flushProgress}.
 */

import { logger } from './logger.js';
import type { ConversationMessage, ProgressCallback } from './types.js';
import { isRateLimitMessage } from './rate-limit.js';

const PROGRESS_MIN_INTERVAL_MS = 1000;

export interface ClaudeStreamParserOpts {
  automationName: string;
  /** Populate the `messages` array (only needed for conversation-mode runs). */
  captureMessages?: boolean;
  /** Throttled progress callback. */
  onProgress?: ProgressCallback;
  /** Invoked for each raw line before JSON parsing (e.g. to append to a log file). */
  onRawLine?: (line: string) => void;
}

export interface ClaudeStreamResult {
  textParts: string[];
  messages: ConversationMessage[];
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
  /** Set if the stream contained a `result{is_error}` or standalone `error` event. */
  streamError?: string;
  turnCount: number;
  lineCount: number;
}

export class ClaudeStreamParser {
  private textParts: string[] = [];
  private messages: ConversationMessage[] = [];
  private costUsd?: number;
  private inputTokens?: number;
  private outputTokens?: number;
  private sessionId?: string;
  private streamError?: string;
  private turnCount = 0;
  private lineCount = 0;

  // Progress throttling state
  private lastEmitAt = 0;
  private pendingStage: string | null = null;

  constructor(private readonly opts: ClaudeStreamParserOpts) {}

  /** Record the initial user prompt as the first conversation message. */
  recordUserMessage(content: string): void {
    if (this.opts.captureMessages) {
      this.messages.push({ role: 'user', content, contentType: 'text' });
    }
  }

  /** Process one raw line of stream output. Safe to call with non-JSON lines. */
  handleLine(line: string): void {
    this.lineCount++;
    if (this.lineCount <= 3) {
      logger.debug(
        { name: this.opts.automationName, lineCount: this.lineCount, line: String(line).slice(0, 200) },
        'Stream line received',
      );
    }
    this.opts.onRawLine?.(line);

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return; // non-JSON line — skip
    }

    switch (event.type) {
      case 'system':
        this.handleSystem(event);
        break;
      case 'assistant':
        this.handleAssistant(event);
        break;
      case 'user':
        this.handleUser(event);
        break;
      case 'result':
        this.handleResult(event);
        break;
      case 'error':
        this.handleError(event);
        break;
      // Ignore unknown event types
    }
  }

  /** Emit any pending throttled progress event. Call once when the stream ends. */
  flushProgress(): void {
    if (!this.opts.onProgress || this.pendingStage === null) return;
    try {
      this.opts.onProgress(this.pendingStage, { turn: this.turnCount });
    } catch (err) {
      logger.warn({ err }, 'onProgress callback threw on flush');
    }
    this.pendingStage = null;
  }

  /** Return the final parsed result. Safe to call multiple times. */
  getResult(): ClaudeStreamResult {
    return {
      textParts: [...this.textParts],
      messages: [...this.messages],
      costUsd: this.costUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      sessionId: this.sessionId,
      streamError: this.streamError,
      turnCount: this.turnCount,
      lineCount: this.lineCount,
    };
  }

  // ── Event handlers ─────────────────────────────────────────

  private handleSystem(event: Record<string, unknown>): void {
    if (event.mcp_servers) {
      logger.info(
        { name: this.opts.automationName, mcpServers: event.mcp_servers },
        'Claude MCP server status',
      );
    }
  }

  private handleAssistant(event: Record<string, unknown>): void {
    this.turnCount++;
    let lastStage: string | null = null;
    const content = event.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          this.textParts.push(block.text);
          lastStage = 'thinking';
          if (this.opts.captureMessages) {
            this.messages.push({ role: 'assistant', content: block.text, contentType: 'text' });
          }
        } else if (block.type === 'tool_use') {
          const toolName = typeof block.name === 'string' ? block.name : 'unknown';
          lastStage = `tool_use:${toolName}`;
          if (this.opts.captureMessages) {
            this.messages.push({
              role: 'tool_use',
              content: JSON.stringify(block.input ?? {}),
              contentType: 'tool_use',
              toolName: typeof block.name === 'string' ? block.name : undefined,
            });
          }
        }
      }
    }
    if (lastStage) this.emitProgress(lastStage);
  }

  private handleUser(event: Record<string, unknown>): void {
    if (!this.opts.captureMessages) return;
    const content = event.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result') {
        this.messages.push({
          role: 'tool_result',
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          contentType: 'tool_result',
          toolName: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        });
      }
    }
  }

  private handleResult(event: Record<string, unknown>): void {
    const rawCost = event.total_cost_usd ?? event.cost_usd ?? event.costUsd;
    this.costUsd = typeof rawCost === 'number' && isFinite(rawCost) ? rawCost : undefined;

    const usage = event.usage as Record<string, unknown> | undefined;
    const rawIn = usage?.input_tokens;
    this.inputTokens = typeof rawIn === 'number' && isFinite(rawIn) ? rawIn : undefined;
    const rawOut = usage?.output_tokens;
    this.outputTokens = typeof rawOut === 'number' && isFinite(rawOut) ? rawOut : undefined;

    if (typeof event.session_id === 'string') {
      this.sessionId = event.session_id;
    }

    if (event.is_error) {
      const errorsArr = Array.isArray(event.errors) ? (event.errors as string[]).join('; ') : undefined;
      this.streamError =
        (typeof event.error === 'string' ? event.error : undefined) ??
        errorsArr ??
        (typeof event.result === 'string' ? event.result : undefined) ??
        'Claude reported an error';
    } else if (typeof event.result === 'string') {
      // Only replace accumulated text with result.result on success
      this.textParts.length = 0;
      this.textParts.push(event.result);
    }
  }

  private handleError(event: Record<string, unknown>): void {
    const msg =
      (typeof event.message === 'string' ? event.message : undefined) ??
      (typeof event.error === 'string' ? event.error : undefined) ??
      'Unknown error';
    const isRateLimit =
      event.error_type === 'overloaded_error' ||
      isRateLimitMessage(String(msg));
    this.streamError = isRateLimit ? `rate_limit: ${msg}` : msg;
  }

  private emitProgress(stage: string): void {
    if (!this.opts.onProgress) return;
    this.pendingStage = stage;
    const now = Date.now();
    if (now - this.lastEmitAt >= PROGRESS_MIN_INTERVAL_MS) {
      this.lastEmitAt = now;
      try {
        this.opts.onProgress(stage, { turn: this.turnCount });
      } catch (err) {
        logger.warn({ err }, 'onProgress callback threw');
      }
      this.pendingStage = null;
    }
  }
}
