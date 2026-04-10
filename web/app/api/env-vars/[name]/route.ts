import { getEnvVar, updateEnvVar, deleteEnvVar, setEnvVarEnabled } from '@/lib/backend';
import { EnvVarInputSchema } from '@cronagent/history';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const decodedName = decodeURIComponent(name);

    const envVar = await getEnvVar(decodedName);
    if (!envVar) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    // Omit secret value from API response
    const { value: _v, ...safe } = envVar;
    return Response.json(safe);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const decodedName = decodeURIComponent(name);
    const body = await req.json();

    // Support partial update for toggle (just enabled field)
    if (Object.keys(body).length === 1 && typeof body.enabled === 'boolean') {
      const updated = await setEnvVarEnabled(decodedName, body.enabled);
      if (!updated) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      return Response.json({ updated: true });
    }

    const result = EnvVarInputSchema.safeParse(body);
    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return Response.json({ error: messages.join('; ') }, { status: 400 });
    }

    if (result.data.name !== decodedName) {
      return Response.json({ error: 'Cannot rename an environment variable' }, { status: 400 });
    }

    const updated = await updateEnvVar(decodedName, result.data);
    if (!updated) {
      return Response.json({ error: 'Environment variable not found' }, { status: 404 });
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
  try {
    const { name } = await params;
    const decodedName = decodeURIComponent(name);

    const deleted = await deleteEnvVar(decodedName);
    if (!deleted) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
