#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.example.com";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;

if (!GITLAB_TOKEN) {
  console.error("GITLAB_TOKEN environment variable is required");
  process.exit(1);
}

// ==================== GitLab API ====================

async function gitlabRequest(
  method: string,
  endpoint: string,
  body?: any
): Promise<any> {
  const url = `${GITLAB_URL}/api/v4${endpoint}`;
  const headers: Record<string, string> = {
    "PRIVATE-TOKEN": GITLAB_TOKEN!,
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitLab API ${method} ${endpoint}: ${res.status} ${text}`
    );
  }
  return res.json();
}

// ==================== GitLab MR helpers ====================

interface GitLabMR {
  id: number;
  iid: number;
  title: string;
  description?: string;
  state: string;
  source_branch: string;
  target_branch: string;
  web_url: string;
  project_id: number;
  head_pipeline?: {
    id: number;
    status: string;
    web_url: string;
  } | null;
  merge_status: string;
  detailed_merge_status?: string;
  has_conflicts: boolean;
  author?: { username: string };
  diff_refs?: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  } | null;
}

async function searchMergeRequests(issueKey: string): Promise<GitLabMR[]> {
  const searchResults = await gitlabRequest(
    "GET",
    `/merge_requests?scope=all&state=opened&search=${encodeURIComponent(issueKey)}&per_page=50`
  );

  if (!Array.isArray(searchResults) || searchResults.length === 0) {
    return [];
  }

  const keyLower = issueKey.toLowerCase();
  const matching = searchResults.filter((mr: any) =>
    mr.source_branch.toLowerCase().includes(keyLower)
  );

  const detailed: GitLabMR[] = [];
  for (const mr of matching) {
    try {
      const full = await gitlabRequest(
        "GET",
        `/projects/${mr.project_id}/merge_requests/${mr.iid}`
      );
      detailed.push(full);
    } catch {
      detailed.push(mr);
    }
  }

  return detailed;
}

function formatMR(mr: GitLabMR) {
  return {
    iid: mr.iid,
    project_id: mr.project_id,
    title: mr.title,
    description: mr.description || "",
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    web_url: mr.web_url,
    state: mr.state,
    merge_status: mr.merge_status,
    detailed_merge_status: mr.detailed_merge_status,
    has_conflicts: mr.has_conflicts,
    author: mr.author?.username,
    head_pipeline: mr.head_pipeline
      ? {
          id: mr.head_pipeline.id,
          status: mr.head_pipeline.status,
          web_url: mr.head_pipeline.web_url,
        }
      : null,
    diff_refs: mr.diff_refs
      ? {
          base_sha: mr.diff_refs.base_sha,
          head_sha: mr.diff_refs.head_sha,
          start_sha: mr.diff_refs.start_sha,
        }
      : null,
  };
}

// ==================== MCP Server ====================

const server = new Server(
  { name: "gitlab-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // --- Merge Requests ---
    {
      name: "search_merge_requests",
      description:
        "Search for open merge requests by Jira issue key. Finds MRs whose source_branch contains the issue key. Returns full MR details including pipeline status and diff_refs.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Jira issue key (e.g. CAILA-1234)",
          },
        },
        required: ["issue_key"],
      },
    },
    {
      name: "get_merge_request",
      description:
        "Get full details of a specific merge request including pipeline status and diff_refs (base_sha, head_sha, start_sha).",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
        },
        required: ["project_id", "iid"],
      },
    },
    {
      name: "get_merge_request_approvals",
      description:
        "Get approval status of a merge request. Returns list of approvers and whether the MR has enough approvals.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
        },
        required: ["project_id", "iid"],
      },
    },
    {
      name: "get_merge_request_changes",
      description:
        "Get the list of changed files and diffs for a merge request. Returns file paths, diff content, and change type (new/renamed/deleted) for each file.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
        },
        required: ["project_id", "iid"],
      },
    },
    {
      name: "accept_merge_request",
      description:
        "Merge (accept) a merge request. The MR must be in a mergeable state with a passing pipeline.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
          squash: {
            type: "boolean",
            description: "Whether to squash commits (default: false)",
          },
          should_remove_source_branch: {
            type: "boolean",
            description:
              "Whether to remove source branch after merge (default: true)",
          },
        },
        required: ["project_id", "iid"],
      },
    },
    {
      name: "create_merge_request",
      description:
        "Create a new merge request in a GitLab project. Accepts project_path (e.g., 'docs/documentation_CAILA') which is URL-encoded internally.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: {
            type: "string",
            description:
              "GitLab project path (e.g., 'docs/documentation_CAILA')",
          },
          source_branch: {
            type: "string",
            description: "Source branch name",
          },
          target_branch: {
            type: "string",
            description: "Target branch name (default: release)",
          },
          title: {
            type: "string",
            description: "MR title",
          },
          description: {
            type: "string",
            description: "MR description (Markdown)",
          },
        },
        required: ["project_path", "source_branch", "title"],
      },
    },
    {
      name: "update_merge_request",
      description:
        "Update a merge request's title and/or description.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
          title: {
            type: "string",
            description: "New MR title (optional, omit to keep current)",
          },
          description: {
            type: "string",
            description: "New MR description in Markdown (optional, omit to keep current)",
          },
        },
        required: ["project_id", "iid"],
      },
    },
    // --- List My MRs ---
    {
      name: "list_my_merge_requests",
      description:
        "List merge requests created by the authenticated user. Supports filtering by state (opened/merged/all) and date. Use this to get an overview of your own MRs across all projects.",
      inputSchema: {
        type: "object",
        properties: {
          state: {
            type: "string",
            description:
              "MR state filter: 'opened', 'merged', 'closed', or 'all'. Default: 'opened'.",
            enum: ["opened", "merged", "closed", "all"],
          },
          updated_after: {
            type: "string",
            description:
              "Only return MRs updated after this ISO 8601 date (e.g. '2026-04-01T00:00:00Z'). Optional.",
          },
          merged_after: {
            type: "string",
            description:
              "Only return MRs merged after this ISO 8601 date. Only applies when state is 'merged'. Optional.",
          },
          per_page: {
            type: "number",
            description: "Number of results per page (max 100). Default: 50.",
          },
        },
        required: [],
      },
    },
    // --- Readiness Check ---
    {
      name: "check_merge_readiness",
      description:
        "Check merge readiness for all open MRs of a Jira issue. Returns combined build (pipeline) status, approval status, conflict info, and links for each MR in a single call. If wait_for_pipelines is true, polls until all running/pending pipelines complete (up to timeout). Use this instead of calling search_merge_requests + get_merge_request_approvals separately.",
      inputSchema: {
        type: "object",
        properties: {
          issue_key: {
            type: "string",
            description: "Jira issue key (e.g. CAILA-1234)",
          },
          wait_for_pipelines: {
            type: "boolean",
            description:
              "If true, wait for running/pending pipelines to finish before returning. Default: false.",
          },
          poll_interval: {
            type: "number",
            description:
              "Polling interval in seconds when waiting for pipelines. Default: 30.",
          },
          timeout: {
            type: "number",
            description:
              "Max wait time in seconds for pipelines to finish. Default: 600 (10 min).",
          },
        },
        required: ["issue_key"],
      },
    },
    // --- Discussions ---
    {
      name: "list_mr_discussions",
      description:
        "List all discussions on a merge request. Returns array of discussions with notes, authors, and resolved status.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
        },
        required: ["project_id", "iid"],
      },
    },
    {
      name: "create_mr_discussion",
      description:
        "Create a new discussion on a merge request. Can be a general comment or a line-level comment on a specific diff line (provide position object for line-level).",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
          body: {
            type: "string",
            description: "Discussion body (Markdown)",
          },
          position: {
            type: "object",
            description:
              "Position for line-level comments. Omit for general discussions.",
            properties: {
              base_sha: {
                type: "string",
                description: "Base commit SHA from diff_refs",
              },
              start_sha: {
                type: "string",
                description: "Start commit SHA from diff_refs",
              },
              head_sha: {
                type: "string",
                description: "Head commit SHA from diff_refs",
              },
              position_type: {
                type: "string",
                description: "Type of position (always 'text' for line comments)",
                enum: ["text"],
              },
              new_path: {
                type: "string",
                description: "File path in the new version",
              },
              new_line: {
                type: "number",
                description: "Line number in the new version of the file",
              },
              old_path: {
                type: "string",
                description: "File path in the old version",
              },
              old_line: {
                type: "number",
                description: "Line number in the old version of the file",
              },
            },
            required: [
              "base_sha",
              "start_sha",
              "head_sha",
              "position_type",
            ],
          },
        },
        required: ["project_id", "iid", "body"],
      },
    },
    {
      name: "resolve_mr_discussion",
      description:
        "Resolve or unresolve a discussion on a merge request.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
          discussion_id: {
            type: "string",
            description: "Discussion ID",
          },
          resolved: {
            type: "boolean",
            description: "Whether to resolve (true) or unresolve (false) the discussion",
          },
        },
        required: ["project_id", "iid", "discussion_id", "resolved"],
      },
    },
    {
      name: "add_discussion_note",
      description:
        "Add a reply/note to an existing discussion on a merge request.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "number",
            description: "GitLab project ID",
          },
          iid: {
            type: "number",
            description: "Merge request IID (project-scoped ID)",
          },
          discussion_id: {
            type: "string",
            description: "Discussion ID",
          },
          body: {
            type: "string",
            description: "Note body (Markdown)",
          },
        },
        required: ["project_id", "iid", "discussion_id", "body"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // --- Merge Requests ---

      case "search_merge_requests": {
        const { issue_key } = args as { issue_key: string };
        const mrs = await searchMergeRequests(issue_key);

        if (mrs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No open merge requests found for issue key: ${issue_key}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(mrs.map(formatMR), null, 2),
            },
          ],
        };
      }

      case "get_merge_request": {
        const { project_id, iid } = args as {
          project_id: number;
          iid: number;
        };
        const mr = await gitlabRequest(
          "GET",
          `/projects/${project_id}/merge_requests/${iid}`
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatMR(mr), null, 2),
            },
          ],
        };
      }

      case "get_merge_request_approvals": {
        const { project_id, iid } = args as {
          project_id: number;
          iid: number;
        };
        const approvals = await gitlabRequest(
          "GET",
          `/projects/${project_id}/merge_requests/${iid}/approvals`
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  approved: approvals.approved,
                  approvals_required: approvals.approvals_required,
                  approvals_left: approvals.approvals_left,
                  approved_by: (approvals.approved_by || []).map(
                    (a: any) => ({
                      username: a.user?.username,
                      name: a.user?.name,
                    })
                  ),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_merge_request_changes": {
        const { project_id, iid } = args as {
          project_id: number;
          iid: number;
        };
        const mrWithChanges = await gitlabRequest(
          "GET",
          `/projects/${project_id}/merge_requests/${iid}/changes`
        );

        const changes = (mrWithChanges.changes || []).map((c: any) => ({
          old_path: c.old_path,
          new_path: c.new_path,
          new_file: c.new_file || false,
          renamed_file: c.renamed_file || false,
          deleted_file: c.deleted_file || false,
          diff: c.diff,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  iid: mrWithChanges.iid,
                  title: mrWithChanges.title,
                  web_url: mrWithChanges.web_url,
                  source_branch: mrWithChanges.source_branch,
                  target_branch: mrWithChanges.target_branch,
                  changes_count: changes.length,
                  changes,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "accept_merge_request": {
        const {
          project_id,
          iid,
          squash,
          should_remove_source_branch,
        } = args as {
          project_id: number;
          iid: number;
          squash?: boolean;
          should_remove_source_branch?: boolean;
        };

        const result = await gitlabRequest(
          "PUT",
          `/projects/${project_id}/merge_requests/${iid}/merge`,
          {
            squash: squash ?? false,
            should_remove_source_branch:
              should_remove_source_branch ?? true,
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  state: result.state,
                  merged_by: result.merged_by?.username,
                  web_url: result.web_url,
                  merge_commit_sha: result.merge_commit_sha,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "create_merge_request": {
        const { project_path, source_branch, target_branch, title, description } =
          args as {
            project_path: string;
            source_branch: string;
            target_branch?: string;
            title: string;
            description?: string;
          };

        const encodedPath = encodeURIComponent(project_path);
        const result = await gitlabRequest(
          "POST",
          `/projects/${encodedPath}/merge_requests`,
          {
            source_branch,
            target_branch: target_branch || "release",
            title,
            description: description || "",
          }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  iid: result.iid,
                  web_url: result.web_url,
                  state: result.state,
                  title: result.title,
                  project_id: result.project_id,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "update_merge_request": {
        const { project_id, iid, title, description } = args as {
          project_id: number;
          iid: number;
          title?: string;
          description?: string;
        };

        const updateBody: Record<string, string> = {};
        if (title !== undefined) updateBody.title = title;
        if (description !== undefined) updateBody.description = description;

        if (Object.keys(updateBody).length === 0) {
          throw new Error("At least one of title or description must be provided");
        }

        const result = await gitlabRequest(
          "PUT",
          `/projects/${project_id}/merge_requests/${iid}`,
          updateBody
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  iid: result.iid,
                  title: result.title,
                  description: result.description,
                  web_url: result.web_url,
                  state: result.state,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // --- List My MRs ---

      case "list_my_merge_requests": {
        const { state, updated_after, merged_after, per_page } = args as {
          state?: string;
          updated_after?: string;
          merged_after?: string;
          per_page?: number;
        };

        const params = new URLSearchParams();
        params.set("scope", "created_by_me");
        params.set("state", state || "opened");
        params.set("per_page", String(per_page || 50));
        if (updated_after) params.set("updated_after", updated_after);
        if (merged_after && (state === "merged" || state === "all")) {
          params.set("merged_after", merged_after);
        }

        const mrs: GitLabMR[] = await gitlabRequest(
          "GET",
          `/merge_requests?${params.toString()}`
        );

        if (mrs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No merge requests found (state: ${state || "opened"})`,
              },
            ],
          };
        }

        const formatted = mrs.map((mr) => ({
          ...formatMR(mr),
          references: (mr as any).references?.full,
          updated_at: (mr as any).updated_at,
          merged_at: (mr as any).merged_at,
          created_at: (mr as any).created_at,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      }

      // --- Readiness Check ---

      case "check_merge_readiness": {
        const { issue_key, wait_for_pipelines, poll_interval, timeout } =
          args as {
            issue_key: string;
            wait_for_pipelines?: boolean;
            poll_interval?: number;
            timeout?: number;
          };

        const shouldWait = wait_for_pipelines ?? false;
        const intervalSec = poll_interval ?? 30;
        const timeoutSec = timeout ?? 600;

        const mrs = await searchMergeRequests(issue_key);

        if (mrs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  issueKey: issue_key,
                  ready_to_merge: false,
                  builds_ok: false,
                  approvals_ok: false,
                  has_conflicts: false,
                  status: "no_mrs",
                  mrs: [],
                }, null, 2),
              },
            ],
          };
        }

        // If waiting for pipelines, poll until all are in a terminal state
        let currentMRs = mrs;
        if (shouldWait) {
          const TERMINAL_STATUSES = new Set([
            "success",
            "failed",
            "canceled",
            "skipped",
            "manual",
          ]);
          const startTime = Date.now();
          const timeoutMs = timeoutSec * 1000;

          while (Date.now() - startTime < timeoutMs) {
            const hasPending = currentMRs.some(
              (mr) =>
                mr.head_pipeline != null &&
                !TERMINAL_STATUSES.has(mr.head_pipeline.status)
            );
            if (!hasPending) break;

            console.error(
              `[check_merge_readiness] Pipelines still running for ${issue_key}, waiting ${intervalSec}s...`
            );
            await new Promise((resolve) =>
              setTimeout(resolve, intervalSec * 1000)
            );

            // Re-fetch MR details to get updated pipeline status
            const refreshed: GitLabMR[] = [];
            for (const mr of currentMRs) {
              try {
                const full = await gitlabRequest(
                  "GET",
                  `/projects/${mr.project_id}/merge_requests/${mr.iid}`
                );
                refreshed.push(full);
              } catch {
                refreshed.push(mr);
              }
            }
            currentMRs = refreshed;
          }
        }

        const mrResults = await Promise.all(
          currentMRs.map(async (mr) => {
            let approvals: any = {};
            try {
              approvals = await gitlabRequest(
                "GET",
                `/projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`
              );
            } catch {
              approvals = {
                approved: false,
                approvals_required: 0,
                approvals_left: 0,
                approved_by: [],
              };
            }

            const pipelineOk = mr.head_pipeline?.status === "success";
            const approved = approvals.approved === true;
            const approvedBy = (approvals.approved_by || [])
              .map((a: any) => a.user?.username)
              .filter(Boolean);

            return {
              iid: mr.iid,
              project_id: mr.project_id,
              title: mr.title,
              web_url: mr.web_url,
              source_branch: mr.source_branch,
              target_branch: mr.target_branch,
              author: mr.author?.username,
              merge_status: mr.merge_status,
              detailed_merge_status: mr.detailed_merge_status,
              has_conflicts: mr.has_conflicts,
              pipeline: mr.head_pipeline
                ? {
                    status: mr.head_pipeline.status,
                    url: mr.head_pipeline.web_url,
                  }
                : null,
              pipeline_ok: pipelineOk,
              approvals: {
                approved,
                approvals_required: approvals.approvals_required ?? 0,
                approvals_left: approvals.approvals_left ?? 0,
                approved_by: approvedBy,
              },
            };
          })
        );

        const buildsOk = mrResults.every((mr) => mr.pipeline_ok);
        const approvalsOk = mrResults.every((mr) => mr.approvals.approved);
        const hasConflicts = mrResults.some((mr) => mr.has_conflicts);
        const readyToMerge = buildsOk && approvalsOk && !hasConflicts;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  issueKey: issue_key,
                  ready_to_merge: readyToMerge,
                  builds_ok: buildsOk,
                  approvals_ok: approvalsOk,
                  has_conflicts: hasConflicts,
                  status: readyToMerge ? "ready" : "not_ready",
                  mrs: mrResults,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // --- Discussions ---

      case "list_mr_discussions": {
        const { project_id, iid } = args as {
          project_id: number;
          iid: number;
        };

        const discussions = await gitlabRequest(
          "GET",
          `/projects/${project_id}/merge_requests/${iid}/discussions?per_page=100`
        );

        const formatted = (discussions as any[]).map((d: any) => ({
          id: d.id,
          individual_note: d.individual_note,
          notes: (d.notes || []).map((n: any) => ({
            id: n.id,
            body: n.body,
            author: n.author
              ? { username: n.author.username, name: n.author.name }
              : null,
            resolved: n.resolved ?? null,
            resolvable: n.resolvable ?? false,
            position: n.position
              ? {
                  new_path: n.position.new_path,
                  new_line: n.position.new_line,
                  old_path: n.position.old_path,
                  old_line: n.position.old_line,
                  position_type: n.position.position_type,
                }
              : null,
            created_at: n.created_at,
          })),
          resolved: d.notes?.some((n: any) => n.resolvable)
            ? d.notes.filter((n: any) => n.resolvable).every((n: any) => n.resolved)
            : null,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      }

      case "create_mr_discussion": {
        const { project_id, iid, body, position } = args as {
          project_id: number;
          iid: number;
          body: string;
          position?: {
            base_sha: string;
            start_sha: string;
            head_sha: string;
            position_type: string;
            new_path?: string;
            new_line?: number;
            old_path?: string;
            old_line?: number;
          };
        };

        const requestBody: any = { body };
        if (position) {
          requestBody.position = {
            base_sha: position.base_sha,
            start_sha: position.start_sha,
            head_sha: position.head_sha,
            position_type: position.position_type,
          };
          if (position.new_path !== undefined) {
            requestBody.position.new_path = position.new_path;
          }
          if (position.new_line !== undefined) {
            requestBody.position.new_line = position.new_line;
          }
          if (position.old_path !== undefined) {
            requestBody.position.old_path = position.old_path;
          }
          if (position.old_line !== undefined) {
            requestBody.position.old_line = position.old_line;
          }
        }

        const result = await gitlabRequest(
          "POST",
          `/projects/${project_id}/merge_requests/${iid}/discussions`,
          requestBody
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: result.id,
                  individual_note: result.individual_note,
                  notes: (result.notes || []).map((n: any) => ({
                    id: n.id,
                    body: n.body,
                    author: n.author
                      ? { username: n.author.username, name: n.author.name }
                      : null,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "resolve_mr_discussion": {
        const { project_id, iid, discussion_id, resolved } = args as {
          project_id: number;
          iid: number;
          discussion_id: string;
          resolved: boolean;
        };

        const result = await gitlabRequest(
          "PUT",
          `/projects/${project_id}/merge_requests/${iid}/discussions/${discussion_id}`,
          { resolved }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: result.id,
                  resolved: result.notes?.some((n: any) => n.resolvable)
                    ? result.notes
                        .filter((n: any) => n.resolvable)
                        .every((n: any) => n.resolved)
                    : null,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "add_discussion_note": {
        const { project_id, iid, discussion_id, body } = args as {
          project_id: number;
          iid: number;
          discussion_id: string;
          body: string;
        };

        const result = await gitlabRequest(
          "POST",
          `/projects/${project_id}/merge_requests/${iid}/discussions/${discussion_id}/notes`,
          { body }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: result.id,
                  body: result.body,
                  author: result.author
                    ? {
                        username: result.author.username,
                        name: result.author.name,
                      }
                    : null,
                  created_at: result.created_at,
                },
                null,
                2
              ),
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
  console.error("GitLab MCP server running on stdio (v1)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
