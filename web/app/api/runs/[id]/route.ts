import { getHistory } from '@/lib/backend';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const history = await getHistory();
  const record = await history.getById(parseInt(id, 10));

  if (!record) {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }

  return Response.json(record);
}
