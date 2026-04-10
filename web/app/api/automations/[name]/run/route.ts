import { triggerRun, isRunning, stopRun } from '@/lib/backend';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  let newConversation = false;
  try {
    const body = await req.json();
    newConversation = body?.newConversation === true;
  } catch {
    // No body or invalid JSON — that's fine
  }
  const result = await triggerRun(name, { newConversation });

  if (!result.started) {
    const status = result.reason === 'throttled' ? 429
      : result.reason === 'already_running' ? 409
      : 404;
    return Response.json({ error: result.error }, { status });
  }

  return Response.json({ status: 'started', automation: name, runId: result.runId });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const status = isRunning(name);
  return Response.json(status);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const stopped = stopRun(name);
  if (!stopped) {
    return Response.json({ error: 'Not running' }, { status: 404 });
  }
  return Response.json({ status: 'stopped', automation: name });
}
