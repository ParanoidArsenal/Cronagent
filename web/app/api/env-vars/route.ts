import { getEnvVars, createEnvVar } from '@/lib/backend';
import { EnvVarInputSchema } from '@cronagent/history';

export async function GET() {
  try {
    const vars = await getEnvVars();
    // Omit secret values from list response
    const safe = vars.map(({ value: _v, ...rest }) => rest);
    return Response.json(safe);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = EnvVarInputSchema.safeParse(body);

    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return Response.json({ error: messages.join('; ') }, { status: 400 });
    }

    await createEnvVar(result.data);
    return Response.json({ created: true, name: result.data.name }, { status: 201 });
  } catch (err) {
    // Handle unique constraint violation (PostgreSQL error code 23505)
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      return Response.json({ error: 'An environment variable with this name already exists' }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
