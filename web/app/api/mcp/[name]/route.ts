import { getMcpServer, updateMcpServer, deleteMcpServer, setMcpServerEnabled } from '@/lib/backend';
import { McpServerInputSchema } from '@cronagent/history';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);

  try {
    const server = await getMcpServer(decodedName);
    if (!server) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json(server);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);

  try {
    const body = await req.json();

    // Support partial update for toggle (just enabled field)
    if (Object.keys(body).length === 1 && typeof body.enabled === 'boolean') {
      const updated = await setMcpServerEnabled(decodedName, body.enabled);
      if (!updated) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      return Response.json({ updated: true });
    }

    const result = McpServerInputSchema.safeParse(body);
    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return Response.json({ error: messages.join('; ') }, { status: 400 });
    }

    const updated = await updateMcpServer(decodedName, result.data);
    if (!updated) {
      return Response.json({ error: 'MCP server not found' }, { status: 404 });
    }

    return Response.json({ updated: true, name: result.data.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);

  try {
    const deleted = await deleteMcpServer(decodedName);
    if (!deleted) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
