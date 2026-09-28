import { getMcpServers, createMcpServer, getMcpServer } from '@/lib/backend';
import { McpServerInputSchema } from '@cronagent/history';
import { MCP_ENV_MASK, redactMcpServer } from '@/app/mcp/mcp-secrets';

export async function GET() {
  try {
    const servers = await getMcpServers();
    // Mask secret env values in list response (keys are kept)
    return Response.json(servers.map(redactMcpServer));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = McpServerInputSchema.safeParse(body);

    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return Response.json({ error: messages.join('; ') }, { status: 400 });
    }

    // Reject the redaction mask as a literal value — there is nothing stored to restore
    const masked = Object.keys(result.data.env).filter((k) => result.data.env[k] === MCP_ENV_MASK);
    if (masked.length > 0) {
      return Response.json({ error: `env: masked value has no stored secret for ${masked.join(', ')}` }, { status: 400 });
    }

    // Check for duplicate name
    const existing = await getMcpServer(result.data.name);
    if (existing) {
      return Response.json({ error: 'An MCP server with this name already exists' }, { status: 409 });
    }

    await createMcpServer(result.data);
    return Response.json({ created: true, name: result.data.name }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
