import { execa } from 'execa';
import { readFile, writeFile, rm, mkdir, appendFile } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import type { Automation, ExecutionResult, ConversationContext, ConversationMessage, ProgressCallback, LogFileCallback } from './types.js';
import type { Notifier } from './notifier.js';
import { ClaudeStreamParser } from './claude-stream-parser.js';
import { isRateLimitMessage } from './rate-limit.js';

export const LOGS_DIR = join(process.cwd(), 'logs');

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'cronagent-sandbox';

/**
 * Read the current Claude OAuth access token.
 *
 * Prefers ~/.claude/.credentials.json so we always pick up tokens refreshed by
 * the host Claude CLI. Falls back to CLAUDE_CODE_OAUTH_TOKEN env var (e.g. a
 * long-lived token from `claude setup-token`).
 */
async function readClaudeOauthToken(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token === 'string' && token.length > 0) return token;
  } catch {
    // fall through to env var
  }
  return process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/**
 * Read an MCP config file, resolve ${VAR} placeholders, and convert relative
 * command args to absolute paths (relative to the config file's directory).
 * Writes a temporary file with resolved values and returns its path.
 */
async function resolvedMcpConfig(
  configPath: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  let raw = await readFile(configPath, 'utf-8');
  raw = raw.replace(/\$\{(\w+)\}/g, (_, key) => env[key] ?? '');

  // Resolve relative paths in args to absolute (relative to config dir)
  try {
    const configDir = dirname(resolve(configPath));
    const config = JSON.parse(raw);
    const servers = config.mcpServers ?? config.mcpServers ?? {};
    for (const server of Object.values(servers) as Array<{ args?: string[] }>) {
      if (Array.isArray(server.args)) {
        server.args = server.args.map((arg: string) =>
          arg.endsWith('.js') && !isAbsolute(arg) ? resolve(configDir, arg) : arg,
        );
      }
    }
    raw = JSON.stringify(config, null, 2);
  } catch {
    // If parsing fails, pass through with just env resolution
  }

  const tmpPath = join(tmpdir(), `mcp-${randomUUID()}.json`);
  await writeFile(tmpPath, raw, 'utf-8');
  return tmpPath;
}

// ── Mode Result (internal) ──────────────────────────────────

/**
 * Internal discriminated-union result type returned by mode dispatchers.
 * All three mode functions (Claude / CAILA / Shell) normalize to this shape
 * before reaching the retry loop, so the loop itself is `try/catch`-free.
 *
 * Not exported — callers only see {@link ExecutionResult} via {@link Runner.execute}.
 */
type ModeResult =
  | {
      ok: true;
      output: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      logFile?: string;
      sessionId?: string;
      messages?: ConversationMessage[];
    }
  | {
      ok: false;
      error: string;
      logFile?: string;
      isRateLimit: boolean;
      // A failed Claude attempt may still have spent tokens (e.g. is_error
      // result, max-turns, non-zero exit after partial work).
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
    };

/**
 * Wrap a mode function that throws on failure (CAILA, shell) so it returns a
 * ModeResult instead. The retry loop can then branch on `result.ok` without
 * caring which mode produced it.
 *
 * For thrown errors there's no `logFile` (those modes don't produce one), so
 * the `logFile` field is left undefined.
 */
async function wrapThrowing(
  fn: () => Promise<{
    output: string;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  }>,
): Promise<ModeResult> {
  try {
    const r = await fn();
    return {
      ok: true,
      output: r.output,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      isRateLimit: isRateLimitMessage(message),
    };
  }
}

// ── Runner ──────────────────────────────────────────────────

export class Runner {
  private mcpConfigPath?: string;
  private sandboxEnabled: boolean;
  private notifier?: Notifier;

  constructor(mcpConfigPath?: string, sandboxEnabled = true, notifier?: Notifier) {
    this.mcpConfigPath = mcpConfigPath;
    this.sandboxEnabled = sandboxEnabled;
    this.notifier = notifier;
  }

