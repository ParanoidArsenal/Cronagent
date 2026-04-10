import { sendConversationMessage, isMessageSending } from '@/lib/backend';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let message = '';
  try {
    const body = await req.json();
    message = typeof body?.message === 'string' ? body.message.trim() : '';
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!message) {
    return Response.json({ error: 'Message is required' }, { status: 400 });
  }

  const result = await sendConversationMessage(id, message);

  if (!result.started) {
    const status = result.error?.includes('not found') ? 404
      : result.error?.includes('closed') ? 422
      : result.error?.includes('Already sending') ? 409
      : 400;
    return Response.json({ error: result.error }, { status });
  }

  return Response.json({ status: 'started' });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const status = isMessageSending(id);
  return Response.json(status);
}
