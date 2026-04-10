import { getHistory } from '@/lib/backend';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const history = await getHistory();
  const conversation = await history.getConversation(id);

  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }

  await history.closeConversation(id);
  return Response.json({ status: 'closed' });
}
