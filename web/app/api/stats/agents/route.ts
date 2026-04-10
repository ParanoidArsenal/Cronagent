import { getHistory } from '@/lib/backend';

export async function GET() {
  try {
    const history = await getHistory();
    const data = await history.getAgentStats();

    return Response.json({ data });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
