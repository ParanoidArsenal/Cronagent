import { getScheduler, getAutomations, setCronEnabled } from '@/lib/backend';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const decodedName = decodeURIComponent(name);

    const automations = await getAutomations();
    const automation = automations.find((a) => a.name === decodedName);

    if (!automation) {
      return Response.json({ error: 'Automation not found' }, { status: 404 });
    }
    if (automation.trigger !== 'cron' || !automation.schedule) {
      return Response.json({ error: 'Automation is not cron-triggered' }, { status: 400 });
    }

    const scheduler = await getScheduler();
    scheduler.startOne(automation);
    await setCronEnabled(decodedName, true);

    return Response.json({ enabled: true, name: decodedName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
