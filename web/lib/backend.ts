import { join } from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execa } from 'execa';
import jsYaml from 'js-yaml';
import { z } from 'zod';
import { loadAutomations } from '@cronagent/loader';
import { Runner } from '@cronagent/runner';
import { History, DEFAULT_THROTTLE } from '@cronagent/history';
import type { ThrottleConfig } from '@cronagent/history';
import { Composer } from '@cronagent/composer';
import { Notifier } from '@cronagent/notifier';
import { CRON_ENABLED_PREFIX, nextCronRun } from '@cronagent/scheduler';
import { SkipList } from '@cronagent/skip-list';
import { UsageTracker } from '@cronagent/usage-tracker';
import type { Automation, ExecutionResult, ConversationContext, NotifyConfig } from '@cronagent/types';
import { NotifyConfigSchema } from '@cronagent/types';
import { randomUUID } from 'node:crypto';

// Re-export types for convenience
export type { Automation, ExecutionResult };
export type { RunRecord, ThrottleConfig, BudgetConfig, McpServerRecord, EnvVarRecord, UsageStat, AgentStat } from '@cronagent/history';
export type { SkipEntry, ConversationRecord, ConversationMessageRecord } from '@cronagent/types';

// Paths — match CLI defaults, but relative to web/ (one dir up)
const PROJECT_ROOT = join(process.cwd(), '..');
const AUTOMATIONS_DIR = process.env.AUTOMATIONS_DIR || join(PROJECT_ROOT, 'automations');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/cronagent';
const MCP_CONFIG = process.env.MCP_CONFIG || join(PROJECT_ROOT, 'mcp.json');

// Singleton cache on globalThis to survive Next.js HMR
const g = globalThis as typeof globalThis & {
  __runner?: Runner;
  __historyPromise?: Promise<History>;
  __automationsCache?: { automations: Automation[]; loadedAt: number };
  __notifier?: Notifier;
};

export function getHistory(): Promise<History> {
  if (!g.__historyPromise) {
    g.__historyPromise = History.create(DATABASE_URL);
  }
  return g.__historyPromise;
}

export async function getNotifier(): Promise<Notifier> {
  if (!g.__notifier) {
    // Merge DB env vars (set via web UI) with process.env so that
    // credentials like TELEGRAM_BOT_TOKEN are available to the notifier
    const history = await getHistory();
    const dbEnv = await history.getEnabledEnvVars();
    g.__notifier = new Notifier({
      webhookUrl: dbEnv.WEBHOOK_URL ?? process.env.WEBHOOK_URL,
      telegramBotToken: dbEnv.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN,
      telegramChatId: dbEnv.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID,
      mattermostWebhookUrl: dbEnv.MATTERMOST_WEBHOOK_URL ?? process.env.MATTERMOST_WEBHOOK_URL,
    });
    // Drain any orphan rows that were swept on history creation and notify
    // about them. Best-effort — failures are swallowed by the notifier.
    const orphans = history.takePendingOrphanNotifications();
    for (const row of orphans) {
      const finishedAt = row.finished_at ?? new Date();
      const startedAt = row.started_at ?? finishedAt;
      g.__notifier.notify({
        automationName: row.automation_name,
        success: false,
        output: '',
        error: row.error || 'process crash',
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        startedAt,
        finishedAt,
        mode: (row.mode as 'claude' | 'caila' | 'shell' | 'composed') ?? 'claude',
      }).catch(() => {});
    }
  }
  return g.__notifier;
}

/** Invalidate cached notifier and runner so they pick up new env vars. */
export function invalidateNotifierCache(): void {
  g.__notifier = undefined;
  g.__runner = undefined;
}

export async function getRunner(): Promise<Runner> {
  if (!g.__runner) {
    g.__runner = new Runner(MCP_CONFIG, true, await getNotifier());
  }
  return g.__runner;
}

const CACHE_TTL_MS = 30_000;

export async function getAutomations(): Promise<Automation[]> {
  const cache = g.__automationsCache;
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.automations;
  }
  const automations = await loadAutomations(AUTOMATIONS_DIR);
  g.__automationsCache = { automations, loadedAt: Date.now() };
  return automations;
}

export async function getComposer(automations: Automation[]): Promise<Composer> {
  return new Composer(await getRunner(), automations, await getNotifier());
}

// ── Automation CRUD ──────────────────────────────────────────

export function isComposedAutomation(instructions: string): boolean {
  try {
    const parsed = JSON.parse(instructions);
    return Array.isArray(parsed?.compose);
  } catch {
    return false;
  }
}

