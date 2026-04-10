#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Configuration
interface CailaConfig {
  baseUrl: string;
  apiKey?: string;
}

function loadConfig(): CailaConfig {
  const baseUrl = process.env.CAILA_BASE_URL || "https://caila.io";
  const apiKey = process.env.CAILA_API_KEY;

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
  };
}

const CONFIG = loadConfig();

// Types
interface ServiceId {
  accountId: number;
  modelId: number;
}

interface PublicSettings {
  isPublic: boolean;
  allowedAccounts: number[];
  featured: boolean;
  featuredListOrder: number;
  hidden: boolean;
  publicTestingAllowed: boolean;
  showPersonalDataDisclaimer: boolean;
}

interface BillingSettings {
  isBillingEnabled: boolean;
  billingUnit: string;
  billingUnitPriceInNanoToken: number;
  billingUnitPriceInCurrency: number;
  freeUnitQuota: number;
  allowDeferredBilling: boolean;
}

interface ResourceLimits {
  cpuRequest: string;
  memoryLimit: string;
  ephemeralDiskLimit: string;
  gpuRequested: boolean;
  gpuMemoryLimitMb: number | null;
  gpuUsageLimit: number | null;
  gpuCount: number | null;
}

interface AutoScalingConfiguration {
  minInstanceCount: number;
  maxInstanceCount: number | null;
  enabled: boolean;
}

interface CailaService {
  id: ServiceId;
  modelType: string;
  modelAccountName: string;
  modelAccountDisplayName: string;
  modelName: string;
  displayName: string;
  displayAuthor: string;
  imageAccountId: number;
  imageId: number;
  taskType: string;
  config: string;
  env: string;
  additionalFlags: string[];
  hostingType: string;
  protocols: string[];
  resourceGroup: string;
  resourceLimits: ResourceLimits;
  autoScalingConfiguration: AutoScalingConfiguration;
  shortDescription: string;
  languages: string[];
  minInstancesCount: number;
  publicSettings: PublicSettings;
  billingSettings: BillingSettings;
  state: string;
  lastActivity: number | null;
  favorite: boolean;
}

interface ServiceListResponse {
  paging: {
    totalElements: number;
    totalPages: number;
    pageNumber: number;
    pageSize: number;
  };
  records: CailaService[];
}

