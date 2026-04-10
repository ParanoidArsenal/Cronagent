import { getAutomations, saveAutomation, deleteAutomation, parseAutomationInput, getScheduler, setCronEnabled } from '@/lib/backend';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);
  const automations = await getAutomations();
  const automation = automations.find((a) => a.name === decodedName);

  if (!automation) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  return Response.json(automation);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);

  try {
    const raw = await req.json();
    const parsed = parseAutomationInput(raw);
    if (!parsed.success) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed.data;

    const automations = await getAutomations();
    const existing = automations.find((a) => a.name === decodedName);
    if (!existing) {
      return Response.json({ error: 'Automation not found' }, { status: 404 });
    }

    // If name changed, check for duplicates
    if (body.name !== decodedName && automations.some((a) => a.name === body.name)) {
      return Response.json({ error: 'An automation with this name already exists' }, { status: 409 });
    }

    const { filePath } = await saveAutomation(body, existing.filePath);
    return Response.json({ name: body.name, filePath });
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

  // Stop cron job before deleting the file
  try {
    const scheduler = await getScheduler();
    scheduler.stopOne(decodedName);
    await setCronEnabled(decodedName, false);
  } catch {
    // Scheduler may not be initialized (e.g. web-only mode) — continue with deletion
  }

  const deleted = await deleteAutomation(decodedName);
  if (!deleted) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  return Response.json({ deleted: true });
}
