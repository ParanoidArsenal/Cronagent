#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MM_URL = process.env.MATTERMOST_URL;
const MM_TOKEN = process.env.MATTERMOST_TOKEN;
const AGENT_RUNNER_URL = process.env.AGENT_RUNNER_URL || "http://localhost:3001";
const CAILA_API_KEY = process.env.CAILA_API_KEY || "";
const CAILA_BASE_URL = process.env.CAILA_BASE_URL || "https://caila.io";
const JIRA_URL = process.env.JIRA_URL || "https://jira.example.com";
const PROGRESS_STATE_DIR = "/tmp/merge-notifications";

if (!MM_URL || !MM_TOKEN) {
  console.error("MATTERMOST_URL and MATTERMOST_TOKEN environment variables are required");
  process.exit(1);
}

const HTTP_TIMEOUT_MS = (() => {
  const n = Number(process.env.MCP_HTTP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

// ==================== Argument validation ====================

class ToolArgError extends Error {}

/**
 * Lightweight runtime check of tool arguments against the tool's own
 * inputSchema (required fields + top-level primitive types + enum).
 * Numeric strings are coerced for "number" fields and numbers for "string"
 * fields. Throws ToolArgError.
 */
function validateArgs(
  schema: { properties?: Record<string, any>; required?: string[] },
  rawArgs: unknown
): Record<string, any> {
  if (rawArgs != null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
    throw new ToolArgError("arguments must be an object");
  }
  const args: Record<string, any> = { ...((rawArgs as Record<string, any>) ?? {}) };
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    const v = args[key];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
      throw new ToolArgError(`missing required argument '${key}'`);
    }
  }
  for (const [key, def] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    const expected = def?.type;
    let ok = true;
    switch (expected) {
      case "string":
        if (typeof v === "number" && Number.isFinite(v)) args[key] = String(v);
        ok = typeof args[key] === "string";
        break;
      case "number":
      case "integer":
        if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
          args[key] = Number(v);
        }
        ok = typeof args[key] === "number" && Number.isFinite(args[key]) &&
          (expected !== "integer" || Number.isInteger(args[key]));
        break;
      case "boolean":
        ok = typeof v === "boolean";
        break;
      case "array":
        ok = Array.isArray(v);
        break;
      case "object":
        ok = typeof v === "object" && !Array.isArray(v);
        break;
    }
    if (!ok) {
      throw new ToolArgError(
        `argument '${key}' must be of type ${expected}, got ${Array.isArray(v) ? "array" : typeof v}`
      );
    }
    if (Array.isArray(def?.enum) && !def.enum.includes(args[key])) {
      throw new ToolArgError(
        `argument '${key}' must be one of: ${def.enum.join(", ")}`
      );
    }
  }
  return args;
}

/** Encode an LLM-supplied value for use as a single URL path segment. */
const seg = (v: string | number) => encodeURIComponent(String(v));

// --- Merge notification constants & helpers ---