// HTTP request helper
async function cailaRequest<T>(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: unknown
): Promise<T> {
  const url = `${CONFIG.baseUrl}${endpoint}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
  };

  if (CONFIG.apiKey) {
    headers["MLP-API-KEY"] = CONFIG.apiKey;
  }

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
    throw new Error(`CAILA API error ${response.status}: ${errorText}`);
  }

  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }

  // For text responses (like documentation)
  return response.text() as unknown as T;
}

// Format helpers
function formatServiceShort(service: CailaService): string {
  const stateEmoji = service.state === "RUNNING" ? "+" : "-";
  const billing = service.billingSettings.isBillingEnabled
    ? `${service.billingSettings.billingUnitPriceInNanoToken} nanoToken/${service.billingSettings.billingUnit}`
    : "free";

  return `[${stateEmoji}] ${service.modelAccountName}/${service.modelName} - ${service.displayName} (${service.taskType}, ${billing})`;
}

function formatServiceFull(service: CailaService): string {
  const lines = [
    `# ${service.displayName}`,
    "",
    "## Basic Info",
    `- **ID:** ${service.id.accountId}/${service.id.modelId}`,
    `- **Account:** ${service.modelAccountDisplayName} (${service.modelAccountName})`,
    `- **Name:** ${service.modelName}`,
    `- **Author:** ${service.displayAuthor}`,
    `- **Task Type:** ${service.taskType}`,
    `- **State:** ${service.state}`,
    `- **Hosting:** ${service.hostingType}`,
    `- **Protocols:** ${service.protocols.join(", ")}`,
    "",
    "## Description",
    service.shortDescription || "No description",
    "",
    "## Resource Configuration",
    `- **Resource Group:** ${service.resourceGroup}`,
    `- **CPU Request:** ${service.resourceLimits.cpuRequest}`,
    `- **Memory Limit:** ${service.resourceLimits.memoryLimit}`,
    `- **GPU Requested:** ${service.resourceLimits.gpuRequested}`,
  ];

  if (service.resourceLimits.gpuCount) {
    lines.push(`- **GPU Count:** ${service.resourceLimits.gpuCount}`);
  }

  lines.push(
    "",
    "## Auto Scaling",
    `- **Enabled:** ${service.autoScalingConfiguration.enabled}`,
    `- **Min Instances:** ${service.autoScalingConfiguration.minInstanceCount}`,
    `- **Max Instances:** ${service.autoScalingConfiguration.maxInstanceCount || "unlimited"}`
  );

  lines.push(
    "",
    "## Public Settings",
    `- **Is Public:** ${service.publicSettings.isPublic}`,
    `- **Featured:** ${service.publicSettings.featured}`,
    `- **Hidden:** ${service.publicSettings.hidden}`,
    `- **Public Testing Allowed:** ${service.publicSettings.publicTestingAllowed}`
  );

  lines.push(
    "",
    "## Billing",
    `- **Enabled:** ${service.billingSettings.isBillingEnabled}`,
    `- **Unit:** ${service.billingSettings.billingUnit}`,
    `- **Price:** ${service.billingSettings.billingUnitPriceInNanoToken} nanoToken`,
    `- **Free Quota:** ${service.billingSettings.freeUnitQuota}`
  );

  // Parse env if present
  if (service.env && service.env !== "{}") {
    try {
      const envObj = JSON.parse(service.env);
      if (Object.keys(envObj).length > 0) {
        lines.push("", "## Environment Variables");
        for (const [key, value] of Object.entries(envObj)) {
          lines.push(`- **${key}:** ${value}`);
        }
      }
    } catch {
      lines.push("", "## Environment (raw)", "```", service.env, "```");
    }
  }

  // Parse config if present
  if (service.config && service.config !== "{}" && service.config !== "") {
    try {
      const configObj = JSON.parse(service.config);
      if (Object.keys(configObj).length > 0) {
        lines.push("", "## Config");
        lines.push("```json", JSON.stringify(configObj, null, 2), "```");
      }
    } catch {
      lines.push("", "## Config (raw)", "```", service.config, "```");
    }
  }

  if (service.additionalFlags && service.additionalFlags.length > 0) {
    lines.push("", "## Additional Flags");
    for (const flag of service.additionalFlags) {
      lines.push(`- \`${flag}\``);
    }
  }

  if (service.lastActivity) {
    const date = new Date(service.lastActivity);
    lines.push("", `**Last Activity:** ${date.toISOString()}`);
  }

  return lines.join("\n");
}

