import pg from 'pg';
import { z } from 'zod';
import { logger } from './logger.js';
import type { ExecutionResult, ConversationMessage, ConversationRecord, ConversationMessageRecord } from './types.js';

const { Pool } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_history (
  id SERIAL PRIMARY KEY,
  automation_name TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  error TEXT,
  duration_ms INTEGER NOT NULL,
  mode TEXT NOT NULL,
  cost_usd DOUBLE PRECISION,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_history_name ON run_history(automation_name);
CREATE INDEX IF NOT EXISTS idx_run_history_started ON run_history(started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE run_history ADD COLUMN IF NOT EXISTS input_tokens INTEGER;
ALTER TABLE run_history ADD COLUMN IF NOT EXISTS output_tokens INTEGER;
ALTER TABLE run_history ADD COLUMN IF NOT EXISTS attempt_number INTEGER;
ALTER TABLE run_history ADD COLUMN IF NOT EXISTS total_attempts INTEGER;

CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '[]',
  env JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS env_vars (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE run_history ADD COLUMN IF NOT EXISTS conversation_id TEXT;
ALTER TABLE run_history ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  automation_name TEXT NOT NULL,
  claude_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed BOOLEAN NOT NULL DEFAULT false,
  total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_turns INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_automation ON conversations(automation_name);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id SERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES run_history(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  tool_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seq INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_msg_conv ON conversation_messages(conversation_id, seq);

ALTER TABLE run_history ADD COLUMN IF NOT EXISTS log_file TEXT;

-- Live run stage tracking: a row is inserted when the run starts and updated
-- as the Claude stream produces assistant/tool_use events. Requires the
-- previously-NOT-NULL columns to become nullable.
ALTER TABLE run_history ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE run_history ADD COLUMN IF NOT EXISTS current_stage TEXT;
ALTER TABLE run_history ADD COLUMN IF NOT EXISTS turn_count INTEGER;
ALTER TABLE run_history ALTER COLUMN success DROP NOT NULL;
ALTER TABLE run_history ALTER COLUMN finished_at DROP NOT NULL;
ALTER TABLE run_history ALTER COLUMN duration_ms DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_run_history_status ON run_history(status) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_running_per_automation ON run_history(automation_name) WHERE status = 'running';
`;

/**
 * Row data captured by the orphan sweep, used to send notifications for runs
 * that crashed before they could call notifier themselves.
 */
export interface SweptOrphanRow {
  id: number;
  automation_name: string;
  mode: string;
  started_at: Date;
  finished_at: Date;
  error: string;
}

export class History {
  private pool: pg.Pool;
  /** Rows swept on startup, awaiting notification once the notifier is ready. */
  private pendingOrphanNotifications: SweptOrphanRow[] = [];

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static async create(databaseUrl: string, opts?: { sweepOrphans?: boolean }): Promise<History> {
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(SCHEMA);
    const instance = new History(pool);
    // Sweep orphaned `running` rows left behind by a crashed process.
    if (opts?.sweepOrphans) {
      // Daemon startup: sweep ALL orphaned running rows (only the daemon should
      // set this flag, because it starts after the web and owns long-lived runs).
      const swept = await pool.query<SweptOrphanRow>(
        `UPDATE run_history
           SET status = 'failed',
               success = false,
               error = COALESCE(error, 'process crash'),
               finished_at = COALESCE(finished_at, NOW())
         WHERE status = 'running'
         RETURNING id, automation_name, mode, started_at, finished_at, error`,
      );
      if (swept.rowCount && swept.rowCount > 0) {
        logger.warn({ sweptRows: swept.rowCount }, 'Swept orphaned running rows on startup');
        instance.pendingOrphanNotifications = swept.rows;
      }
    } else {
      // Web startup: only sweep rows stuck in `running` for > 30 minutes.
      // This is safe even if the daemon has live runs — no automation should
      // legitimately run for 30+ minutes without finalizing.
      const swept = await pool.query<SweptOrphanRow>(
        `UPDATE run_history
           SET status = 'failed',
               success = false,
               error = COALESCE(error, 'process crash (stale)'),
               finished_at = COALESCE(finished_at, NOW())
         WHERE status = 'running'
           AND started_at < NOW() - INTERVAL '30 minutes'
         RETURNING id, automation_name, mode, started_at, finished_at, error`,
      );
      if (swept.rowCount && swept.rowCount > 0) {
        logger.warn({ sweptRows: swept.rowCount }, 'Swept stale running rows on startup (>30 min)');
        instance.pendingOrphanNotifications = swept.rows;
      }
    }
    logger.debug({ databaseUrl: databaseUrl.replace(/\/\/.*@/, '//*:*@') }, 'History database initialized');
    return instance;
  }

  /**
   * Drain and return any orphan rows swept on startup. Callers should pass the
   * result to a Notifier so users get notified about crashed runs.
   * Idempotent — subsequent calls return an empty array.
   */
  takePendingOrphanNotifications(): SweptOrphanRow[] {
    const rows = this.pendingOrphanNotifications;
    this.pendingOrphanNotifications = [];
    return rows;
  }

  // ── Live run stage tracking ────────────────────────────────

  /**
   * Insert a run row in the `running` state before execution begins.
   * Returns the generated id so callers can update it later.
   */
  async insertRunning(params: {
    automationName: string;
    mode: string;
    startedAt: Date;
    conversationId?: string | null;
  }): Promise<number | null> {
    try {
      const { rows } = await this.pool.query<{ id: number }>(
        `INSERT INTO run_history (automation_name, mode, started_at, status, output, duration_ms, turn_count, conversation_id)
         VALUES ($1, $2, $3, 'running', '', 0, 0, $4)
         RETURNING id`,
        [params.automationName, params.mode, params.startedAt, params.conversationId ?? null],
      );
      return rows[0].id;
    } catch (err: unknown) {
      // Unique violation (23505) on idx_one_running_per_automation — another
      // process already has a running row for this automation.
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        return null;
      }
      throw err;
    }
  }

  /** Update the current_stage / turn_count of a running row. */
  async updateProgress(id: number, stage: string, turn: number): Promise<void> {
    await this.pool.query(
      `UPDATE run_history SET current_stage = $2, turn_count = $3 WHERE id = $1 AND status = 'running'`,
      [id, stage, turn],
    );
  }

  /**
   * Persist the per-run log file path on a running row, before any stream-json
   * line has been appended. Lets the web UI tail the file while the run is in
   * progress (live log streaming). Each retry attempt may overwrite the path
   * with a fresh file — that is intentional, the user sees the current
   * attempt's live log.
   */
  async updateLogFile(id: number, logFile: string): Promise<void> {
    await this.pool.query(
      `UPDATE run_history SET log_file = $2 WHERE id = $1 AND status = 'running'`,
      [id, logFile],
    );
  }

  /** Finalize a running row with the terminal ExecutionResult. */
  async finalizeRun(id: number, result: ExecutionResult): Promise<void> {
    await this.pool.query(
      `UPDATE run_history SET
         status = $2,
         success = $3,
         output = $4,
         error = $5,
         duration_ms = $6,
         cost_usd = $7,
         finished_at = $8,
         input_tokens = $9,
         output_tokens = $10,
         attempt_number = $11,
         total_attempts = $12,
         conversation_id = COALESCE(conversation_id, $13),
         session_id = $14,
         log_file = $15
       WHERE id = $1 AND (status = 'running' OR status IS NULL)`,
      [
        id,
        result.success ? 'success' : 'failed',
        result.success,
        result.output.slice(0, 10000),
        result.error ?? null,
        result.durationMs,
        result.costUsd ?? null,
        result.finishedAt,
        result.inputTokens ?? null,
        result.outputTokens ?? null,
        result.attemptNumber ?? null,
        result.totalAttempts ?? null,
        result.conversationId ?? null,
        result.sessionId ?? null,
        result.logFile ?? null,
      ],
    );
  }

  /** Count currently-running rows. Used by throttling / in-flight checks. */
  async getRunningCountDb(automationName?: string): Promise<number> {
    if (automationName) {
      const { rows } = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM run_history WHERE status = 'running' AND automation_name = $1`,
        [automationName],
      );
      return parseInt(rows[0].count, 10);
    }
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM run_history WHERE status = 'running'`,
    );
    return parseInt(rows[0].count, 10);
  }

  async insert(result: ExecutionResult): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO run_history (automation_name, success, output, error, duration_ms, mode, cost_usd, started_at, finished_at, input_tokens, output_tokens, attempt_number, total_attempts, conversation_id, session_id, log_file)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        result.automationName,
        result.success,
        result.output.slice(0, 10000),
        result.error ?? null,
        result.durationMs,
        result.mode,
        result.costUsd ?? null,
        result.startedAt,
        result.finishedAt,
        result.inputTokens ?? null,
        result.outputTokens ?? null,
        result.attemptNumber ?? null,
        result.totalAttempts ?? null,
        result.conversationId ?? null,
        result.sessionId ?? null,
        result.logFile ?? null,
      ],
    );
    return rows[0].id;
  }

  async getHistory(automationName?: string, limit = 10): Promise<RunRecord[]> {
    if (automationName) {
      const { rows } = await this.pool.query<RunRecord>(
        `SELECT * FROM run_history WHERE automation_name = $1 ORDER BY started_at DESC LIMIT $2`,
        [automationName, limit],
      );
      return rows;
    }
    const { rows } = await this.pool.query<RunRecord>(
      `SELECT * FROM run_history ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async getById(id: number): Promise<RunRecord | undefined> {
    const { rows } = await this.pool.query<RunRecord>(
      `SELECT * FROM run_history WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async getLastRun(automationName: string): Promise<RunRecord | undefined> {
    const { rows } = await this.pool.query<RunRecord>(
      `SELECT * FROM run_history WHERE automation_name = $1 ORDER BY started_at DESC LIMIT 1`,
      [automationName],
    );
    return rows[0];
  }

  async getTotalCost(): Promise<number> {
    const { rows } = await this.pool.query<{ total: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM run_history`,
    );
    return rows[0].total;
  }

  async prune(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.pool.query(
      `DELETE FROM run_history WHERE started_at < $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    const { rows } = await this.pool.query<{ value: T }>(
      `SELECT value FROM settings WHERE key = $1`,
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async setSetting<T = unknown>(key: string, value: T): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  }

  async getRunsInWindow(windowMs: number, automationName?: string): Promise<number> {
    const cutoff = new Date(Date.now() - windowMs);
    if (automationName) {
      const { rows } = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM run_history WHERE started_at >= $1 AND automation_name = $2 AND (status IS NULL OR status <> 'running')`,
        [cutoff, automationName],
      );
      return parseInt(rows[0].count, 10);
    }
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM run_history WHERE started_at >= $1 AND (status IS NULL OR status <> 'running')`,
      [cutoff],
    );
    return parseInt(rows[0].count, 10);
  }

  // ── Analytics ─────────────────────────────────────────────

  async getUsageStats(days: number): Promise<UsageStat[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { rows } = await this.pool.query<UsageStat>(
      `SELECT DATE_TRUNC('day', started_at AT TIME ZONE 'UTC')::date AS day,
              COALESCE(SUM(cost_usd), 0)::float AS total_cost,
              COALESCE(SUM(input_tokens), 0)::int AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
              COUNT(*)::int AS run_count
       FROM run_history
       WHERE started_at >= $1 AND (status IS NULL OR status <> 'running')
       GROUP BY 1 ORDER BY 1`,
      [cutoff],
    );
    return rows;
  }

  async getAgentStats(): Promise<AgentStat[]> {
    const { rows } = await this.pool.query<AgentStat>(
      `SELECT automation_name,
              COUNT(*)::int AS total_runs,
              ROUND(100.0 * SUM(CASE WHEN success THEN 1 ELSE 0 END) / COUNT(*), 1)::float AS success_rate,
              COALESCE(AVG(cost_usd), 0)::float AS avg_cost,
              COALESCE(AVG(duration_ms), 0)::int AS avg_duration_ms,
              COALESCE(SUM(input_tokens), 0)::int AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
              COALESCE(SUM(cost_usd), 0)::float AS total_cost
       FROM run_history
       WHERE status IS NULL OR status <> 'running'
       GROUP BY automation_name
       ORDER BY total_runs DESC`,
    );
    return rows;
  }

  // ── MCP Servers ────────────────────────────────────────────

  async getMcpServers(): Promise<McpServerRecord[]> {
    const { rows } = await this.pool.query<McpServerRecord>(
      `SELECT * FROM mcp_servers ORDER BY name`,
    );
    return rows;
  }

  async getMcpServer(name: string): Promise<McpServerRecord | undefined> {
    const { rows } = await this.pool.query<McpServerRecord>(
      `SELECT * FROM mcp_servers WHERE name = $1`,
      [name],
    );
    return rows[0];
  }

  async upsertMcpServer(server: { name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }): Promise<void> {
    await this.pool.query(
      `INSERT INTO mcp_servers (name, command, args, env, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (name) DO UPDATE SET
         command = $2, args = $3, env = $4, enabled = $5, updated_at = NOW()`,
      [server.name, server.command, JSON.stringify(server.args), JSON.stringify(server.env), server.enabled],
    );
  }

  async deleteMcpServer(name: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM mcp_servers WHERE name = $1`,
      [name],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE mcp_servers SET enabled = $1, updated_at = NOW() WHERE name = $2`,
      [enabled, name],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getMcpServerCount(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM mcp_servers`,
    );
    return parseInt(rows[0].count, 10);
  }

  // ── Env Vars ─────────────────────────────────────────────

  async getEnvVars(): Promise<EnvVarRecord[]> {
    const { rows } = await this.pool.query<EnvVarRecord>(
      `SELECT * FROM env_vars ORDER BY name`,
    );
    return rows;
  }

  async getEnvVar(name: string): Promise<EnvVarRecord | undefined> {
    const { rows } = await this.pool.query<EnvVarRecord>(
      `SELECT * FROM env_vars WHERE name = $1`,
      [name],
    );
    return rows[0];
  }

  async insertEnvVar(envVar: { name: string; value: string; description: string; enabled: boolean }): Promise<void> {
    await this.pool.query(
      `INSERT INTO env_vars (name, value, description, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [envVar.name, envVar.value, envVar.description, envVar.enabled],
    );
  }

  async upsertEnvVar(envVar: { name: string; value: string; description: string; enabled: boolean }): Promise<void> {
    await this.pool.query(
      `INSERT INTO env_vars (name, value, description, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (name) DO UPDATE SET
         value = $2, description = $3, enabled = $4, updated_at = NOW()`,
      [envVar.name, envVar.value, envVar.description, envVar.enabled],
    );
  }

  async deleteEnvVar(name: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM env_vars WHERE name = $1`,
      [name],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setEnvVarEnabled(name: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE env_vars SET enabled = $1, updated_at = NOW() WHERE name = $2`,
      [enabled, name],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getEnabledEnvVars(): Promise<Record<string, string>> {
    const { rows } = await this.pool.query<{ name: string; value: string }>(
      `SELECT name, value FROM env_vars WHERE enabled = true`,
    );
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.name] = row.value;
    }
    return result;
  }

  // ── Budget ───────────────────────────────────────────────

  async getTodaySpent(): Promise<number> {
    const { rows } = await this.pool.query<{ total: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM run_history
       WHERE started_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    );
    return Number(rows[0].total);
  }

  async getRecentRunCosts(limit = 10): Promise<number[]> {
    const { rows } = await this.pool.query<{ cost_usd: number }>(
      `SELECT cost_usd FROM run_history
       WHERE cost_usd IS NOT NULL
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => Number(r.cost_usd));
  }

  async getConsecutiveFailures(automationName: string, limit = 5): Promise<number> {
    const { rows } = await this.pool.query<{ success: boolean }>(
      `SELECT success FROM run_history WHERE automation_name = $1 ORDER BY started_at DESC LIMIT $2`,
      [automationName, limit],
    );
    let count = 0;
    for (const row of rows) {
      if (!row.success) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  async getFailedTasks(minConsecutiveFailures = 2): Promise<string[]> {
    // Get distinct automation names, then check each for consecutive failures
    const { rows } = await this.pool.query<{ automation_name: string }>(
      `SELECT DISTINCT automation_name FROM run_history`,
    );
    const failed: string[] = [];
    for (const row of rows) {
      const count = await this.getConsecutiveFailures(row.automation_name, minConsecutiveFailures);
      if (count >= minConsecutiveFailures) {
        failed.push(row.automation_name);
      }
    }
    return failed;
  }

  async getConsecutiveRateLimits(): Promise<number> {
    const { rows } = await this.pool.query<{ error: string | null; success: boolean }>(
      `SELECT error, success FROM run_history ORDER BY started_at DESC LIMIT 20`,
    );
    let count = 0;
    for (const row of rows) {
      if (!row.success && row.error && /rate.?limit|429|overloaded/i.test(row.error)) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  // ── Conversations ─────────────────────────────────────────

  async createConversation(id: string, automationName: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversations (id, automation_name) VALUES ($1, $2)`,
      [id, automationName],
    );
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    const { rows } = await this.pool.query<ConversationRecord>(
      `SELECT * FROM conversations WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async getActiveConversation(automationName: string): Promise<ConversationRecord | undefined> {
    const { rows } = await this.pool.query<ConversationRecord>(
      `SELECT * FROM conversations
       WHERE automation_name = $1 AND closed = false
         AND updated_at > NOW() - INTERVAL '24 hours'
       ORDER BY updated_at DESC LIMIT 1`,
      [automationName],
    );
    return rows[0];
  }

  async updateConversationSession(id: string, sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversations SET claude_session_id = $1, updated_at = NOW() WHERE id = $2`,
      [sessionId, id],
    );
  }

  async updateConversationStats(id: string, costDelta: number): Promise<void> {
    await this.pool.query(
      `UPDATE conversations SET
         total_cost_usd = total_cost_usd + $1,
         total_turns = total_turns + 1,
         updated_at = NOW()
       WHERE id = $2`,
      [costDelta, id],
    );
  }

  async closeConversation(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversations SET closed = true, updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async getConversationMessages(conversationId: string): Promise<ConversationMessageRecord[]> {
    const { rows } = await this.pool.query<ConversationMessageRecord>(
      `SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq`,
      [conversationId],
    );
    return rows;
  }

  async getMaxMessageSeq(conversationId: string): Promise<number> {
    const { rows } = await this.pool.query<{ max_seq: number | null }>(
      `SELECT MAX(seq) as max_seq FROM conversation_messages WHERE conversation_id = $1`,
      [conversationId],
    );
    return rows[0]?.max_seq ?? 0;
  }

  async insertConversationMessages(
    conversationId: string,
    runId: number,
    messages: ConversationMessage[],
    startSeq: number,
  ): Promise<void> {
    if (messages.length === 0) return;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      values.push(conversationId, runId, m.role, m.content, m.contentType, m.toolName ?? null, startSeq + i);
    }
    await this.pool.query(
      `INSERT INTO conversation_messages (conversation_id, run_id, role, content, content_type, tool_name, seq)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  async getConversationHistory(automationName?: string, limit = 10): Promise<ConversationRecord[]> {
    if (automationName) {
      const { rows } = await this.pool.query<ConversationRecord>(
        `SELECT * FROM conversations WHERE automation_name = $1 ORDER BY updated_at DESC LIMIT $2`,
        [automationName, limit],
      );
      return rows;
    }
    const { rows } = await this.pool.query<ConversationRecord>(
      `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const ThrottleConfigSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(100),
  maxPerHour: z.number().int().min(0).max(10000),
  cooldownSeconds: z.number().int().min(0).max(86400),
  enabled: z.boolean(),
});

export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>;

export const DEFAULT_THROTTLE: ThrottleConfig = {
  maxConcurrent: 30,
  maxPerHour: 20,
  cooldownSeconds: 0,
  enabled: false,
};

export const BudgetConfigSchema = z.object({
  dailyBudget: z.number().min(0).max(10000),
  reservePercent: z.number().min(0).max(100),
  workHoursStart: z.number().int().min(0).max(23),
  workHoursEnd: z.number().int().min(0).max(23),
  offHoursMultiplier: z.number().min(0.1).max(10),
  enabled: z.boolean(),
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyBudget: 10,
  reservePercent: 10,
  workHoursStart: 9,
  workHoursEnd: 18,
  offHoursMultiplier: 0.5,
  enabled: false,
};

export interface RunRecord {
  id: number;
  automation_name: string;
  success: boolean | null;
  output: string;
  error: string | null;
  duration_ms: number | null;
  mode: string;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  attempt_number: number | null;
  total_attempts: number | null;
  started_at: Date;
  finished_at: Date | null;
  conversation_id: string | null;
  session_id: string | null;
  log_file: string | null;
  status: 'running' | 'success' | 'failed' | null;
  current_stage: string | null;
  turn_count: number | null;
}

export interface McpServerRecord {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UsageStat {
  day: string;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  run_count: number;
}

export interface AgentStat {
  automation_name: string;
  total_runs: number;
  success_rate: number;
  avg_cost: number;
  avg_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
}

export interface EnvVarRecord {
  name: string;
  value: string;
  description: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export const EnvVarInputSchema = z.object({
  name: z.string().min(1, 'Name is required').trim().regex(/^[A-Z_][A-Z0-9_]*$/i, 'Must be a valid env var name (letters, digits, underscores)'),
  value: z.string().max(8192).default(''),
  description: z.string().max(1024).default(''),
  enabled: z.boolean().default(true),
});

export const McpServerInputSchema = z.object({
  name: z.string().min(1, 'Name is required').trim().regex(/^[a-z0-9_-]+$/i, 'Name must be alphanumeric, hyphens, or underscores'),
  command: z.string().min(1, 'Command is required'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});
