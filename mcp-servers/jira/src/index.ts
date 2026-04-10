#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";

// Configuration
interface JiraConfig {
  url: string;
  token: string;
  jsessionId?: string; // For downloading attachments
}

function loadConfig(): JiraConfig {
  const url = process.env.JIRA_URL;
  const token = process.env.JIRA_TOKEN;
  const jsessionId = process.env.JIRA_JSESSIONID;

  if (!url) {
    console.error("JIRA_URL environment variable is required");
    process.exit(1);
  }
  if (!token) {
    console.error("JIRA_TOKEN environment variable is required");
    process.exit(1);
  }

  return {
    url: url.replace(/\/$/, ""),
    token,
    jsessionId,
  };
}

const CONFIG = loadConfig();

// Jira API types
interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: string;
    status: { name: string; id: string };
    issuetype: { name: string; id: string };
    priority?: { name: string; id: string };
    assignee?: { displayName: string; name?: string };
    reporter: { displayName: string; name?: string };
    created: string;
    updated: string;
    project: { id: string; key: string; name: string };
    components?: Array<{ name: string }>;
    labels?: string[];
    attachment?: JiraAttachment[];
    issuelinks?: JiraIssueLink[];
    [key: string]: unknown;
  };
}

interface JiraAttachment {
  id: string;
  filename: string;
  content: string; // URL to download
  size: number;
  mimeType: string;
  author: { displayName: string };
  created: string;
}

interface JiraIssueLink {
  id: string;
  type: {
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: { key: string; fields: { summary: string; status: { name: string } } };
  outwardIssue?: { key: string; fields: { summary: string; status: { name: string } } };
}

interface JiraComment {
  id: string;
  author: { displayName: string; name?: string };
  body: string;
  created: string;
  updated: string;
}

interface JiraSearchResults {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
}

// HTTP request helper
async function jiraRequest<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown
): Promise<T> {
  const url = `${CONFIG.url}/rest/api/2${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${CONFIG.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira API error ${response.status}: ${errorText}`);
  }

  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }
  return {} as T;
}