const STEPS = [
  { id: "jira-collector", label: "Сбор контекста" },
  { id: "readiness-check", label: "Проверка MR" },
  { id: "change-analyzer", label: "Анализ изменений" },
  { id: "code-reviewer", label: "Code review" },
  { id: "describe-and-update", label: "Описание" },
  { id: "doc-writer", label: "Документация" },
  { id: "merger", label: "Мерж" },
  { id: "jira-transition", label: "Статус Jira" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

const NOTIFICATION_STATUS_EMOJI: Record<string, string> = {
  success: ":white_check_mark:",
  error: ":x:",
  cancelled: ":no_entry_sign:",
  waiting_for_action: ":warning:",
};

const PROGRESS_STATUS_EMOJI: Record<string, string> = {
  pending: ":white_circle:",
  in_progress: ":arrows_counterclockwise:",
  success: ":white_check_mark:",
  error: ":x:",
};

interface StepState {
  status: string;
  comment: string;
}

interface ProgressState {
  channelId: string;
  rootId: string;
  steps: Record<string, StepState>;
}

function ensureStateDir(): void {
  if (!existsSync(PROGRESS_STATE_DIR)) {
    mkdirSync(PROGRESS_STATE_DIR, { recursive: true });
  }
}

function saveProgressState(progressPostId: string, state: ProgressState): void {
  ensureStateDir();
  writeFileSync(
    join(PROGRESS_STATE_DIR, `${progressPostId}.json`),
    JSON.stringify(state, null, 2)
  );
}

function loadProgressState(progressPostId: string): ProgressState | null {
  const filePath = join(PROGRESS_STATE_DIR, `${progressPostId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function renderProgressTable(steps: Record<string, StepState>): string {
  const lines = [
    "| Шаг | Статус | Комментарий |",
    "|:----|:------:|:------------|",
  ];
  for (const step of STEPS) {
    const s = steps[step.id] || { status: "pending", comment: "—" };
    const emoji = PROGRESS_STATUS_EMOJI[s.status] || ":white_circle:";
    lines.push(`| ${step.label} | ${emoji} | ${s.comment} |`);
  }
  return lines.join("\n");
}

function createInitialSteps(): Record<string, StepState> {
  const steps: Record<string, StepState> = {};
  for (const step of STEPS) {
    if (step.id === "jira-collector") {
      steps[step.id] = { status: "success", comment: "Данные собраны" };
    } else {
      steps[step.id] = { status: "pending", comment: "—" };
    }
  }
  return steps;
}

/** Parse progress table from MM post to restore state (fallback when state file is missing) */
function parseProgressTable(message: string): Record<string, StepState> | null {
  const steps: Record<string, StepState> = {};
  const emojiToStatus: Record<string, string> = {};
  for (const [status, emoji] of Object.entries(PROGRESS_STATUS_EMOJI)) {
    emojiToStatus[emoji] = status;
  }

  const lines = message.split("\n");
  for (const line of lines) {
    if (!line.startsWith("|") || line.includes(":-")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const [label, emoji, comment] = cells;
    // Find step by label
    const step = STEPS.find((s) => s.label === label);
    if (!step) continue;
    const status = emojiToStatus[emoji] || "pending";
    steps[step.id] = { status, comment: comment || "—" };
  }
  return Object.keys(steps).length > 0 ? steps : null;
}

/** Call Caila LLM for description summarization */
async function callCailaLLM(description: string): Promise<string> {
  if (!CAILA_API_KEY) {
    throw new Error("CAILA_API_KEY not configured");
  }

  try {
    const url = `${CAILA_BASE_URL}/api/adapters/openai-direct/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${CAILA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "your-org/model-id",
        messages: [
          {
            role: "system",
            content:
              "Ты пишешь краткие описания задач для уведомлений. На входе — контекст задачи (описание, треды Mattermost, метаданные). Напиши 1-3 предложения, передающих суть задачи. Пиши на том же языке что и контекст. Не включай технические детали (ID аккаунтов, окружение, ключ задачи). Верни только текст описания, без маркдауна и кавычек.",
          },
          { role: "user", content: description },
        ],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Caila LLM error: ${res.status} ${text}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`Caila LLM request timed out after ${HTTP_TIMEOUT_MS}ms (set MCP_HTTP_TIMEOUT_MS to change)`);
    }
    throw err;
  }
}

/** Summarize description: try LLM, fallback to truncation */
async function summarizeDescription(description: string): Promise<string> {
  try {
    const summary = await callCailaLLM(description);
    if (summary) return summary;
  } catch (e: any) {
    console.error(`[MattermostMCP] LLM summarization failed: ${e.message}`);
  }
  // Fallback: first 500 chars
  const clean = description.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 500 ? clean.slice(0, 500) + "…" : clean;
}

/** Format the notification message */
function formatNotification(args: {
  issue_key: string;
  summary: string;
  issue_type: string;
  priority?: string;
  components?: string[];
  assignee?: string;
  labels?: string[];
  fix_versions?: string[];
  customer?: string;
  contributors?: Array<{ name: string; mm_mention: string; commits_count: number }>;
  descriptionSummary?: string;
}): string {
  const lines: string[] = [];

  // Header
  lines.push(
    `### :loading1: [${args.issue_key}](${JIRA_URL}/browse/${args.issue_key}) — ${args.summary}`
  );
  lines.push("");

  // Type & Priority
  const typeParts = [`**Тип:** ${args.issue_type}`];
  if (args.priority) typeParts.push(`**Приоритет:** ${args.priority}`);
  lines.push(typeParts.join(" · "));

  // Components
  if (args.components && args.components.length > 0) {
    lines.push(
      `**Компоненты:** ${args.components.map((c) => `\`${c}\``).join(" · ")}`
    );
  }

  // Assignee
  if (args.assignee) {
    lines.push(`**Исполнитель:** ${args.assignee}`);
  }

  // Contributors
  if (args.contributors && args.contributors.length > 0) {
    const mentions = args.contributors.map((c) => c.mm_mention).join(", ");
    lines.push(`**Разработчики:** ${mentions}`);
  }

  // Customer
  if (args.customer) {
    lines.push(`**Заказчик:** ${args.customer}`);
  }

  // Fix versions
  if (args.fix_versions && args.fix_versions.length > 0) {
    lines.push(`**Версия:** ${args.fix_versions.join(", ")}`);
  }

  // Labels
  if (args.labels && args.labels.length > 0) {
    lines.push(
      `:label: ${args.labels.map((l) => `\`${l}\``).join(" ")}`
    );
  }

  // Description summary
  if (args.descriptionSummary) {
    lines.push("");
    for (const line of args.descriptionSummary.split("\n")) {
      lines.push(`> ${line}`);
    }
  }

  return lines.join("\n");
}

// Cache: bot user ID + channels we've confirmed membership in
let cachedBotUserId: string | null = null;
const knownChannels = new Set<string>();

async function getBotUserId(): Promise<string> {
  if (!cachedBotUserId) {
    const me = await mmRequest<User>("/users/me");
    cachedBotUserId = me.id;
  }
  return cachedBotUserId;
}

async function ensureChannelMembership(channelId: string): Promise<void> {
  if (knownChannels.has(channelId)) return;

  const userId = await getBotUserId();
  try {
    await mmRequest(`/channels/${seg(channelId)}/members`, "POST", {
      user_id: userId,
    });
    console.error(`[MattermostMCP] Joined channel ${channelId}`);
  } catch (e: any) {
    // 400 = already a member, that's fine
    if (!e.message?.includes("400")) {
      throw e;
    }
  }
  knownChannels.add(channelId);
}

/**
 * Register a Mattermost session in agent-runner so the poller starts
 * monitoring the thread and routes replies to the specified agent.
 */
async function registerThreadSession(
  threadId: string,
  agentType: string,
  channelId: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const currentSessionId = process.env.CURRENT_SESSION_ID || null;
    const res = await fetch(`${AGENT_RUNNER_URL}/api/mattermost/sessions`, {
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_id: threadId,
        agent_type: agentType,
        state: "waiting_for_feedback",
        claude_session_id: currentSessionId,
        metadata: {
          channel_id: channelId,
          skip_classification: true,
          ...metadata,
        },
      }),
    });
    if (res.ok) {
      console.error(`[MattermostMCP] Registered thread session: ${threadId} -> ${agentType}`);
    } else {
      const text = await res.text();
      console.error(`[MattermostMCP] Failed to register session: ${res.status} ${text}`);
    }
  } catch (e: any) {
    const msg = isTimeoutError(e)
      ? `request timed out after ${HTTP_TIMEOUT_MS}ms`
      : e.message;
    console.error(`[MattermostMCP] Session registration error: ${msg}`);
  }
}

interface Post {
  id: string;
  create_at: number;
  update_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  props?: Record<string, unknown>;
}

interface User {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
}

interface Channel {
  id: string;
  name: string;
  display_name: string;
  type: string;
  team_id: string;
}

interface Team {
  id: string;
  name: string;
  display_name: string;
}

interface PostsResponse {
  order: string[];
  posts: Record<string, Post>;
}

async function mmRequest<T>(
  endpoint: string,
  method: string = "GET",
  body?: Record<string, unknown>
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${MM_TOKEN}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  options.signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(`${MM_URL}/api/v4${endpoint}`, options);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Mattermost API error: ${response.status} ${response.statusText} - ${text}`);
    }

    return (await response.json()) as T;
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(
        `Mattermost API ${method} ${endpoint}: request timed out after ${HTTP_TIMEOUT_MS}ms (set MCP_HTTP_TIMEOUT_MS to change)`
      );
    }
    throw err;
  }
}