// MCP Server
const server = new Server(
  {
    name: "caila-mcp",
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
      name: "caila_list_public_services",
      description: `List all public services available on CAILA platform.

Returns a list of publicly available ML services with their basic info:
- Service name and display name
- Task type (chat-completion, embeddings, etc.)
- State (RUNNING/INACTIVE)
- Billing info`,
      inputSchema: {
        type: "object",
        properties: {
          page: {
            type: "number",
            description: "Page number (0-based, default: 0)",
          },
          size: {
            type: "number",
            description: "Page size (default: 100, max: 1000)",
          },
          task_type: {
            type: "string",
            description: "Filter by task type (e.g., chat-completion, embeddings)",
          },
          state: {
            type: "string",
            enum: ["RUNNING", "INACTIVE"],
            description: "Filter by service state",
          },
        },
        required: [],
      },
    },
    {
      name: "caila_get_service",
      description: `Get detailed information about a specific CAILA service.

Returns full service configuration including:
- Resource limits (CPU, memory, GPU)
- Auto-scaling settings
- Environment variables
- Billing configuration
- Public/private settings`,
      inputSchema: {
        type: "object",
        properties: {
          account_id: {
            type: "number",
            description: "Account ID of the service owner",
          },
          model_id: {
            type: "number",
            description: "Model/Service ID",
          },
        },
        required: ["account_id", "model_id"],
      },
    },
    {
      name: "caila_get_service_doc",
      description: `Get documentation for a specific CAILA service.

Returns markdown documentation describing:
- How to use the service
- API endpoints and parameters
- Input/output formats
- Examples`,
      inputSchema: {
        type: "object",
        properties: {
          account_id: {
            type: "number",
            description: "Account ID of the service owner",
          },
          model_id: {
            type: "number",
            description: "Model/Service ID",
          },
        },
        required: ["account_id", "model_id"],
      },
    },
    {
      name: "caila_search_services",
      description: `Search for services by name or description.

Searches through public services and returns matching results.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (matches against name, display name, description)",
          },
          task_type: {
            type: "string",
            description: "Filter by task type (e.g., chat-completion, embeddings)",
          },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "caila_list_public_services": {
        const { page = 0, size = 100, task_type, state } = args as {
          page?: number;
          size?: number;
          task_type?: string;
          state?: string;
        };

        const effectiveSize = Math.min(size, 1000);
        const response = await cailaRequest<ServiceListResponse>(
          `/api/mlpcore/models?onlyPublic=true&page=${page}&size=${effectiveSize}`
        );

        let services = response.records;

        // Apply filters
        if (task_type) {
          services = services.filter(s => s.taskType === task_type);
        }
        if (state) {
          services = services.filter(s => s.state === state);
        }

        const lines = [
          `# Public CAILA Services`,
          "",
          `**Total:** ${response.paging.totalElements} services`,
          `**Page:** ${page + 1}/${response.paging.totalPages}`,
          `**Showing:** ${services.length} services`,
          "",
          "## Services",
          "",
          "Legend: [+] RUNNING, [-] INACTIVE",
          "",
        ];

        // Group by task type
        const byTaskType = new Map<string, CailaService[]>();
        for (const service of services) {
          const existing = byTaskType.get(service.taskType) || [];
          existing.push(service);
          byTaskType.set(service.taskType, existing);
        }

        for (const [taskType, taskServices] of byTaskType) {
          lines.push(`### ${taskType} (${taskServices.length})`);
          for (const service of taskServices) {
            lines.push(formatServiceShort(service));
          }
          lines.push("");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "caila_get_service": {
        const { account_id, model_id } = args as {
          account_id: number;
          model_id: number;
        };

        // Fetch service info and documentation in parallel
        const [service, doc] = await Promise.all([
          cailaRequest<CailaService>(
            `/api/mlpcore/account/${account_id}/model/${model_id}`
          ),
          cailaRequest<string>(
            `/api/mlpcore/account/${account_id}/model/${model_id}/simple-doc`
          ).catch(() => null), // Documentation may not exist
        ]);

        let result = formatServiceFull(service);

        // Append documentation if available
        if (doc && doc.trim() !== "") {
          result += "\n\n---\n\n# Documentation\n\n" + doc;
        }

        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "caila_get_service_doc": {
        const { account_id, model_id } = args as {
          account_id: number;
          model_id: number;
        };

        const doc = await cailaRequest<string>(
          `/api/mlpcore/account/${account_id}/model/${model_id}/simple-doc`
        );

        if (!doc || doc.trim() === "") {
          return {
            content: [{ type: "text", text: `No documentation available for service ${account_id}/${model_id}` }],
          };
        }

        return {
          content: [{ type: "text", text: doc }],
        };
      }

      case "caila_search_services": {
        const { query, task_type } = args as {
          query: string;
          task_type?: string;
        };

        // Fetch all public services and filter
        const response = await cailaRequest<ServiceListResponse>(
          `/api/mlpcore/models?onlyPublic=true&page=0&size=1000`
        );

        const queryLower = query.toLowerCase();
        let matches = response.records.filter(service => {
          const searchText = [
            service.modelName,
            service.displayName,
            service.shortDescription,
            service.modelAccountName,
            service.displayAuthor,
          ].filter(Boolean).join(" ").toLowerCase();

          return searchText.includes(queryLower);
        });

        if (task_type) {
          matches = matches.filter(s => s.taskType === task_type);
        }

        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: `No services found matching "${query}"` }],
          };
        }

        const lines = [
          `# Search Results for "${query}"`,
          "",
          `**Found:** ${matches.length} services`,
          "",
        ];

        for (const service of matches) {
          lines.push(
            `## ${service.displayName}`,
            `- **ID:** ${service.id.accountId}/${service.id.modelId}`,
            `- **Name:** ${service.modelAccountName}/${service.modelName}`,
            `- **Task Type:** ${service.taskType}`,
            `- **State:** ${service.state}`,
            `- **Description:** ${service.shortDescription || "N/A"}`,
            ""
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
  console.error("CAILA MCP server running on stdio");
  console.error(`CAILA URL: ${CONFIG.baseUrl}`);
  console.error(`API Key: ${CONFIG.apiKey ? "configured" : "not set (public endpoints only)"}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
