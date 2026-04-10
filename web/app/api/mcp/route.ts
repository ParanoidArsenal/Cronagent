import { getMcpServers, createMcpServer, getMcpServer } from '@/lib/backend';
import { McpServerInputSchema } from '@cronagent/history';

export async function GET() {
  try {
    const servers = await getMcpServers();
    return Response.json(servers);
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
