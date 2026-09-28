import { getMcpServer, updateMcpServer, deleteMcpServer, setMcpServerEnabled } from '@/lib/backend';
import { McpServerInputSchema } from '@cronagent/history';
import { redactMcpServer, restoreMaskedEnv } from '@/app/mcp/mcp-secrets';

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
    // Mask secret env values (keys are kept)
    return Response.json(redactMcpServer(server));
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

    // Env values equal to the redaction mask mean "keep the stored value"
    const existing = await getMcpServer(decodedName);
    if (!existing) {
      return Response.json({ error: 'MCP server not found' }, { status: 404 });
    }
    const { env, unresolved } = restoreMaskedEnv(result.data.env, existing.env);
    if (unresolved.length > 0) {
      return Response.json({ error: `env: masked value has no stored secret for ${unresolved.join(', ')}` }, { status: 400 });
    }

    const updated = await updateMcpServer(decodedName, { ...result.data, env });
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
