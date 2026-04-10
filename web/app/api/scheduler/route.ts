import { getSchedulerStatus } from '@/lib/backend';

export async function GET() {
  try {
    const status = await getSchedulerStatus();
    return Response.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
