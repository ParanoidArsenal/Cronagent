import { getHistory } from '@/lib/backend';
import { readFile } from 'node:fs/promises';

const PLAIN_TEXT_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  // Polling clients (live log streaming for in-flight runs) need fresh
  // content on every request — never let a CDN/browser cache the body.
  'Cache-Control': 'no-store',
};

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

  if (!record.log_file) {
    return Response.json({ error: 'No log file for this run' }, { status: 404 });
  }

  try {
    const content = await readFile(record.log_file, 'utf-8');
    return new Response(content, { headers: PLAIN_TEXT_HEADERS });
  } catch (err) {
    // For in-flight runs the runner persists the path before the first line
    // is appended, so a polling client may race the file's existence. Return
    // an empty body instead of 404 so the LogViewer can render an empty
    // timeline and keep polling, rather than showing an error toast.
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return new Response('', { headers: PLAIN_TEXT_HEADERS });
    }
    return Response.json({ error: 'Log file not readable' }, { status: 500 });
  }
}