  async execute(
    automation: Automation,
    extraEnv?: Record<string, string>,
    conversationCtx?: ConversationContext,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
    onLogFile?: LogFileCallback,
  ): Promise<ExecutionResult> {
    const startedAt = new Date();
    const maxRetries = automation.maxRetries ?? 0;
    const retryDelayMs = automation.retryDelayMs ?? 1000;
    const maxAttempts = maxRetries + 1;

    let totalCostUsd: number | undefined;
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    // Preserve the log file path from the most recent attempt so the final
    // failed ExecutionResult still references it if the last attempt didn't
    // produce one of its own.
    let lastLogFile: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Check abort signal before each attempt — prevents retry after stop
      if (signal?.aborted) {
        return this.buildFailureResult(
          automation,
          startedAt,
          'Run stopped by user',
          lastLogFile,
          attempt,
          { totalCostUsd, totalInputTokens, totalOutputTokens },
        );
      }

      const useSandbox = automation.sandbox && this.sandboxEnabled;
      const mergedEnv = extraEnv ? { ...process.env, ...extraEnv } : { ...process.env };
      const result = await this.dispatchMode(
        automation,
        useSandbox,
        mergedEnv,
        conversationCtx,
        onProgress,
        signal,
        onLogFile,
      );

      // Accumulate token/cost totals whether the attempt succeeded or not.
      if (result.costUsd !== undefined) totalCostUsd = (totalCostUsd ?? 0) + result.costUsd;
      if (result.inputTokens !== undefined) totalInputTokens = (totalInputTokens ?? 0) + result.inputTokens;
      if (result.outputTokens !== undefined) totalOutputTokens = (totalOutputTokens ?? 0) + result.outputTokens;

      if (result.ok) {
        const execResult: ExecutionResult = {
          automationName: automation.name,
          success: true,
          output: result.output,
          durationMs: Date.now() - startedAt.getTime(),
          startedAt,
          finishedAt: new Date(),
          mode: automation.mode,
          costUsd: totalCostUsd,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          logFile: result.logFile,
          attemptNumber: attempt,
          totalAttempts: attempt,
          sessionId: result.sessionId,
          messages: result.messages,
        };
        await this.notifier?.notify(execResult, automation);
        return execResult;
      }

      // Failed attempt — remember the log file for the final result.
      lastLogFile = result.logFile ?? lastLogFile;

      if (attempt < maxAttempts) {
        const delay = retryDelayMs * Math.pow(2, attempt - 1) * (result.isRateLimit ? 10 : 1);
        logger.warn(
          { name: automation.name, attempt, maxAttempts, delay, error: result.error, isRateLimit: result.isRateLimit },
          'Automation failed, retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return this.buildFailureResult(
        automation,
        startedAt,
        result.error,
        result.logFile ?? lastLogFile,
        attempt,
        { totalCostUsd, totalInputTokens, totalOutputTokens },
      );
    }

    // Unreachable (the loop always returns), but TypeScript needs it.
    throw new Error('Unexpected: retry loop exited without returning');
  }

  /**
   * Dispatch to the correct mode function and normalize its result into a
   * {@link ModeResult}. Claude mode already returns ModeResult natively;
   * CAILA and shell modes throw on failure and are adapted via
   * {@link wrapThrowing}.
   */
  private async dispatchMode(
    automation: Automation,
    useSandbox: boolean,
    mergedEnv: Record<string, string | undefined>,
    conversationCtx: ConversationContext | undefined,
    onProgress: ProgressCallback | undefined,
    signal: AbortSignal | undefined,
    onLogFile: LogFileCallback | undefined,
  ): Promise<ModeResult> {
    if (automation.mode === 'claude') {
      return this.executeClaudeMode(
        automation,
        useSandbox,
        mergedEnv,
        conversationCtx,
        onProgress,
        signal,
        onLogFile,
      );
    }
    if (automation.mode === 'caila') {
      return wrapThrowing(() => this.executeCailaMode(automation, mergedEnv, signal));
    }
    return wrapThrowing(() => this.executeShellMode(automation, useSandbox, mergedEnv, signal));
  }

  /**
   * Build a failed ExecutionResult and dispatch notification. Extracted so
   * both the abort and max-attempts-exhausted paths in {@link execute} can
   * share the same construction logic.
   */
  private async buildFailureResult(
    automation: Automation,
    startedAt: Date,
    error: string,
    logFile: string | undefined,
    attempt: number,
    totals: { totalCostUsd?: number; totalInputTokens?: number; totalOutputTokens?: number },
  ): Promise<ExecutionResult> {
    const execResult: ExecutionResult = {
      automationName: automation.name,
      success: false,
      output: '',
      error,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt,
      finishedAt: new Date(),
      mode: automation.mode,
      costUsd: totals.totalCostUsd,
      inputTokens: totals.totalInputTokens,
      outputTokens: totals.totalOutputTokens,
      logFile,
      attemptNumber: attempt,
      totalAttempts: attempt,
    };
    await this.notifier?.notify(execResult, automation);
    return execResult;
  }

