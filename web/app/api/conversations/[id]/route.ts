import { getHistory } from '@/lib/backend';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const history = await getHistory();
  const conversation = await history.getConversation(id);

  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const messages = await history.getConversationMessages(id);
  return Response.json({ ...conversation, messages });
}