const server = new Server(
  {
    name: "mattermost-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const TOOLS = [
    {
      name: "send_message",
      description: "Send a message to a Mattermost channel. Can optionally reply to a thread. Use subscribe_as to auto-monitor the thread for replies.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Channel ID to send message to",
          },
          message: {
            type: "string",
            description: "Message text (supports Markdown)",
          },
          root_id: {
            type: "string",
            description: "Optional: root post ID to reply in a thread",
          },
          subscribe_as: {
            type: "string",
            description: "Optional: agent name to handle thread replies. When set for a root message (no root_id), automatically registers a session so the bot monitors this thread and routes replies to the specified agent.",
          },
        },
        required: ["channel_id", "message"],
      },
    },
    {
      name: "get_posts",
      description: "Get recent posts from a channel",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Channel ID",
          },
          per_page: {
            type: "number",
            description: "Number of posts to return (default: 30, max: 200)",
          },
        },
        required: ["channel_id"],
      },
    },
    {
      name: "get_thread",
      description: "Get all posts in a thread",
      inputSchema: {
        type: "object",
        properties: {
          post_id: {
            type: "string",
            description: "Root post ID of the thread",
          },
        },
        required: ["post_id"],
      },
    },
    {
      name: "add_reaction",
      description: "Add an emoji reaction to a post",
      inputSchema: {
        type: "object",
        properties: {
          post_id: {
            type: "string",
            description: "Post ID to react to",
          },
          emoji_name: {
            type: "string",
            description: "Emoji name without colons (e.g., 'thumbsup', 'eyes')",
          },
        },
        required: ["post_id", "emoji_name"],
      },
    },
    {
      name: "get_user",
      description: "Get user information by ID or username",
      inputSchema: {
        type: "object",
        properties: {
          user_id: {
            type: "string",
            description: "User ID",
          },
          username: {
            type: "string",
            description: "Username (without @)",
          },
        },
      },
    },
    {
      name: "get_channel",
      description: "Get channel information",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Channel ID",
          },
        },
        required: ["channel_id"],
      },
    },
    {
      name: "search_posts",
      description: "Search for posts in a team",
      inputSchema: {
        type: "object",
        properties: {
          team_id: {
            type: "string",
            description: "Team ID to search in",
          },
          terms: {
            type: "string",
            description: "Search terms (supports Mattermost search syntax)",
          },
        },
        required: ["team_id", "terms"],
      },
    },
    {
      name: "get_me",
      description: "Get current bot user information",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "update_post",
      description: "Edit/update a post message",
      inputSchema: {
        type: "object",
        properties: {
          post_id: {
            type: "string",
            description: "Post ID to update",
          },
          message: {
            type: "string",
            description: "New message text",
          },
        },
        required: ["post_id", "message"],
      },
    },
    {
      name: "delete_post",
      description: "Delete a post",
      inputSchema: {
        type: "object",
        properties: {
          post_id: {
            type: "string",
            description: "Post ID to delete",
          },
        },
        required: ["post_id"],
      },
    },
    // --- Merge notification tools ---
    {
      name: "merge_create_notification",
      description:
        "Create a merge notification message in Mattermost. Formats the message from structured fields, summarizes description via LLM. Auto-subscribes the thread for merge-checker agent.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Jira issue key (e.g., CAILA-1234)",
          },
          summary: {
            type: "string",
            description: "Issue title",
          },
          issue_type: {
            type: "string",
            description: 'Issue type (e.g., "Bug", "Story")',
          },
          priority: {
            type: "string",
            description: "Priority (e.g., High, Medium)",
          },
          components: {
            type: "array",
            items: { type: "string" },
            description: "Component names",
          },
          assignee: {
            type: "string",
            description: "Assignee display name",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Issue labels",
          },
          fix_versions: {
            type: "array",
            items: { type: "string" },
            description: "Fix version names",
          },
          customer: {
            type: "string",
            description: "Customer name with sales contact, e.g. 'Client Name (sales: @s.person)'",
          },
          contributors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                mm_mention: { type: "string" },
                commits_count: { type: "number" },
              },
            },
            description: "List of code contributors with MM mentions",
          },
          context: {
            type: "string",
            description:
              "Pipeline context markdown (from pipeline_read). Contains description, MM threads, metadata. Will be summarized to 1-3 sentences via LLM.",
          },
          channel_id: {
            type: "string",
            description: "Target channel ID to post the notification to.",
          },
        },
        required: ["issue_key", "summary", "issue_type", "channel_id"],
      },
    },
    {
      name: "merge_update_status",
      description:
        'Update the status emoji on a merge notification post. Replaces :loading1: with the emoji for the given status.',
      inputSchema: {
        type: "object",
        properties: {
          post_id: {
            type: "string",
            description: "Notification post ID",
          },
          status: {
            type: "string",
            enum: ["success", "error", "cancelled", "waiting_for_action"],
            description: "New status",
          },
        },
        required: ["post_id", "status"],
      },
    },
    {
      name: "merge_progress_init",
      description:
        "Create an initial progress table in a thread. All steps start as pending except jira-collector which is marked as success.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description: "Channel ID",
          },
          root_id: {
            type: "string",
            description: "Notification post ID (thread root)",
          },
        },
        required: ["channel_id", "root_id"],
      },
    },
    {
      name: "merge_progress_update",
      description:
        "Update a specific step in the progress table. Provide step+status+comment for a single update, OR resume_from to reset all steps for a pipeline resume.",
      inputSchema: {
        type: "object",
        properties: {
          progress_post_id: {
            type: "string",
            description: "Progress table post ID",
          },
          step: {
            type: "string",
            enum: STEPS.filter((s) => s.id !== "jira-collector").map((s) => s.id),
            description: "Step ID to update",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "success", "error"],
            description: "New step status",
          },
          comment: {
            type: "string",
            description: 'Step comment (default: "—")',
          },
          resume_from: {
            type: "string",
            enum: STEPS.filter((s) => s.id !== "jira-collector").map((s) => s.id),
            description:
              "Resume mode: step to resume from. Sets all before to success, this to in_progress, all after to pending. Mutually exclusive with step/status.",
          },
        },
        required: ["progress_post_id"],
      },
    },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  try {
    const tool = TOOLS.find((t) => t.name === name);
    let args: Record<string, any> | undefined = rawArgs;
    if (tool) {
      try {
        args = validateArgs(tool.inputSchema, rawArgs);
      } catch (err) {
        if (err instanceof ToolArgError) {
          return {
            content: [
              { type: "text", text: `Invalid arguments for ${name}: ${err.message}` },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }
    switch (name) {
      case "send_message": {
        const { channel_id, message, root_id, subscribe_as } = args as {
          channel_id: string;
          message: string;
          root_id?: string;
          subscribe_as?: string;
        };

        // Auto-join channel if not a member yet
        await ensureChannelMembership(channel_id);

        const body: Record<string, unknown> = { channel_id, message };
        if (root_id) body.root_id = root_id;

        const post = await mmRequest<Post>("/posts", "POST", body);

        // Auto-subscribe: register session so poller monitors this thread
        if (subscribe_as && !root_id) {
          await registerThreadSession(post.id, subscribe_as, channel_id);
        }

        return {
          content: [
            {
              type: "text",
              text: `Message sent successfully!\n**Post ID:** ${post.id}\n**Channel:** ${post.channel_id}${root_id ? `\n**Thread:** ${root_id}` : ""}${subscribe_as && !root_id ? `\n**Subscribed:** ${subscribe_as} will handle thread replies` : ""}`,
            },
          ],
        };
      }

      case "get_posts": {
        const { channel_id, per_page = 30 } = args as {
          channel_id: string;
          per_page?: number;
        };

        const result = await mmRequest<PostsResponse>(
          `/channels/${seg(channel_id)}/posts?per_page=${encodeURIComponent(String(per_page))}`
        );

        if (!result.posts || Object.keys(result.posts).length === 0) {
          return {
            content: [{ type: "text", text: "No posts found in channel" }],
          };
        }

        const posts = result.order
          .map((id) => result.posts[id])
          .map((p) => {
            const date = new Date(p.create_at).toISOString();
            return `[${date}] (${p.id}) ${p.user_id}: ${p.message.substring(0, 100)}${p.message.length > 100 ? "..." : ""}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Posts in channel (${result.order.length}):\n\n${posts}`,
            },
          ],
        };
      }

      case "get_thread": {
        const { post_id } = args as { post_id: string };

        const result = await mmRequest<PostsResponse>(`/posts/${seg(post_id)}/thread`);

        if (!result.posts || Object.keys(result.posts).length === 0) {
          return {
            content: [{ type: "text", text: "Thread not found" }],
          };
        }

        const posts = result.order
          .map((id) => result.posts[id])
          .map((p) => {
            const date = new Date(p.create_at).toISOString();
            return `[${date}] (${p.id}) ${p.user_id}:\n${p.message}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Thread (${result.order.length} posts):\n\n${posts}`,
            },
          ],
        };
      }

      case "add_reaction": {
        const { post_id, emoji_name } = args as {
          post_id: string;
          emoji_name: string;
        };

        const me = await mmRequest<User>("/users/me");

        await mmRequest("/reactions", "POST", {
          user_id: me.id,
          post_id,
          emoji_name,
        });

        return {
          content: [
            {
              type: "text",
              text: `Reaction :${emoji_name}: added to post ${post_id}`,
            },
          ],
        };
      }

      case "get_user": {
        const { user_id, username } = args as {
          user_id?: string;
          username?: string;
        };

        let user: User;
        if (user_id) {
          user = await mmRequest<User>(`/users/${seg(user_id)}`);
        } else if (username) {
          user = await mmRequest<User>(`/users/username/${seg(username)}`);
        } else {
          return {
            content: [{ type: "text", text: "Either user_id or username is required" }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `**User:** @${user.username}\n**ID:** ${user.id}\n**Name:** ${user.first_name} ${user.last_name}\n**Email:** ${user.email}`,
            },
          ],
        };
      }

      case "get_channel": {
        const { channel_id } = args as { channel_id: string };

        const channel = await mmRequest<Channel>(`/channels/${seg(channel_id)}`);

        return {
          content: [
            {
              type: "text",
              text: `**Channel:** ${channel.display_name}\n**ID:** ${channel.id}\n**Name:** ${channel.name}\n**Type:** ${channel.type}\n**Team:** ${channel.team_id}`,
            },
          ],
        };
      }

      case "search_posts": {
        const { team_id, terms } = args as {
          team_id: string;
          terms: string;
        };

        const result = await mmRequest<PostsResponse>(
          `/teams/${seg(team_id)}/posts/search`,
          "POST",
          { terms }
        );

        if (!result.posts || Object.keys(result.posts).length === 0) {
          return {
            content: [{ type: "text", text: `No posts found for: "${terms}"` }],
          };
        }

        const posts = result.order
          .map((id) => result.posts[id])
          .map((p) => {
            const date = new Date(p.create_at).toISOString();
            return `[${date}] (${p.id}) ${p.user_id}:\n${p.message.substring(0, 200)}${p.message.length > 200 ? "..." : ""}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Search results (${result.order.length}):\n\n${posts}`,
            },
          ],
        };
      }

      case "get_me": {
        const user = await mmRequest<User>("/users/me");

        return {
          content: [
            {
              type: "text",
              text: `**Bot User:** @${user.username}\n**ID:** ${user.id}\n**Name:** ${user.first_name} ${user.last_name}`,
            },
          ],
        };
      }

      case "update_post": {
        const { post_id, message } = args as {
          post_id: string;
          message: string;
        };

        const post = await mmRequest<Post>(`/posts/${seg(post_id)}`, "PUT", {
          id: post_id,
          message,
        });

        return {
          content: [
            {
              type: "text",
              text: `Post updated successfully!\n**Post ID:** ${post.id}`,
            },
          ],
        };
      }

      case "delete_post": {
        const { post_id } = args as { post_id: string };

        await mmRequest(`/posts/${seg(post_id)}`, "DELETE");

        return {
          content: [
            {
              type: "text",
              text: `Post ${post_id} deleted successfully`,
            },
          ],
        };
      }

      // --- Merge notification tool handlers ---

      case "merge_create_notification": {
        const {
          issue_key,
          summary,
          issue_type,
          priority,
          components,
          assignee,
          labels,
          fix_versions,
          customer,
          contributors,
          context,
          channel_id,
        } = args as {
          issue_key: string;
          summary: string;
          issue_type: string;
          priority?: string;
          components?: string[];
          assignee?: string;
          labels?: string[];
          fix_versions?: string[];
          customer?: string;
          contributors?: Array<{ name: string; mm_mention: string; commits_count: number }>;
          context?: string;
          channel_id: string;
        };

        if (!channel_id) {
          return {
            content: [
              {
                type: "text",
                text: "Error: channel_id is required",
              },
            ],
            isError: true,
          };
        }

        // Summarize context via LLM
        let descriptionSummary: string | undefined;
        if (context) {
          descriptionSummary = await summarizeDescription(context);
        }

        // Format the notification message
        const message = formatNotification({
          issue_key,
          summary,
          issue_type,
          priority,
          components,
          assignee,
          labels,
          fix_versions,
          customer,
          contributors,
          descriptionSummary,
        });

        // Send to Mattermost
        await ensureChannelMembership(channel_id);
        const post = await mmRequest<Post>("/posts", "POST", {
          channel_id,
          message,
        });

        // Auto-subscribe for thread monitoring
        await registerThreadSession(post.id, "merge-checker", channel_id);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                postId: post.id,
                channelId: post.channel_id,
              }),
            },
          ],
        };
      }

      case "merge_update_status": {
        const { post_id, status } = args as {
          post_id: string;
          status: string;
        };

        const emoji = NOTIFICATION_STATUS_EMOJI[status];
        if (!emoji) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Unknown status "${status}". Valid: ${Object.keys(NOTIFICATION_STATUS_EMOJI).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        // Get current post text
        const currentPost = await mmRequest<Post>(`/posts/${seg(post_id)}`);
        const updatedMessage = currentPost.message.replace(/:loading1:/g, emoji);

        // Update post
        await mmRequest<Post>(`/posts/${seg(post_id)}`, "PUT", {
          id: post_id,
          message: updatedMessage,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ updated: true, emoji }),
            },
          ],
        };
      }

      case "merge_progress_init": {
        const { channel_id, root_id } = args as {
          channel_id: string;
          root_id: string;
        };

        // Create initial state
        const steps = createInitialSteps();
        const tableMessage = renderProgressTable(steps);

        // Send as thread reply
        await ensureChannelMembership(channel_id);
        const post = await mmRequest<Post>("/posts", "POST", {
          channel_id,
          root_id,
          message: tableMessage,
        });

        // Save state
        const state: ProgressState = {
          channelId: channel_id,
          rootId: root_id,
          steps,
        };
        saveProgressState(post.id, state);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ progressPostId: post.id }),
            },
          ],
        };
      }

      case "merge_progress_update": {
        const {
          progress_post_id,
          step,
          status,
          comment,
          resume_from,
        } = args as {
          progress_post_id: string;
          step?: string;
          status?: string;
          comment?: string;
          resume_from?: string;
        };

        // Load state (from file, or parse from MM post as fallback)
        let state = loadProgressState(progress_post_id);
        if (!state) {
          // Fallback: read post from MM and parse table
          const post = await mmRequest<Post>(`/posts/${seg(progress_post_id)}`);
          const parsed = parseProgressTable(post.message);
          if (parsed) {
            state = {
              channelId: post.channel_id,
              rootId: post.root_id,
              steps: parsed,
            };
          } else {
            // Last resort: create fresh state
            state = {
              channelId: post.channel_id,
              rootId: post.root_id,
              steps: createInitialSteps(),
            };
          }
        }

        if (resume_from) {
          // Resume mode: reset all steps relative to resume_from
          const resumeIdx = STEPS.findIndex((s) => s.id === resume_from);
          if (resumeIdx === -1) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Unknown step "${resume_from}"`,
                },
              ],
              isError: true,
            };
          }
          for (let i = 0; i < STEPS.length; i++) {
            const sid = STEPS[i].id;
            if (sid === "jira-collector") {
              state.steps[sid] = { status: "success", comment: "Данные собраны" };
            } else if (i < resumeIdx) {
              state.steps[sid] = { status: "success", comment: "—" };
            } else if (i === resumeIdx) {
              state.steps[sid] = {
                status: "in_progress",
                comment: "Повторная проверка...",
              };
            } else {
              state.steps[sid] = { status: "pending", comment: "—" };
            }
          }
        } else if (step && status) {
          // Single step update
          const validStep = STEPS.find((s) => s.id === step);
          if (!validStep) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Unknown step "${step}"`,
                },
              ],
              isError: true,
            };
          }
          state.steps[step] = { status, comment: comment || "—" };
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Error: Provide either step+status or resume_from",
              },
            ],
            isError: true,
          };
        }

        // Render and update
        const tableMessage = renderProgressTable(state.steps);
        await mmRequest<Post>(`/posts/${seg(progress_post_id)}`, "PUT", {
          id: progress_post_id,
          message: tableMessage,
        });

        // Save state
        saveProgressState(progress_post_id, state);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ updated: true }),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Mattermost MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