  // ── Claude Mode ──────────────────────────────────────────

  private async executeClaudeMode(
    automation: Automation,
    sandbox: boolean,
    env: Record<string, string | undefined>,
    conversationCtx?: ConversationContext,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
    onLogFile?: LogFileCallback,
  ): Promise<ModeResult> {
    // Resources created inside the try block; the finally cleans them up.
    let tmpFile: string | undefined;
    let resolvedMcpPath: string | undefined;
    // logFile is produced partway through the run and is referenced from
    // the catch block for unexpected failures, so it lives at the top scope.
    let logFile: string | undefined;

    try {
      // Run preCollect shell command if configured — stdout is appended to prompt
      let preCollectOutput = '';
      if (automation.preCollect) {
        try {
          const { execa: execaFn } = await import('execa');
          const pcResult = await execaFn('bash', ['-c', automation.preCollect], {
            timeout: 30_000,
            env,
            reject: false,
            cancelSignal: signal,
          });
          if (pcResult.stdout) {
            preCollectOutput = String(pcResult.stdout);
          }
          if (pcResult.exitCode !== 0) {
            logger.warn(
              { name: automation.name, exitCode: pcResult.exitCode, stderr: String(pcResult.stderr ?? '').slice(0, 1000) },
              'Pre-collect exited non-zero, continuing',
            );
          }
          logger.info(
            { name: automation.name, preCollectLen: preCollectOutput.length },
            'Pre-collect completed',
          );
        } catch (pcErr) {
          logger.warn({ name: automation.name, error: String(pcErr) }, 'Pre-collect failed, continuing');
        }
      }

      // Write instructions to temp file, appending pre-collected data if any
      tmpFile = join(tmpdir(), `automation-${randomUUID()}.md`);
      const fullInstructions = preCollectOutput
        ? `${automation.instructions}\n\n---\n\n## Pre-collected data\n\n${preCollectOutput}`
        : automation.instructions;
      await writeFile(tmpFile, fullInstructions, 'utf-8');

      // Resolve ${VAR} placeholders in MCP config so Claude CLI gets actual values
      if (this.mcpConfigPath) {
        resolvedMcpPath = await resolvedMcpConfig(this.mcpConfigPath, env);
      }

      const cliArgs: string[] = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--model', automation.model,
        '--max-turns', String(automation.maxTurns ?? Math.max(10, Math.ceil(automation.timeout / 15))),
        '--effort', 'max',
      ];

      // Append system prompt if configured (e.g. MCP tool hints to skip ToolSearch)
      if (automation.systemPrompt) {
        cliArgs.push('--append-system-prompt', automation.systemPrompt);
      }

      // Resume a previous conversation if context is provided (not in sandbox — session files live on host)
      if (conversationCtx?.sessionId && !sandbox) {
        cliArgs.push('--resume', conversationCtx.sessionId);
      }

      let cmd: string;
      let cmdArgs: string[];
      let inputContent: string | undefined;

      // Read prompt content for piping via stdin
      const promptContent = await readFile(tmpFile, 'utf-8');

      if (sandbox) {
        if (resolvedMcpPath) {
          cliArgs.push('--mcp-config', '/tmp/mcp.json');
        }

        const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

        // Build setup commands to inject files via env vars (avoids Docker-in-Docker bind mount issues)
        const setupCmds: string[] = [];

        // Inject Claude credentials: read a fresh access token at runtime so we
        // survive host-side token refreshes without needing to restart the container.
        const oauthToken = await readClaudeOauthToken();

        // Inject MCP config from env var if present
        if (resolvedMcpPath) {
          setupCmds.push('printf \'%s\' "$_MCP_CONFIG" > /tmp/mcp.json');
        }

        // Write prompt to tmp file from env var, then pipe to Claude (avoids Docker stdin issues with execa)
        setupCmds.push('printf \'%s\' "$_PROMPT" > /tmp/prompt.txt');

        const claudeCmd = [...setupCmds, `cat /tmp/prompt.txt | claude ${cliArgs.map(shellEscape).join(' ')}`].join(' && ');

        logger.info(
          { name: automation.name, model: automation.model, sandbox: true },
          'Executing Claude automation in sandbox',
        );

        // Read file contents to inject via env vars instead of bind mounts
        const envVars: Record<string, string> = {};
        if (oauthToken) {
          envVars.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
        } else {
          logger.warn({ name: automation.name }, 'No Claude OAuth token available for sandbox injection');
        }
        if (resolvedMcpPath) {
          envVars._MCP_CONFIG = await readFile(resolvedMcpPath, 'utf-8');
        }
        envVars._PROMPT = promptContent;

        cmdArgs = buildDockerArgs({
          image: SANDBOX_IMAGE,
          timeout: automation.timeout,
          cmd: claudeCmd,
          envVars,
        });
        cmd = 'docker';
        inputContent = undefined; // all data injected via env vars
      } else {
        if (resolvedMcpPath) {
          cliArgs.push('--mcp-config', resolvedMcpPath);
        }

        logger.info(
          { name: automation.name, model: automation.model, sandbox: false },
          'Executing Claude automation',
        );

        // Read a fresh OAuth token so token refreshes on the host propagate
        // without needing to restart the container.
        const freshToken = await readClaudeOauthToken();
        if (freshToken) {
          env = { ...env, CLAUDE_CODE_OAUTH_TOKEN: freshToken };
        }

        cmd = 'claude';
        cmdArgs = cliArgs;
        inputContent = promptContent;
      }

      const timeout = sandbox
        ? (automation.timeout + 10) * 1000
        : automation.timeout * 1000;

      const proc = execa(cmd, cmdArgs, {
        timeout,
        env,
        reject: false,
        lines: true,
        input: inputContent,
      });

      // Wire abort signal to kill the subprocess when stopRun() is called.
      if (signal) {
        const onAbort = () => {
          logger.info({ name: automation.name }, 'Abort signal received, sending SIGTERM');
          proc.kill('SIGTERM');
        };
        if (signal.aborted) {
          proc.kill('SIGTERM');
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
          // Clean up listener when process exits naturally
          proc.then(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
        }
      }

      // Prepare log file (best-effort)
      try {
        await mkdir(LOGS_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        // The name comes from user-editable frontmatter — keep it to a single safe path segment.
        const safeName = automation.name.replace(/[^A-Za-z0-9._-]/g, '_');
        logFile = join(LOGS_DIR, `${safeName}_${ts}.log`);
      } catch {
        logger.warn({ name: automation.name }, 'Failed to create logs directory');
      }

      // Notify caller of the log file path BEFORE the first stream line is
      // appended, so a polling client can start tailing the file immediately
      // (live log streaming). The endpoint tolerates a missing file by
      // returning an empty body, so racing the first appendFile is safe.
      if (logFile && onLogFile) {
        try {
          onLogFile(logFile);
        } catch (err) {
          logger.warn({ err }, 'onLogFile callback threw');
        }
      }

      // Stream and accumulate events via the parser (pure state — no I/O).
      const captureMessages = automation.conversation;
      const logFilePath = logFile; // capture for closure (logFile is `let`)
      const parser = new ClaudeStreamParser({
        automationName: automation.name,
        captureMessages,
        onProgress,
        onRawLine: logFilePath
          ? (line) => {
              appendFile(logFilePath, line + '\n').catch(() => {});
            }
          : undefined,
      });

      // Record user prompt as first message in conversation
      if (captureMessages) {
        parser.recordUserMessage(promptContent);
      }

      for await (const line of proc) {
        parser.handleLine(line);
      }

      // Flush any pending throttled progress event so the DB reflects the
      // final stage before we finalize the run row.
      parser.flushProgress();

      const streamResult = parser.getResult();
      const { textParts, messages: conversationMessages, costUsd, inputTokens, outputTokens, sessionId, lineCount } = streamResult;
      let { streamError } = streamResult;

      // proc iteration completes when process exits; get the result
      const result = await proc;

      // Build a failed ModeResult with the current logFile and whatever
      // spend the stream reported, so failed attempts still count toward budget.
      const failure = (msg: string): ModeResult => ({
        ok: false,
        error: msg,
        logFile,
        isRateLimit: isRateLimitMessage(msg),
        costUsd,
        inputTokens,
        outputTokens,
      });

      // Detect spawn failures (e.g. ENOENT when claude CLI is not installed)
      if (result.failed && result.exitCode === undefined) {
        return failure(result.shortMessage || result.message || 'Failed to start claude process');
      }

      // Handle exit codes
      const exitCode = result.exitCode ?? 0;
      if (exitCode === 137 || exitCode === 143) {
        const killedBy = exitCode === 137 ? 'SIGKILL' : 'SIGTERM';
        return failure(`Claude timed out (${killedBy}, exit code ${exitCode})`);
      }
      if (exitCode !== 0) {
        const stderr = Array.isArray(result.stderr) ? result.stderr.join('\n') : (result.stderr ?? '');
        return failure(streamError || stderr || `Claude exited with code ${exitCode}`);
      }
      if (streamError) {
        // Add troubleshooting hint for path-not-found inside container
        if (!sandbox && /No such file or directory|ENOENT/.test(streamError)) {
          const wsDir = process.env.WORKSPACE_DIR;
          streamError += wsDir
            ? `\n\nHint: the path may not be inside the mounted workspace (${wsDir}). Check WORKSPACE_DIR in .env.`
            : '\n\nHint: set WORKSPACE_DIR in .env and restart containers so automations can access host files.';
        }
        return failure(streamError);
      }

      const rawStdout = Array.isArray(result.stdout) ? result.stdout.join('\n') : (result.stdout ?? '');
      const output = textParts.join('') || rawStdout;
      const rawStderr = Array.isArray(result.stderr) ? result.stderr.join('\n') : (result.stderr ?? '');
      logger.info({ name: automation.name, lineCount, textPartsLen: textParts.length, rawStdoutLen: rawStdout.length, rawStderrLen: rawStderr.length, outputLen: output.length, exitCode, stderrSample: rawStderr.slice(0, 300) }, 'Claude run completed');

      return {
        ok: true,
        output,
        costUsd,
        inputTokens,
        outputTokens,
        logFile,
        sessionId,
        messages: captureMessages ? conversationMessages : undefined,
      };
    } catch (err) {
      // Unexpected error (I/O failure, MCP resolve failure, etc.) — convert
      // to a failed ModeResult so the retry loop gets a uniform shape.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message,
        logFile,
        isRateLimit: isRateLimitMessage(message),
      };
    } finally {
      if (tmpFile) await rm(tmpFile, { force: true }).catch(() => {});
      if (resolvedMcpPath) await rm(resolvedMcpPath, { force: true }).catch(() => {});
    }
  }

