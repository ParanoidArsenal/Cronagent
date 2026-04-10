import { getAutomations, getHistory, saveAutomation, parseAutomationInput } from '@/lib/backend';

export async function GET() {
  const automations = await getAutomations();
  const history = await getHistory();

  const enriched = await Promise.all(
    automations.map(async (a) => ({
      name: a.name,
      description: a.description,
      mode: a.mode,
      trigger: a.trigger,
      schedule: a.schedule,
      timeout: a.timeout,
      mcp: a.mcp,
      model: a.model,
      filePath: a.filePath,
      lastRun: (await history.getLastRun(a.name)) ?? null,
    })),
  );

  return Response.json(enriched);
}

export async function POST(req: Request) {
  try {
    const raw = await req.json();
    const parsed = parseAutomationInput(raw);
    if (!parsed.success) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed.data;

    // Composed automations can only be edited, not created through the API
    if (body.mode === 'composed') {
      return Response.json({ error: 'Composed automations cannot be created through the API — edit existing YAML files instead' }, { status: 400 });
    }

    // Check for duplicate names
    const existing = await getAutomations();
    if (existing.some((a) => a.name === body.name)) {
      return Response.json({ error: 'An automation with this name already exists' }, { status: 409 });
    }

    const { filePath } = await saveAutomation(body);
    return Response.json({ name: body.name, filePath }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
