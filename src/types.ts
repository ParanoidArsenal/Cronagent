import { z } from 'zod';

// ── Notify Config ──────────────────────────────────────────

export const NotifyConditionSchema = z.union([
  z.boolean(),
  z.enum(['on_failure', 'on_success']),
]);

export type NotifyCondition = z.infer<typeof NotifyConditionSchema>;

export const NotifyChannelsSchema = z.object({
  webhook: NotifyConditionSchema.optional(),
  telegram: NotifyConditionSchema.optional(),
  mattermost: NotifyConditionSchema.optional(),
});

export type NotifyChannels = z.infer<typeof NotifyChannelsSchema>;

export const NotifyConfigSchema = z.union([
  z.boolean(),
  NotifyChannelsSchema,
]);

export type NotifyConfig = z.infer<typeof NotifyConfigSchema>;

// ── Automation Definition ────────────────────────────────────

export const TriggerSchema = z.enum(['manual', 'cron', 'webhook']);

export const AutomationFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  trigger: TriggerSchema.default('manual'),
  schedule: z.string().nullable().optional(),
  timeout: z.number().int().min(1).default(300),
  mcp: z.array(z.string()).default([]),
  model: z.string().default('sonnet'),
  mode: z.enum(['claude', 'caila']).default('claude'),
  sandbox: z.boolean().default(false),
  notify: NotifyConfigSchema.optional(),
  maxRetries: z.number().int().min(0).max(10).default(0),
  retryDelayMs: z.number().int().min(0).default(1000),
  conversation: z.boolean().default(false),
  maxTurns: z.number().int().min(1).optional(),
  preCollect: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export type AutomationFrontmatter = z.infer<typeof AutomationFrontmatterSchema>;

export interface Automation {
  name: string;
  description: string;
  trigger: 'manual' | 'cron' | 'webhook';
  schedule: string | null;
  timeout: number;
  mcp: string[];
  model: string;
  /** Full instructions (markdown body after frontmatter). */
  instructions: string;
  /** Original file path. */
  filePath: string;
  /** 'claude' or 'caila' for .md files, 'shell' for .yaml files. */
  mode: 'claude' | 'caila' | 'shell';
  /** Run inside a Docker sandbox container. */
  sandbox: boolean;
  /** Opt-in/out of notifications (undefined = use global default). */
  notify?: NotifyConfig;
  /** Max retry attempts on failure (0 = no retries). */
  maxRetries: number;
  /** Initial delay in ms between retries (doubles each attempt). */
  retryDelayMs: number;
  /** Enable conversation continuity across runs (claude mode only). */
  conversation: boolean;
  /** Max agentic turns for Claude mode (undefined = auto from timeout). */
  maxTurns?: number;
  /** Shell command to run before Claude; stdout is appended to the prompt. */
  preCollect?: string;
  /** Extra text appended to Claude's system prompt (e.g. tool hints). */
  systemPrompt?: string;
}

// ── Shell Automation (YAML) ────────────────────────────────

export const HttpStepSchema = z.object({
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.union([z.string(), z.record(z.unknown())]).optional(),
  timeout: z.number().int().min(1).default(30),
});

export type HttpStep = z.infer<typeof HttpStepSchema>;

export const ShellStepSchema = z.union([
  z.object({ shell: z.string() }),
  z.object({ http: HttpStepSchema }),
  z.object({ on_failure: z.record(z.string(), z.string()) }),
]);

export const ShellAutomationSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  trigger: TriggerSchema.default('manual'),
  schedule: z.string().nullable().optional(),
  timeout: z.number().int().min(1).default(300),
  steps: z.array(ShellStepSchema),
  on_failure: z.record(z.string(), z.string()).optional(),
  sandbox: z.boolean().default(false),
  notify: NotifyConfigSchema.optional(),
  maxRetries: z.number().int().min(0).max(10).default(0),
  retryDelayMs: z.number().int().min(0).default(1000),
});

export type ShellAutomation = z.infer<typeof ShellAutomationSchema>;

// ── Composed Automation ────────────────────────────────────

export const ComposedAutomationSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  trigger: TriggerSchema.default('manual'),
  schedule: z.string().nullable().optional(),
  compose: z.array(z.string().min(1)).min(1),
  on_complete: z.record(z.string(), z.string()).optional(),
  notify: NotifyConfigSchema.optional(),
  maxRetries: z.number().int().min(0).max(10).default(0),
  retryDelayMs: z.number().int().min(0).default(1000),
});

export type ComposedAutomation = z.infer<typeof ComposedAutomationSchema>;

// ── Execution Result ────────────────────────────────────────

export interface ExecutionResult {
  automationName: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  mode: 'claude' | 'caila' | 'shell' | 'composed';
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  logFile?: string;
  attemptNumber?: number;
  totalAttempts?: number;
  conversationId?: string;
  sessionId?: string;
  messages?: ConversationMessage[];
}

// ── Conversation ────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  contentType: 'text' | 'tool_use' | 'tool_result';
  toolName?: string;
}

export interface ConversationContext {
  conversationId: string;
  sessionId: string;
}

// ── Live progress reporting ─────────────────────────────────

export type RunStatus = 'running' | 'success' | 'failed';

/**
 * Invoked by Runner during Claude stream processing to report progress.
 * `stage` is a short label like `thinking` or `tool_use:Bash`.
 * The runner throttles invocations; callers need not throttle further.
 */
export type ProgressCallback = (stage: string, meta: { turn: number }) => void;

/**
 * Invoked by Runner once per attempt, immediately after the per-run log file
 * path is constructed and before any stream-json line is appended. Lets the
 * caller persist the path to the DB so a polling client can tail the file
 * while the run is still in progress (live log streaming).
 */
export type LogFileCallback = (path: string) => void;

export interface ConversationRecord {
  id: string;
  automation_name: string;
  claude_session_id: string | null;
  created_at: Date;
  updated_at: Date;
  closed: boolean;
  total_cost_usd: number;
  total_turns: number;
}

export interface ConversationMessageRecord {
  id: number;
  conversation_id: string;
  run_id: number | null;
  role: string;
  content: string;
  content_type: string;
  tool_name: string | null;
  created_at: Date;
  seq: number;
}

// ── Budget ──────────────────────────────────────────────────

export interface UsagePrediction {
  todaySpent: number;
  remaining: number;
  estimatedRunCost: number;
  confidence: 'low' | 'medium' | 'high';
  shouldRun: boolean;
  reason?: string;
}

// ── Skip List ────────────────────────────────────────────────

export interface SkipEntry {
  automationName: string;
  consecutiveFailures: number;
  addedAt: string;
}

// ── Config ──────────────────────────────────────────────────

export interface AppConfig {
  automationsDir: string;
  databaseUrl: string;
  mcpConfigPath?: string;
  defaultModel: string;
}