  // ── CAILA Mode ──────────────────────────────────────────

  private async executeCailaMode(
    automation: Automation,
    env: Record<string, string | undefined>,
    signal?: AbortSignal,
  ): Promise<{ output: string; costUsd?: number; inputTokens?: number; outputTokens?: number }> {
    const apiKey = env.CAILA_API_KEY as string | undefined;
    const baseUrl = env.CAILA_BASE_URL as string | undefined;

    if (!apiKey) {
      throw new Error('CAILA_API_KEY is not configured');
    }
    if (!baseUrl) {
      throw new Error('CAILA_BASE_URL is not configured');
    }

    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const url = `${normalizedBase}/api/adapters/openai-direct/chat/completions`;

    if (automation.sandbox) {
      logger.warn({ name: automation.name }, 'sandbox flag has no effect in caila mode');
    }

    logger.info(
      { name: automation.name, model: automation.model },
      'Executing CAILA automation',
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), automation.timeout * 1000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: automation.model,
          messages: [{ role: 'user', content: automation.instructions }],
          max_tokens: 16384,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        const isRateLimit = res.status === 429 || /rate.?limit|too many requests/i.test(text);
        const prefix = isRateLimit ? 'rate_limit: ' : '';
        throw new Error(`${prefix}CAILA API error: ${res.status} ${text}`);
      }