export interface AutomationInput {
  name: string;
  description: string;
  mode: 'claude' | 'caila' | 'shell' | 'composed';
  trigger: 'manual' | 'cron' | 'webhook';
  schedule?: string | null;
  timeout: number;
  model: string;
  mcp: string[];
  sandbox: boolean;
  conversation: boolean;
  instructions: string;
  composeSteps?: string;
  onComplete?: string;
  notify?: NotifyConfig;
  maxRetries?: number;
  retryDelayMs?: number;
  maxTurns?: number;
}

export const AutomationInputSchema = z.object({
  name: z.string().min(1, 'Name is required').trim()
    .refine((v) => /[a-z0-9]/i.test(v), 'Name must contain at least one letter or digit'),
  description: z.string().default(''),
  mode: z.enum(['claude', 'caila', 'shell', 'composed']),
  trigger: z.enum(['manual', 'cron', 'webhook']),
  schedule: z.string().nullable().optional(),
  timeout: z.number().int().min(1, 'Timeout must be at least 1 second').max(86400).default(300),
  model: z.string().default('sonnet'),
  mcp: z.array(z.string()).default([]),
  sandbox: z.boolean().default(false),
  conversation: z.boolean().default(false),
  instructions: z.string().trim().default(''),
  composeSteps: z.string().optional(),
  onComplete: z.string().optional(),
  notify: NotifyConfigSchema.optional(),
  maxRetries: z.number().int().min(0).max(10).default(0),
  retryDelayMs: z.number().int().min(0).default(1000),
  maxTurns: z.number().int().min(1).max(200).optional(),
}).refine(
  (data) => data.mode === 'composed' || data.instructions.length > 0,
  { message: 'Instructions are required', path: ['instructions'] },
).refine(
  (data) => data.mode !== 'composed' || (data.composeSteps ?? '').trim().length > 0,
  { message: 'At least one compose step is required', path: ['composeSteps'] },
);

export function parseAutomationInput(body: unknown):
  | { success: true; data: AutomationInput }
  | { success: false; error: string } {
  const result = AutomationInputSchema.safeParse(body);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { success: false, error: messages.join('; ') };
  }
  return { success: true, data: result.data as AutomationInput };
}

interface PreservedFrontmatter {
  preCollect?: string;
  systemPrompt?: string;
}

