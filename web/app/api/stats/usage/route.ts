import { getHistory } from '@/lib/backend';

function parsePeriodDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  if (match) {
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) ? Math.max(1, Math.min(n, 365)) : 7;
  }
  return 7;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const period = url.searchParams.get('period') ?? '7d';
    const days = parsePeriodDays(period);

    const history = await getHistory();
    const data = await history.getUsageStats(days);

    return Response.json({ period: `${days}d`, data });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
