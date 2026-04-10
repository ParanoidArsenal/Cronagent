import { getHistory } from '@/lib/backend';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get('name') ?? undefined;
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);

  const history = await getHistory();
  const records = await history.getHistory(name, limit);

  return Response.json(records);
}