// Download attachment using JSESSIONID cookie
async function downloadAttachment(
  contentUrl: string,
  outputPath: string
): Promise<{ success: boolean; path?: string; error?: string }> {
  if (!CONFIG.jsessionId) {
    return {
      success: false,
      error: "JIRA_JSESSIONID not set. Required for downloading attachments.",
    };
  }

  try {
    const response = await fetch(contentUrl, {
      headers: {
        Cookie: `JSESSIONID=${CONFIG.jsessionId}`,
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const buffer = await response.arrayBuffer();

    // Check if we got HTML (auth error) instead of the actual file
    const text = new TextDecoder().decode(buffer.slice(0, 100));
    if (text.includes("<!DOCTYPE") || text.includes("<html")) {
      return {
        success: false,
        error: "Got HTML instead of file - JSESSIONID may be expired",
      };
    }

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, Buffer.from(buffer));

    return { success: true, path: outputPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Format helpers
function formatIssue(issue: JiraIssue): string {
  const f = issue.fields;
  const lines = [
    `# ${issue.key}: ${f.summary}`,
    "",
    "## Metadata",
    `- **Status:** ${f.status.name}`,
    `- **Type:** ${f.issuetype.name}`,
    `- **Priority:** ${f.priority?.name || "None"}`,
    `- **Assignee:** ${f.assignee?.displayName || "Unassigned"}`,
    `- **Reporter:** ${f.reporter.displayName}`,
    `- **Project:** ${f.project.name} (${f.project.key})`,
    `- **Created:** ${f.created}`,
    `- **Updated:** ${f.updated}`,
  ];

  if (f.components && f.components.length > 0) {
    lines.push(`- **Components:** ${f.components.map((c) => c.name).join(", ")}`);
  }

  if (f.labels && f.labels.length > 0) {
    lines.push(`- **Labels:** ${f.labels.join(", ")}`);
  }

  if (f.description) {
    lines.push("", "## Description", "", f.description);
  }

  if (f.attachment && f.attachment.length > 0) {
    lines.push("", "## Attachments", "");
    for (const att of f.attachment) {
      lines.push(`- **${att.filename}** (${formatBytes(att.size)}) - ${att.mimeType}`);
    }
  }

  if (f.issuelinks && f.issuelinks.length > 0) {
    lines.push("", "## Linked Issues", "");
    for (const link of f.issuelinks) {
      if (link.outwardIssue) {
        lines.push(
          `- ${link.type.outward} **${link.outwardIssue.key}**: ${link.outwardIssue.fields.summary} [${link.outwardIssue.fields.status.name}]`
        );
      }
      if (link.inwardIssue) {
        lines.push(
          `- ${link.type.inward} **${link.inwardIssue.key}**: ${link.inwardIssue.fields.summary} [${link.inwardIssue.fields.status.name}]`
        );
      }
    }
  }

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatComment(comment: JiraComment): string {
  return `### ${comment.author.displayName} — ${comment.created}\n\n${comment.body}`;
}

// MCP Server
const server = new Server(
  {
    name: "jira-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "jira_get_issue_full",
      description:
        "Get comprehensive issue data in a single call: metadata, description, comments, linked issues, subtasks, parent (with description if subtask), and attachments. Returns structured JSON. Use this instead of multiple separate calls.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key (e.g., CAILA-1234)",
          },
          include_comments: {
            type: "boolean",
            description: "Include comments (default: true)",
          },
          max_comments: {
            type: "number",
            description:
              "Max comments to return, newest first (default: 50). Set 0 for all.",
          },
          include_linked_descriptions: {
            type: "boolean",
            description:
              "Fetch full description for each linked issue (extra API calls). Default: false.",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "jira_get_issue",
      description:
        "Get full issue details including description, attachments, and linked issues.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key (e.g., PROJ-123, ZB-12345)",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "jira_get_issue_raw",
      description:
        "Get raw issue JSON with all fields including custom fields. Useful for debugging.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key (e.g., PROJ-123)",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "jira_search",
      description: `Search issues using JQL (Jira Query Language).

**JQL examples:**
- \`project = PROJ AND status = Open\`
- \`assignee = currentUser() AND resolution = Unresolved\`
- \`created >= -7d AND priority = High\`
- \`text ~ "error message"\`
- \`component = "Backend" AND type = Bug\``,
      inputSchema: {
        type: "object",
        properties: {
          jql: {
            type: "string",
            description: "JQL query string",
          },
          max_results: {
            type: "number",
            description: "Maximum results to return (default: 50, max: 100)",
          },
          fields: {
            type: "array",
            items: { type: "string" },
            description:
              "Specific fields to return (default: summary, status, assignee, priority)",
          },
        },
        required: ["jql"],
      },
    },
    {
      name: "jira_get_comments",
      description: "Get all comments for an issue.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "jira_add_comment",
      description: "Add a comment to an issue.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key",
          },
          comment: {
            type: "string",
            description: "Comment text",
          },
        },
        required: ["issue_key", "comment"],
      },
    },
    {
      name: "jira_list_attachments",
      description:
        "List all attachments for an issue with download URLs and metadata.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "jira_download_attachment",
      description: `Download an attachment from Jira to local filesystem.

**IMPORTANT:** Requires JIRA_JSESSIONID environment variable to be set.
Jira Server does not support attachment download via PAT for /secure/ URLs.

To get JSESSIONID:
1. Open Jira in browser and log in
2. DevTools (F12) → Application → Cookies → jira.example.com
3. Copy JSESSIONID value`,
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key (used to get attachment list)",
          },
          filename: {
            type: "string",
            description: "Filename of the attachment to download",
          },
          output_dir: {
            type: "string",
            description:
              "Directory to save the file (default: /tmp/bugs/{issue_key}-attachments/)",
          },
        },
        required: ["issue_key", "filename"],
      },
    },
    {
      name: "jira_download_all_attachments",
      description: `Download all attachments from an issue to local filesystem.

**IMPORTANT:** Requires JIRA_JSESSIONID environment variable.`,
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key",
          },
          output_dir: {
            type: "string",
            description:
              "Directory to save files (default: /tmp/bugs/{issue_key}-attachments/)",
          },
          filter_images: {
            type: "boolean",
            description: "If true, only download image files (png, jpg, gif)",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "jira_get_transitions",
      description: "Get available status transitions for an issue.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "jira_transition_issue",
      description: "Move issue to another status using a transition.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key",
          },
          transition_id: {
            type: "string",
            description: "Transition ID (get from jira_get_transitions)",
          },
          comment: {
            type: "string",
            description: "Optional comment to add with the transition",
          },
        },
        required: ["issue_key", "transition_id"],
      },
    },
    {
      name: "jira_get_linked_issues",
      description:
        "Get all issues linked to the specified issue with their details.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Issue key",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "jira_create_issue",
      description:
        "Create a new Jira issue. For sub-tasks, provide parent_key.",
      inputSchema: {
        type: "object",
        properties: {
          project_key: {
            type: "string",
            description: "Project key (e.g., CAILA)",
          },
          summary: {
            type: "string",
            description: "Issue summary/title",
          },
          issuetype: {
            type: "string",
            description:
              'Issue type name (e.g., "Story", "Bug", "Sub-task")',
          },
          description: {
            type: "string",
            description: "Issue description (Jira wiki markup)",
          },
          parent_key: {
            type: "string",
            description:
              "Parent issue key (required for Sub-task type)",
          },
        },
        required: ["project_key", "summary", "issuetype"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "jira_get_issue_full": {
        const {
          issue_key,
          include_comments = true,
          max_comments = 50,
          include_linked_descriptions = false,
        } = args as {
          issue_key: string;
          include_comments?: boolean;
          max_comments?: number;
          include_linked_descriptions?: boolean;
        };

        // Fetch issue with all relevant fields in one call
        const issue = await jiraRequest<JiraIssue>(
          `/issue/${issue_key}?fields=summary,description,issuetype,status,priority,` +
            `assignee,reporter,creator,components,labels,fixVersions,versions,` +
            `issuelinks,subtasks,parent,comment,attachment,resolution,created,updated,resolutiondate`
        );

        const f = issue.fields;

        // Build result object
        const result: Record<string, unknown> = {
          key: issue.key,
          id: issue.id,
          url: `${CONFIG.url}/browse/${issue.key}`,
          summary: f.summary,
          description: f.description || null,
          issuetype: {
            name: f.issuetype.name,
            subtask: (f.issuetype as any).subtask ?? false,
          },
          status: f.status.name,
          priority: f.priority?.name || null,
          resolution: (f as any).resolution?.name || null,
          assignee: f.assignee
            ? {
                displayName: f.assignee.displayName,
                username: f.assignee.name || null,
              }
            : null,
          reporter: {
            displayName: f.reporter.displayName,
            username: f.reporter.name || null,
          },
          creator: (f as any).creator
            ? {
                displayName: (f as any).creator.displayName,
                username: (f as any).creator.name || null,
              }
            : null,
          components: (f.components || []).map((c: any) => c.name),
          labels: f.labels || [],
          fixVersions: ((f as any).fixVersions || []).map((v: any) => v.name),
          versions: ((f as any).versions || []).map((v: any) => v.name),
          created: (f as any).created,
          updated: (f as any).updated,
          resolutiondate: (f as any).resolutiondate || null,
        };

        // Parent: if subtask, fetch parent with description
        const parentRef = (f as any).parent;
        if (parentRef) {
          try {
            const parent = await jiraRequest<JiraIssue>(
              `/issue/${parentRef.key}?fields=summary,description,status,issuetype,priority`
            );
            result.parent = {
              key: parent.key,
              url: `${CONFIG.url}/browse/${parent.key}`,
              summary: parent.fields.summary,
              description: parent.fields.description || null,
              status: parent.fields.status.name,
              issuetype: parent.fields.issuetype.name,
              priority: parent.fields.priority?.name || null,
            };
          } catch {
            result.parent = {
              key: parentRef.key,
              summary: parentRef.fields?.summary || null,
              status: parentRef.fields?.status?.name || null,
            };
          }
        } else {
          result.parent = null;
        }

        // Subtasks
        const subtasks = (f as any).subtasks || [];
        result.subtasks = subtasks.map((st: any) => ({
          key: st.key,
          url: `${CONFIG.url}/browse/${st.key}`,
          summary: st.fields?.summary,
          status: st.fields?.status?.name,
          issuetype: st.fields?.issuetype?.name,
        }));

        // Linked issues
        const links = f.issuelinks || [];
        const linkedResults = [];
        for (const link of links) {
          const linkedIssue = link.outwardIssue || link.inwardIssue;
          const direction = link.outwardIssue ? "outward" : "inward";
          const relation = link.outwardIssue
            ? link.type.outward
            : link.type.inward;
          const entry: Record<string, unknown> = {
            relation,
            direction,
            linkType: link.type.name,
            key: linkedIssue?.key,
            url: linkedIssue
              ? `${CONFIG.url}/browse/${linkedIssue.key}`
              : null,
            summary: linkedIssue?.fields?.summary,
            status: linkedIssue?.fields?.status?.name,
          };
          if (include_linked_descriptions && linkedIssue?.key) {
            try {
              const full = await jiraRequest<JiraIssue>(
                `/issue/${linkedIssue.key}?fields=description`
              );
              entry.description = full.fields.description || null;
            } catch {
              entry.description = null;
            }
          }
          linkedResults.push(entry);
        }
        result.linkedIssues = linkedResults;

        // Comments
        if (include_comments) {
          const allComments: JiraComment[] =
            ((f as any).comment?.comments as JiraComment[]) || [];
          // newest first
          const sorted = [...allComments].reverse();
          const limited =
            max_comments > 0 ? sorted.slice(0, max_comments) : sorted;
          result.comments = limited.map((c) => ({
            author: c.author.displayName,
            username: c.author.name || null,
            created: c.created,
            body: c.body,
          }));
          result.totalComments = allComments.length;
        }

        // Attachments
        const attachments = f.attachment || [];
        result.attachments = attachments.map((att: JiraAttachment) => ({
          filename: att.filename,
          size: att.size,
          sizeFormatted: formatBytes(att.size),
          mimeType: att.mimeType,
          author: att.author.displayName,
          created: att.created,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "jira_get_issue": {
        const { issue_key } = args as { issue_key: string };
        const issue = await jiraRequest<JiraIssue>(
          `/issue/${issue_key}?expand=renderedFields`
        );
        return {
          content: [{ type: "text", text: formatIssue(issue) }],
        };
      }

      case "jira_get_issue_raw": {
        const { issue_key } = args as { issue_key: string };
        const issue = await jiraRequest<JiraIssue>(
          `/issue/${issue_key}?expand=renderedFields`
        );
        return {
          content: [{ type: "text", text: JSON.stringify(issue, null, 2) }],
        };
      }

      case "jira_search": {
        const { jql, max_results = 50, fields } = args as {
          jql: string;
          max_results?: number;
          fields?: string[];
        };

        const effectiveLimit = Math.min(max_results, 100);
        const body: Record<string, unknown> = {
          jql,
          startAt: 0,
          maxResults: effectiveLimit,
        };
        if (fields) {
          body.fields = fields;
        }

        const results = await jiraRequest<JiraSearchResults>(
          "/search",
          "POST",
          body
        );

        if (results.issues.length === 0) {
          return {
            content: [
              { type: "text", text: `No issues found for query: ${jql}` },
            ],
          };
        }

        const lines = [
          `# Search Results`,
          `**Query:** \`${jql}\``,
          `**Total:** ${results.total} (showing ${results.issues.length})`,
          "",
        ];

        for (const issue of results.issues) {
          lines.push(
            `## ${issue.key}: ${issue.fields.summary}`,
            `- Status: ${issue.fields.status.name}`,
            `- Type: ${issue.fields.issuetype.name}`,
            `- Priority: ${issue.fields.priority?.name || "None"}`,
            `- Assignee: ${issue.fields.assignee?.displayName || "Unassigned"}`,
            ""
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "jira_get_comments": {
        const { issue_key } = args as { issue_key: string };
        const response = await jiraRequest<{ comments: JiraComment[] }>(
          `/issue/${issue_key}/comment`
        );

        if (response.comments.length === 0) {
          return {
            content: [
              { type: "text", text: `No comments found for ${issue_key}` },
            ],
          };
        }

        const text = response.comments.map(formatComment).join("\n\n---\n\n");
        return {
          content: [
            {
              type: "text",
              text: `# Comments for ${issue_key}\n\n${text}`,
            },
          ],
        };
      }

      case "jira_add_comment": {
        const { issue_key, comment } = args as {
          issue_key: string;
          comment: string;
        };
        await jiraRequest(`/issue/${issue_key}/comment`, "POST", {
          body: comment,
        });
        return {
          content: [
            {
              type: "text",
              text: `Comment added successfully to ${issue_key}`,
            },
          ],
        };
      }

      case "jira_list_attachments": {
        const { issue_key } = args as { issue_key: string };
        const issue = await jiraRequest<JiraIssue>(
          `/issue/${issue_key}?fields=attachment,description`
        );

        const attachments = issue.fields.attachment || [];
        if (attachments.length === 0) {
          return {
            content: [
              { type: "text", text: `No attachments found for ${issue_key}` },
            ],
          };
        }

        const description = issue.fields.description || "";
        const lines = [
          `# Attachments for ${issue_key}`,
          "",
          "| Filename | Size | Type | Author | In Description |",
          "|----------|------|------|--------|----------------|",
        ];

        for (const att of attachments) {
          // Check if attachment is referenced in description [^filename]
          const inDesc = description.includes(`[^${att.filename}]`)
            ? "Yes"
            : "No";
          lines.push(
            `| ${att.filename} | ${formatBytes(att.size)} | ${att.mimeType} | ${att.author.displayName} | ${inDesc} |`
          );
        }

        lines.push(
          "",
          "## Download URLs",
          "",
          "Use `jira_download_attachment` or `jira_download_all_attachments` to download files.",
          ""
        );

        for (const att of attachments) {
          lines.push(`- **${att.filename}**: ${att.content}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "jira_download_attachment": {
        const { issue_key, filename, output_dir } = args as {
          issue_key: string;
          filename: string;
          output_dir?: string;
        };

        const issue = await jiraRequest<JiraIssue>(
          `/issue/${issue_key}?fields=attachment`
        );
        const attachments = issue.fields.attachment || [];
        const attachment = attachments.find((a) => a.filename === filename);

        if (!attachment) {
          return {
            content: [
              {
                type: "text",
                text: `Attachment "${filename}" not found in ${issue_key}. Available: ${attachments.map((a) => a.filename).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const dir = output_dir || `/tmp/bugs/${issue_key}-attachments`;
        const outputPath = path.join(dir, filename);
        const result = await downloadAttachment(attachment.content, outputPath);

        if (result.success) {
          return {
            content: [
              {
                type: "text",
                text: `Downloaded: ${filename}\nPath: ${result.path}\nSize: ${formatBytes(attachment.size)}`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Failed to download ${filename}: ${result.error}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "jira_download_all_attachments": {
        const { issue_key, output_dir, filter_images } = args as {
          issue_key: string;
          output_dir?: string;
          filter_images?: boolean;
        };

        const issue = await jiraRequest<JiraIssue>(
          `/issue/${issue_key}?fields=attachment`
        );
        let attachments = issue.fields.attachment || [];

        if (attachments.length === 0) {
          return {
            content: [
              { type: "text", text: `No attachments found for ${issue_key}` },
            ],
          };
        }

        if (filter_images) {
          const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
          attachments = attachments.filter((a) =>
            imageTypes.includes(a.mimeType)
          );
          if (attachments.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No image attachments found for ${issue_key}`,
                },
              ],
            };
          }
        }

        const dir = output_dir || `/tmp/bugs/${issue_key}-attachments`;
        const results: string[] = [
          `# Download Results for ${issue_key}`,
          `**Output directory:** ${dir}`,
          "",
        ];

        let successCount = 0;
        let failCount = 0;

        for (const att of attachments) {
          const outputPath = path.join(dir, att.filename);
          const result = await downloadAttachment(att.content, outputPath);

          if (result.success) {
            results.push(`✓ ${att.filename} (${formatBytes(att.size)})`);
            successCount++;
          } else {
            results.push(`✗ ${att.filename}: ${result.error}`);
            failCount++;
          }
        }

        results.push(
          "",
          `**Summary:** ${successCount} downloaded, ${failCount} failed`
        );

        return {
          content: [{ type: "text", text: results.join("\n") }],
          isError: failCount > 0 && successCount === 0,
        };
      }

      case "jira_get_transitions": {
        const { issue_key } = args as { issue_key: string };
        const response = await jiraRequest<{
          transitions: Array<{ id: string; name: string; to: { name: string } }>;
        }>(`/issue/${issue_key}/transitions`);

        const lines = [
          `# Available Transitions for ${issue_key}`,
          "",
          "| ID | Name | Target Status |",
          "|----|------|---------------|",
        ];

        for (const t of response.transitions) {
          lines.push(`| ${t.id} | ${t.name} | ${t.to.name} |`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "jira_transition_issue": {
        const { issue_key, transition_id, comment } = args as {
          issue_key: string;
          transition_id: string;
          comment?: string;
        };

        const body: Record<string, unknown> = {
          transition: { id: transition_id },
        };

        if (comment) {
          body.update = {
            comment: [{ add: { body: comment } }],
          };
        }

        await jiraRequest(`/issue/${issue_key}/transitions`, "POST", body);

        return {
          content: [
            {
              type: "text",
              text: `Issue ${issue_key} transitioned successfully`,
            },
          ],
        };
      }

      case "jira_get_linked_issues": {
        const { issue_key } = args as { issue_key: string };
        const issue = await jiraRequest<JiraIssue>(
          `/issue/${issue_key}?fields=issuelinks`
        );

        const links = issue.fields.issuelinks || [];
        if (links.length === 0) {
          return {
            content: [
              { type: "text", text: `No linked issues found for ${issue_key}` },
            ],
          };
        }

        const lines = [`# Linked Issues for ${issue_key}`, ""];

        for (const link of links) {
          if (link.outwardIssue) {
            const li = link.outwardIssue;
            lines.push(
              `## ${link.type.outward}: ${li.key}`,
              `**Summary:** ${li.fields.summary}`,
              `**Status:** ${li.fields.status.name}`,
              ""
            );
          }
          if (link.inwardIssue) {
            const li = link.inwardIssue;
            lines.push(
              `## ${link.type.inward}: ${li.key}`,
              `**Summary:** ${li.fields.summary}`,
              `**Status:** ${li.fields.status.name}`,
              ""
            );
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "jira_create_issue": {
        const { project_key, summary, issuetype, description, parent_key } =
          args as {
            project_key: string;
            summary: string;
            issuetype: string;
            description?: string;
            parent_key?: string;
          };

        const fields: Record<string, unknown> = {
          project: { key: project_key },
          summary,
          issuetype: { name: issuetype },
        };

        if (description) {
          fields.description = description;
        }

        if (parent_key) {
          fields.parent = { key: parent_key };
        }

        const result = await jiraRequest<{
          id: string;
          key: string;
          self: string;
        }>("/issue", "POST", { fields });

        return {
          content: [
            {
              type: "text",
              text: `Issue created: ${result.key}\nURL: ${CONFIG.url}/browse/${result.key}`,
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
  console.error("Jira MCP server running on stdio");
  console.error(`Jira URL: ${CONFIG.url}`);
  console.error(`JSESSIONID: ${CONFIG.jsessionId ? "configured" : "NOT SET (attachment download disabled)"}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