      let data: Record<string, unknown>;
      try {
        data = await res.json();
      } catch {
        throw new Error(`CAILA API returned non-JSON response (status ${res.status})`);
      }

      const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
      const rawContent = choices?.[0]?.message?.content;
      if (rawContent == null) {
        logger.warn({ name: automation.name }, 'CAILA response missing choices[0].message.content');
      }
      const output = rawContent?.trim() || '';
      const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      const inputTokens = usage?.prompt_tokens;
      const outputTokens = usage?.completion_tokens;

      logger.info(
        { name: automation.name, inputTokens, outputTokens, outputLen: output.length },
        'CAILA run completed',
      );

      return {
        output,
        inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
        outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (signal?.aborted) throw new Error('Run stopped by user');
        throw new Error(`CAILA request timed out after ${automation.timeout}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // ── Shell Mode ───────────────────────────────────────────

  private async executeShellMode(
    automation: Automation,
    sandbox: boolean,
    env: Record<string, string | undefined>,
    signal?: AbortSignal,
  ): Promise<{ output: string; costUsd?: number; inputTokens?: number; outputTokens?: number }> {
    const lines = automation.instructions.split('\n');
    const outputs: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('on_failure:')) continue;
      if (signal?.aborted) throw new Error('Run stopped by user');

      // HTTP step — execute via native fetch, bypass shell/sandbox
      if (trimmed.startsWith('http: ')) {
        const httpConfig = JSON.parse(trimmed.slice(6));
        logger.debug({ name: automation.name, url: httpConfig.url, method: httpConfig.method ?? 'GET' }, 'Executing HTTP step');

        const controller = new AbortController();
        const timeoutMs = (httpConfig.timeout ?? 30) * 1000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
          const bodyStr = httpConfig.body != null
            ? (typeof httpConfig.body === 'string' ? httpConfig.body : JSON.stringify(httpConfig.body))
            : undefined;

          const headers: Record<string, string> = { ...httpConfig.headers };
          if (bodyStr && !headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
          }

          const response = await fetch(httpConfig.url, {
            method: httpConfig.method ?? 'GET',
            headers,
            body: bodyStr,
            signal: controller.signal,
          });

          const responseBody = await response.text();
          outputs.push(responseBody);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseBody.slice(0, 500)}`);
          }
        } catch (err) {
          if (signal?.aborted) throw new Error('Run stopped by user');
          throw err;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
        continue;
      }

      // Extract shell command (remove "$ " prefix if present)
      const cmd = trimmed.startsWith('$ ') ? trimmed.slice(2) : trimmed;

      logger.debug({ name: automation.name, cmd, sandbox }, 'Executing shell step');

      if (sandbox) {
        const dockerArgs = buildDockerArgs({
          image: SANDBOX_IMAGE,
          timeout: automation.timeout,
          cmd,
        });

        const proc = await execa('docker', dockerArgs, {
          timeout: (automation.timeout + 10) * 1000,
          env,
          reject: false,
          cancelSignal: signal,
        });

        if (proc.stdout) outputs.push(proc.stdout);
        if (signal?.aborted) throw new Error('Run stopped by user');

        if (proc.exitCode !== 0) {
          const errorMsg = proc.stderr || `Sandbox command failed with exit code ${proc.exitCode}`;
          throw new Error(`Step failed: ${cmd}\n${errorMsg}`);
        }
      } else {
        const proc = await execa('bash', ['-c', cmd], {
          timeout: automation.timeout * 1000,
          env,
          reject: false,
          cancelSignal: signal,
        });

        if (proc.stdout) outputs.push(proc.stdout);
        if (signal?.aborted) throw new Error('Run stopped by user');

        if (proc.exitCode !== 0) {
          const errorMsg = proc.stderr || `Command failed with exit code ${proc.exitCode}`;
          throw new Error(`Step failed: ${cmd}\n${errorMsg}`);
        }
      }
    }

    return { output: outputs.join('\n') };
  }
}