function automationToFileContent(
  input: AutomationInput,
  preserved: PreservedFrontmatter = {},
): { content: string; ext: string } {
  if (input.mode === 'claude') {
    const frontmatter: Record<string, unknown> = {
      name: input.name,
      description: input.description,
      trigger: input.trigger,
      timeout: input.timeout,
      model: input.model,
      sandbox: input.sandbox,
    };
    if (input.conversation) {
      frontmatter.conversation = true;
    }
    if (input.trigger === 'cron' && input.schedule) {
      frontmatter.schedule = input.schedule;
    }
    if (input.mcp.length > 0) {
      frontmatter.mcp = input.mcp;
    }
    if (input.notify !== undefined) {
      frontmatter.notify = input.notify;
    }
    if (input.maxRetries && input.maxRetries > 0) {
      frontmatter.maxRetries = input.maxRetries;
    }
    if (input.retryDelayMs !== undefined && input.retryDelayMs !== 1000) {
      frontmatter.retryDelayMs = input.retryDelayMs;
    }
    if (input.maxTurns) {
      frontmatter.maxTurns = input.maxTurns;
    }
    // Preserve fields the editor UI doesn't expose (preCollect, systemPrompt)
    // so round-tripping a file through PUT doesn't strip them.
    if (preserved.preCollect) {
      frontmatter.preCollect = preserved.preCollect;
    }
    if (preserved.systemPrompt) {
      frontmatter.systemPrompt = preserved.systemPrompt;
    }
    const yaml = jsYaml.dump(frontmatter, { lineWidth: -1, quotingType: '"', forceQuotes: false });
    return { content: `---\n${yaml}---\n\n${input.instructions}\n`, ext: '.md' };
  }

  if (input.mode === 'caila') {
    const frontmatter: Record<string, unknown> = {
      name: input.name,
      description: input.description,
      trigger: input.trigger,
      timeout: input.timeout,
      model: input.model,
      mode: 'caila',
    };
    if (input.trigger === 'cron' && input.schedule) {
      frontmatter.schedule = input.schedule;
    }
    if (input.notify !== undefined) {
      frontmatter.notify = input.notify;
    }
    if (input.maxRetries && input.maxRetries > 0) {
      frontmatter.maxRetries = input.maxRetries;
    }
    if (input.retryDelayMs !== undefined && input.retryDelayMs !== 1000) {
      frontmatter.retryDelayMs = input.retryDelayMs;
    }
    const yaml = jsYaml.dump(frontmatter, { lineWidth: -1, quotingType: '"', forceQuotes: false });
    return { content: `---\n${yaml}---\n\n${input.instructions}\n`, ext: '.md' };
  }

  if (input.mode === 'composed') {
    const compose = (input.composeSteps ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const yamlObj: Record<string, unknown> = {
      name: input.name,
      description: input.description,
      trigger: input.trigger,
      compose,
    };
    if (input.trigger === 'cron' && input.schedule) {
      yamlObj.schedule = input.schedule;
    }
    if (input.notify !== undefined) {
      yamlObj.notify = input.notify;
    }
    if (input.maxRetries && input.maxRetries > 0) {
      yamlObj.maxRetries = input.maxRetries;
    }
    if (input.retryDelayMs !== undefined && input.retryDelayMs !== 1000) {
      yamlObj.retryDelayMs = input.retryDelayMs;
    }

    // Parse on_complete key=value lines
    const onCompleteLines = (input.onComplete ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (onCompleteLines.length > 0) {
      const onComplete: Record<string, string> = {};
      for (const line of onCompleteLines) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          onComplete[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
      if (Object.keys(onComplete).length > 0) {
        yamlObj.on_complete = onComplete;
      }
    }

    const yaml = jsYaml.dump(yamlObj, { lineWidth: -1, quotingType: '"', forceQuotes: false });
    return { content: yaml, ext: '.yaml' };
  }

  // Shell mode
  const lines = input.instructions.split('\n').filter((l) => l.trim());
  const steps = lines.map((l) => {
    const trimmed = l.trim();
    if (trimmed.startsWith('http: ')) {
      try {
        return { http: JSON.parse(trimmed.slice(6)) };
      } catch {
        return { shell: trimmed };
      }
    }
    return { shell: trimmed.replace(/^\$\s*/, '') };
  });

  const yamlObj: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    trigger: input.trigger,
    timeout: input.timeout,
  };
  if (input.trigger === 'cron' && input.schedule) {
    yamlObj.schedule = input.schedule;
  }
  if (input.sandbox) {
    yamlObj.sandbox = true;
  }
  if (input.notify !== undefined) {
    yamlObj.notify = input.notify;
  }
  if (input.maxRetries && input.maxRetries > 0) {
    yamlObj.maxRetries = input.maxRetries;
  }
  if (input.retryDelayMs !== undefined && input.retryDelayMs !== 1000) {
    yamlObj.retryDelayMs = input.retryDelayMs;
  }
  yamlObj.steps = steps;

  const yaml = jsYaml.dump(yamlObj, { lineWidth: -1, quotingType: '"', forceQuotes: false });
  return { content: yaml, ext: '.yaml' };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function saveAutomation(
  input: AutomationInput,
  existingFilePath?: string,
): Promise<{ filePath: string }> {
  // Read preCollect/systemPrompt from the existing file so editor round-trips
  // don't drop them (the form UI doesn't expose these fields).
  const preserved: PreservedFrontmatter = {};
  if (existingFilePath) {
    try {
      const existingRaw = await readFile(existingFilePath, 'utf-8');
      const fmMatch = existingRaw.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = jsYaml.load(fmMatch[1]) as Record<string, unknown> | null;
        if (fm && typeof fm.preCollect === 'string') {
          preserved.preCollect = fm.preCollect;
        }
        if (fm && typeof fm.systemPrompt === 'string') {
          preserved.systemPrompt = fm.systemPrompt;
        }
      }
    } catch {
      // Existing file unreadable — fall through with no preserved fields.
    }
  }

  const { content, ext } = automationToFileContent(input, preserved);

  let filePath: string;
  if (existingFilePath) {
    // Delete old file if extension changed
    const oldExt = existingFilePath.endsWith('.md') ? '.md' : '.yaml';
    if (oldExt !== ext) {
      await unlink(existingFilePath).catch(() => {});
    }
    filePath = existingFilePath.replace(/\.(md|ya?ml)$/, ext);
  } else {
    filePath = join(AUTOMATIONS_DIR, `${slugify(input.name)}${ext}`);
  }

  await writeFile(filePath, content, 'utf-8');
  invalidateCache();
  return { filePath };
}

export async function deleteAutomation(name: string): Promise<boolean> {
  const automations = await getAutomations();
  const automation = automations.find((a) => a.name === name);
  if (!automation) return false;
  await unlink(automation.filePath);
  invalidateCache();
  return true;
}

function invalidateCache(): void {
  g.__automationsCache = undefined;
}

// ── Throttle ──────────────────────────────────────────────────

const THROTTLE_KEY = 'throttle';

export async function getThrottleConfig(): Promise<ThrottleConfig> {
  const history = await getHistory();
  const config = await history.getSetting<ThrottleConfig>(THROTTLE_KEY);
  return config ?? DEFAULT_THROTTLE;
}

export async function setThrottleConfig(config: ThrottleConfig): Promise<void> {
  const history = await getHistory();
  await history.setSetting(THROTTLE_KEY, config);
}

// ── Budget ────────────────────────────────────────────────────

import { DEFAULT_BUDGET, BudgetConfigSchema } from '@cronagent/history';
import type { BudgetConfig } from '@cronagent/history';

const BUDGET_KEY = 'budget';

export async function getBudgetConfig(): Promise<BudgetConfig> {
  const history = await getHistory();
  const raw = await history.getSetting<BudgetConfig>(BUDGET_KEY);
  if (!raw) return DEFAULT_BUDGET;
  const parsed = BudgetConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_BUDGET;
}

export async function setBudgetConfig(config: BudgetConfig): Promise<void> {
  const history = await getHistory();
  await history.setSetting(BUDGET_KEY, config);
}

export async function getUsageTracker(): Promise<UsageTracker> {
  const history = await getHistory();
  return new UsageTracker(history);
}

// ── Cron Scheduler ───────────────────────────────────────────
//
// The daemon is the sole cron executor. The web only flips the per-automation
// `cron_enabled::<name>` flag; the daemon reads it on every tick.

export async function getCronEnabled(name: string): Promise<boolean> {
  const history = await getHistory();
  const val = await history.getSetting<boolean>(`${CRON_ENABLED_PREFIX}${name}`);
  return val === true;
}

export async function setCronEnabled(name: string, enabled: boolean): Promise<void> {
  const history = await getHistory();
  await history.setSetting(`${CRON_ENABLED_PREFIX}${name}`, enabled);
}

export async function getAllCronEnabled(): Promise<Record<string, boolean>> {
  const history = await getHistory();
  const automations = await getAutomations();
  const result: Record<string, boolean> = {};
  for (const a of automations) {
    if (a.trigger === 'cron' && a.schedule) {
      result[a.name] = await getCronEnabled(a.name);
    }
  }
  return result;
}

export interface SchedulerJobStatus {
  name: string;
  schedule: string | undefined;
  nextRun: string | null;
  running: boolean;
  enabled: boolean;
}

export async function getSchedulerStatus(): Promise<SchedulerJobStatus[]> {
  const history = await getHistory();
  const automations = await getAutomations();
  const cronAutomations = automations.filter((a) => a.trigger === 'cron' && a.schedule);

  // Batch-read enabled flags and running state (from the DB — runs may belong to the daemon)
  const [enabledFlags, runningCounts] = await Promise.all([
    Promise.all(cronAutomations.map((a) => getCronEnabled(a.name))),
    Promise.all(cronAutomations.map((a) => history.getRunningCountDb(a.name))),
  ]);

  return cronAutomations.map((a, i) => ({
    name: a.name,
    schedule: a.schedule ?? undefined,
    nextRun: enabledFlags[i] && a.schedule ? nextCronRun(a.schedule) : null,
    running: runningCounts[i] > 0,
    enabled: enabledFlags[i],
  }));
}

// ── Track in-flight runs ─────────────────────────────────────

const runningAutomations = new Map<string, { startedAt: Date; abort: AbortController }>();
const lastRunFinished = new Map<string, number>();

export function isRunning(name: string): { running: boolean; startedAt: Date | null } {
  const info = runningAutomations.get(name);
  return { running: !!info, startedAt: info?.startedAt ?? null };
}

export function getRunningCount(): number {
  return runningAutomations.size;
}

/** Stop an in-flight run by aborting its controller. Returns true if the run was found. */
export function stopRun(name: string): boolean {
  const info = runningAutomations.get(name);
  if (!info) return false;
  info.abort.abort();
  return true;
}

export async function triggerRun(name: string, opts?: { newConversation?: boolean; webhookEnv?: Record<string, string> }): Promise<{ started: boolean; runId?: number; error?: string; reason?: 'not_found' | 'already_running' | 'throttled' }> {
  if (runningAutomations.has(name)) {
    return { started: false, error: 'Already running', reason: 'already_running' };
  }

  // Reserve the slot synchronously before any await to prevent race conditions
  const abortController = new AbortController();
  runningAutomations.set(name, { startedAt: new Date(), abort: abortController });

  const automations = await getAutomations();
  const automation = automations.find((a) => a.name === name);
  if (!automation) {
    runningAutomations.delete(name);
    return { started: false, error: 'Automation not found', reason: 'not_found' };
  }

  // Throttle checks
  const throttle = await getThrottleConfig();
  if (throttle.enabled) {
    // Note: runningAutomations already includes this run, so use > instead of >=
    if (runningAutomations.size > throttle.maxConcurrent) {
      runningAutomations.delete(name);
      return { started: false, error: `Throttled: max ${throttle.maxConcurrent} concurrent runs reached`, reason: 'throttled' };
    }

    if (throttle.cooldownSeconds > 0) {
      const lastFinish = lastRunFinished.get(name);
      if (lastFinish && Date.now() - lastFinish < throttle.cooldownSeconds * 1000) {
        const waitSec = Math.ceil((throttle.cooldownSeconds * 1000 - (Date.now() - lastFinish)) / 1000);
        runningAutomations.delete(name);
        return { started: false, error: `Throttled: cooldown ${waitSec}s remaining for "${name}"`, reason: 'throttled' };
      }
    }

    if (throttle.maxPerHour > 0) {
      const history = await getHistory();
      const runsLastHour = await history.getRunsInWindow(60 * 60 * 1000, name);
      if (runsLastHour >= throttle.maxPerHour) {
        runningAutomations.delete(name);
        return { started: false, error: `Throttled: max ${throttle.maxPerHour} runs/hour reached`, reason: 'throttled' };
      }
    }
  }

  // Budget gate
  const tracker = await getUsageTracker();
  const budgetCheck = await tracker.checkBudget();
  if (!budgetCheck.allowed) {
    runningAutomations.delete(name);
    return { started: false, error: `Budget: ${budgetCheck.reason}`, reason: 'throttled' };
  }

  // Resolve conversation context and pre-insert a `running` row so callers
  // can deep-link to /runs/{id} before Claude has produced any output.
  const runner = await getRunner();
  const history = await getHistory();
  let runId: number;
  let conversationCtx: ConversationContext | undefined;
  let conversationId: string | undefined;
  let extraEnv: Record<string, string>;
  const startedAt = new Date();
  try {
    const dbEnv = await history.getEnabledEnvVars();
    extraEnv = opts?.webhookEnv ? { ...dbEnv, ...opts.webhookEnv } : dbEnv;

    if (automation.conversation && automation.mode === 'claude' && !automation.sandbox) {
      if (opts?.newConversation) {
        const existing = await history.getActiveConversation(name);
        if (existing) await history.closeConversation(existing.id);
      }
      const active = opts?.newConversation ? undefined : await history.getActiveConversation(name);
      if (active?.claude_session_id) {
        conversationId = active.id;
        conversationCtx = { conversationId: active.id, sessionId: active.claude_session_id };
      } else if (active) {
        conversationId = active.id;
      } else {
        conversationId = randomUUID();
        await history.createConversation(conversationId, name);
      }
    }

    const maybeRunId = await history.insertRunning({
      automationName: name,
      mode: automation.mode,
      startedAt,
      conversationId: conversationId ?? null,
    });
    if (maybeRunId === null) {
      runningAutomations.delete(name);
      return { started: false, error: 'Already running (another process)', reason: 'already_running' };
    }
    runId = maybeRunId;
  } catch (err) {
    // If any pre-flight step fails, release the in-memory slot immediately.
    runningAutomations.delete(name);
    throw err;
  }

  // Throttled progress writer — coalesces rapid stage changes to ≤1/sec.
  let lastProgressDbWrite = 0;
  const onProgress = (stage: string, meta: { turn: number }) => {
    const now = Date.now();
    if (now - lastProgressDbWrite < 750) return; // rough throttle to avoid DB thrash
    lastProgressDbWrite = now;
    history.updateProgress(runId, stage, meta.turn).catch((err) => {
      console.error(`[triggerRun] updateProgress failed for run ${runId}:`, err);
    });
  };

  // Live log streaming: persist the runner's log file path as soon as it is
  // constructed (before the first stream line is written). Lets the run
  // detail page tail the file via /api/runs/{id}/log while the run is still
  // in progress.
  const onLogFile = (path: string) => {
    history.updateLogFile(runId, path).catch((err) => {
      console.error(`[triggerRun] updateLogFile failed for run ${runId}:`, err);
    });
  };

  // Fire-and-forget execution.
  (async () => {
    let result: ExecutionResult;
    if (isComposedAutomation(automation.instructions)) {
      result = await (await getComposer(automations)).execute(automation, extraEnv, abortController.signal);
    } else {
      result = await runner.execute(automation, extraEnv, conversationCtx, onProgress, abortController.signal, onLogFile);
    }

    if (conversationId) {
      result.conversationId = conversationId;
    }

    await history.finalizeRun(runId, result);

    // Update conversation state (session_id/stats always, messages only when present)
    if (conversationId && result.success) {
      if (result.sessionId) {
        await history.updateConversationSession(conversationId, result.sessionId);
      }
      await history.updateConversationStats(conversationId, result.costUsd ?? 0);
      if (result.messages?.length) {
        const startSeq = await history.getMaxMessageSeq(conversationId) + 1;
        await history.insertConversationMessages(conversationId, runId, result.messages, startSeq);
      }
    }

    // Update skip-list state: clear on success, record on failure
    const sl = await getSkipList();
    if (result.success) {
      await sl.recordSuccess(name);
    } else {
      await sl.recordFailure(name);
    }
  })().catch(async (err) => {
    console.error(`[triggerRun] execution failed for "${name}":`, err);
    // Ensure the running row is marked failed even if the IIFE threw before finalizeRun.
    try {
      await history.finalizeRun(runId, {
        automationName: name,
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt.getTime(),
        startedAt,
        finishedAt: new Date(),
        mode: automation.mode,
      });
    } catch (finalizeErr) {
      console.error(`[triggerRun] finalizeRun fallback failed for run ${runId}:`, finalizeErr);
    }
  }).finally(() => {
    runningAutomations.delete(name);
    lastRunFinished.set(name, Date.now());
  });

  return { started: true, runId };
}

// ── Conversation Messages ─────────────────────────────────

const sendingMessages = new Map<string, { startedAt: Date }>();

export function isMessageSending(conversationId: string): { sending: boolean; startedAt: Date | null } {
  const info = sendingMessages.get(conversationId);
  return { sending: !!info, startedAt: info?.startedAt ?? null };
}

export async function sendConversationMessage(
  conversationId: string,
  message: string,
): Promise<{ started: boolean; error?: string }> {
  if (sendingMessages.has(conversationId)) {
    return { started: false, error: 'Already sending a message to this conversation' };
  }

  const history = await getHistory();
  const conversation = await history.getConversation(conversationId);
  if (!conversation) {
    return { started: false, error: 'Conversation not found' };
  }
  if (conversation.closed) {
    return { started: false, error: 'Conversation is closed' };
  }
  if (!conversation.claude_session_id) {
    return { started: false, error: 'Conversation has no active session' };
  }

  const automations = await getAutomations();
  const automation = automations.find((a) => a.name === conversation.automation_name);
  if (!automation) {
    return { started: false, error: `Automation "${conversation.automation_name}" not found` };
  }

  sendingMessages.set(conversationId, { startedAt: new Date() });

  // Fire-and-forget
  (async () => {
    const runner = await getRunner();
    const extraEnv = await history.getEnabledEnvVars();

    // Create a temporary automation with user's message as instructions
    const tempAutomation: Automation = {
      ...automation,
      instructions: message,
      conversation: true,
      maxRetries: 0,
    };

    const conversationCtx: ConversationContext = {
      conversationId,
      sessionId: conversation.claude_session_id!,
    };

    const result = await runner.execute(tempAutomation, extraEnv, conversationCtx);

    // Record in run_history
    result.conversationId = conversationId;
    const runId = await history.insert(result);

    // Update conversation state
    if (result.success) {
      if (result.sessionId) {
        await history.updateConversationSession(conversationId, result.sessionId);
      }
      await history.updateConversationStats(conversationId, result.costUsd ?? 0);
      if (result.messages?.length) {
        const startSeq = await history.getMaxMessageSeq(conversationId) + 1;
        await history.insertConversationMessages(conversationId, runId, result.messages, startSeq);
      }
    }
  })().catch((err) => {
    console.error(`[sendConversationMessage] failed for "${conversationId}":`, err);
  }).finally(() => {
    sendingMessages.delete(conversationId);
  });

  return { started: true };
}

// ── Skip List ─────────────────────────────────────────────

export async function getSkipList(): Promise<SkipList> {
  const history = await getHistory();
  return new SkipList(history);
}

export async function getSkipListEntries(): Promise<import('@cronagent/types').SkipEntry[]> {
  const sl = await getSkipList();
  return sl.list();
}

export async function getSkippedNames(): Promise<Set<string>> {
  const entries = await getSkipListEntries();
  return new Set(entries.map((e) => e.automationName));
}

export async function clearSkipEntry(name: string): Promise<void> {
  const sl = await getSkipList();
  await sl.remove(name);
}

export async function clearAllSkipEntries(): Promise<void> {
  const sl = await getSkipList();
  await sl.clear();
}

// ── Env Var Management ────────────────────────────────────

import type { EnvVarRecord } from '@cronagent/history';

export async function getEnvVars(): Promise<EnvVarRecord[]> {
  const history = await getHistory();
  // Ensure MCP servers + env vars are seeded on first access
  await initMcpServers(history);
  await initEnvVarsFromProcess(history);
  return history.getEnvVars();
}

export async function getEnvVar(name: string): Promise<EnvVarRecord | undefined> {
  const history = await getHistory();
  return history.getEnvVar(name);
}

export async function createEnvVar(envVar: { name: string; value: string; description: string; enabled: boolean }): Promise<void> {
  const history = await getHistory();
  await history.insertEnvVar(envVar);
  invalidateNotifierCache();
}

export async function updateEnvVar(name: string, envVar: { name: string; value: string; description: string; enabled: boolean }): Promise<boolean> {
  const history = await getHistory();
  const existing = await history.getEnvVar(name);
  if (!existing) return false;
  await history.upsertEnvVar(envVar);
  invalidateNotifierCache();
  return true;
}

export async function deleteEnvVar(name: string): Promise<boolean> {
  const history = await getHistory();
  const result = await history.deleteEnvVar(name);
  invalidateNotifierCache();
  return result;
}

export async function setEnvVarEnabled(name: string, enabled: boolean): Promise<boolean> {
  const history = await getHistory();
  const result = await history.setEnvVarEnabled(name, enabled);
  invalidateNotifierCache();
  return result;
}

export async function getEnabledEnvVars(): Promise<Record<string, string>> {
  const history = await getHistory();
  return history.getEnabledEnvVars();
}

// ── MCP Server Management ─────────────────────────────────

import type { McpServerRecord } from '@cronagent/history';

export async function getMcpServers(): Promise<McpServerRecord[]> {
  const history = await getHistory();
  await initMcpServers(history);
  return history.getMcpServers();
}

export async function getMcpServer(name: string): Promise<McpServerRecord | undefined> {
  const history = await getHistory();
  await initMcpServers(history);
  return history.getMcpServer(name);
}

export async function createMcpServer(server: { name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }): Promise<void> {
  const history = await getHistory();
  await history.upsertMcpServer(server);
  await syncMcpJson(history);
}

export async function updateMcpServer(name: string, server: { name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }): Promise<boolean> {
  const history = await getHistory();
  const existing = await history.getMcpServer(name);
  if (!existing) return false;

  // If name changed, delete old entry first
  if (name !== server.name) {
    await history.deleteMcpServer(name);
  }
  await history.upsertMcpServer(server);
  await syncMcpJson(history);
  return true;
}

export async function deleteMcpServer(name: string): Promise<boolean> {
  const history = await getHistory();
  const deleted = await history.deleteMcpServer(name);
  if (deleted) {
    await syncMcpJson(history);
  }
  return deleted;
}

export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<boolean> {
  const history = await getHistory();
  const updated = await history.setMcpServerEnabled(name, enabled);
  if (updated) {
    await syncMcpJson(history);
  }
  return updated;
}

async function syncMcpJson(history: History): Promise<void> {
  const servers = await history.getMcpServers();
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const s of servers) {
    if (s.enabled) {
      mcpServers[s.name] = { command: s.command, args: s.args, env: s.env };
    }
  }
  try {
    await writeFile(MCP_CONFIG, JSON.stringify({ mcpServers }, null, 2) + '\n', 'utf-8');
  } catch {
    // mcp.json may be mounted read-only in Docker — ignore write errors
  }
}

const mcpInitDone = { value: false };

async function initMcpServers(history: History): Promise<void> {
  if (mcpInitDone.value) return;
  mcpInitDone.value = true;

  const count = await history.getMcpServerCount();
  if (count > 0) return;

  // Import from existing mcp.json
  try {
    const raw = await readFile(MCP_CONFIG, 'utf-8');
    const parsed = JSON.parse(raw);
    const servers = parsed.mcpServers || parsed.mcpservers || {};
    for (const [name, config] of Object.entries(servers)) {
      const c = config as { command?: string; args?: string[]; env?: Record<string, string> };
      await history.upsertMcpServer({
        name,
        command: c.command || '',
        args: c.args || [],
        env: c.env || {},
        enabled: true,
      });
    }

    // Seed env vars referenced by MCP server configs from process.env
    await initEnvVarsFromMcpConfig(history, servers);
  } catch {
    // mcp.json missing or invalid — start fresh
  }
}

const envInitDone = { value: false };

async function initEnvVarsFromMcpConfig(history: History, mcpServers: Record<string, unknown>): Promise<void> {
  // Collect all ${VAR} references from MCP server env configs
  const referencedVars = new Set<string>();
  for (const config of Object.values(mcpServers)) {
    const c = config as { env?: Record<string, string> };
    if (c.env) {
      for (const val of Object.values(c.env)) {
        const matches = val.matchAll(/\$\{(\w+)\}/g);
        for (const m of matches) {
          referencedVars.add(m[1]);
        }
      }
    }
  }

  // Seed each referenced var from process.env if it has a value
  for (const varName of referencedVars) {
    const value = process.env[varName];
    if (value) {
      await history.upsertEnvVar({
        name: varName,
        value,
        description: `Auto-imported from environment`,
        enabled: true,
      });
    }
  }
}

/**
 * Seed env vars from process.env on every startup.
 * Reads MCP server configs from DB, extracts ${VAR} references,
 * and upserts any that have values in process.env.
 */
async function initEnvVarsFromProcess(history: History): Promise<void> {
  if (envInitDone.value) return;
  envInitDone.value = true;

  const servers = await history.getMcpServers();
  const mcpConfigs: Record<string, { env?: Record<string, string> }> = {};
  for (const s of servers) {
    mcpConfigs[s.name] = { env: s.env };
  }
  await initEnvVarsFromMcpConfig(history, mcpConfigs);
}

// ── Auto-Generate Automations ────────────────────────────

export interface GeneratedAutomation {
  name: string;
  description: string;
  mode: 'claude' | 'shell' | 'composed';
  trigger: 'manual' | 'cron' | 'webhook';
  schedule?: string;
  mcp: string[];
  instructions: string;
  rawContent: string;
}

export async function generateAutomationContent(description: string): Promise<GeneratedAutomation> {
  const automations = await getAutomations();
  const existingNames = automations.map((a) => `- ${a.name}: ${a.description}`).join('\n');

  const history = await getHistory();
  const mcpServers = await history.getMcpServers();
  const mcpNames = mcpServers.filter((s) => s.enabled).map((s) => s.name);

  const prompt = `You are an automation generator for the cronagent platform. Given a user's description, produce a complete automation file.

## Frontmatter Schema (YAML between --- delimiters)

Required fields:
- name: kebab-case identifier (e.g., check-mrs, daily-report)
- description: one-line human-readable description

Optional fields:
- trigger: manual (default) | cron | webhook
- schedule: cron expression (only if trigger is cron, e.g., "0 9 * * 1-5")
- timeout: seconds (default 300)
- mcp: array of MCP server names (only for claude mode)
- model: sonnet (default) | opus | haiku
- sandbox: true/false (default false)
- notify: true/false (default true for cron)
- maxRetries: 0-10 (default 0)
- conversation: true/false (default false)

## Available MCP servers
${mcpNames.length > 0 ? mcpNames.map((n) => `- ${n}`).join('\n') : '(none configured)'}

## Existing automations (avoid duplicate names)
${existingNames || '(none)'}

## Example automation file

\`\`\`
---
name: check-mrs
description: Check status of all my open MRs across projects
trigger: manual
timeout: 120
mcp: [gitlab]
model: sonnet
---

# Check Open Merge Requests

1. Use \`list_my_merge_requests\` with state "opened" to get all my open MRs
2. For each MR, check CI pipeline status, approval status, age
3. Flag MRs that need attention (stale, failing CI, conflicts)
4. Output a summary grouped by urgency
\`\`\`

## Rules
- Output ONLY the raw file content — no explanations, no code fences, no commentary
- Start with --- for the YAML frontmatter block
- For AI-driven tasks, use claude mode (.md format with frontmatter + markdown instructions)
- For deterministic scripts, describe shell commands in the instructions
- Choose appropriate MCP servers from the available list
- If the task is recurring, set trigger to cron with an appropriate schedule
- Write clear, numbered step-by-step instructions
- Keep instructions concise but complete

## User's description
${description}`;

  const proc = await execa('claude', [
    '--print',
    '--output-format', 'stream-json',
    '--model', 'haiku',
    '--max-turns', '1',
  ], {
    input: prompt,
    timeout: 30_000,
    reject: false,
    env: process.env,
  });

  // Parse NDJSON stream to extract text
  const textParts: string[] = [];
  for (const line of (proc.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && Array.isArray(event.content)) {
        for (const block of event.content) {
          if (block.type === 'text' && block.text) textParts.push(block.text);
        }
      } else if (event.type === 'result' && event.result) {
        textParts.length = 0;
        textParts.push(event.result);
      }
    } catch {
      // skip malformed lines
    }
  }

  const rawContent = textParts.join('').trim();
  if (!rawContent || !rawContent.startsWith('---')) {
    throw new Error('Generation failed: invalid output from Claude');
  }

  // Parse the generated content
  const matter = await import('gray-matter');
  const parsed = matter.default(rawContent);
  const frontmatter = parsed.data as Record<string, unknown>;
  const instructions = parsed.content.trim();

  const name = String(frontmatter.name ?? 'generated-automation');
  const desc = String(frontmatter.description ?? description);
  const trigger = (['manual', 'cron', 'webhook'].includes(String(frontmatter.trigger)) ? String(frontmatter.trigger) : 'manual') as 'manual' | 'cron' | 'webhook';
  const mcp = Array.isArray(frontmatter.mcp) ? frontmatter.mcp.map(String) : [];
  const schedule = typeof frontmatter.schedule === 'string' ? frontmatter.schedule : undefined;

  return {
    name,
    description: desc,
    mode: 'claude',
    trigger,
    schedule,
    mcp,
    instructions,
    rawContent,
  };
}
