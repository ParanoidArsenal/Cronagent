import { getHistory } from '@/lib/backend';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const automation = url.searchParams.get('automation') || undefined;
  const history = await getHistory();
  const conversations = await history.getConversationHistory(automation, 50);
  return Response.json(conversations);
}