// ── Helpers ──────────────────────────────────────────────────

export interface DockerRunOpts {
  image: string;
  timeout: number;
  cmd: string;
  stdin?: boolean;
  mounts?: Array<{ src: string; dst: string; ro?: boolean }>;
  envVars?: Record<string, string>;
}

export function buildDockerArgs(opts: DockerRunOpts): string[] {
  const args: string[] = [
    'run',
    '--rm',
    ...(opts.stdin ? ['-i'] : []),
    // Default bridge network: outbound internet works, but host loopback
    // services (Postgres, the web API) are not reachable from the sandbox.
    '--network', process.env.SANDBOX_NETWORK || 'bridge',
    '--memory', '1g',
    '--cpus', '1',
    '--pids-limit', '256',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,size=256m',
    '--tmpfs', '/workspace:rw,nosuid,size=128m',
    '--tmpfs', '/home/sandbox/.claude:rw,nosuid,size=16m,uid=1001,gid=1001',
    '--security-opt', 'no-new-privileges',
    '--stop-timeout', String(opts.timeout),
  ];

  if (opts.mounts) {
    for (const m of opts.mounts) {
      const flag = m.ro ? 'ro' : 'rw';
      args.push('-v', `${m.src}:${m.dst}:${flag}`);
    }
  }

  if (opts.envVars) {
    for (const [k, v] of Object.entries(opts.envVars)) {
      args.push('-e', `${k}=${v}`);
    }
  }

  args.push(opts.image, opts.cmd);

  return args;
}

