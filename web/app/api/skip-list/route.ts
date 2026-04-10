import { getSkipListEntries, clearAllSkipEntries } from '@/lib/backend';

export async function GET() {
  try {
    const entries = await getSkipListEntries();
    return Response.json(entries);
  } catch (err) {
    console.error('[GET /api/skip-list]', err);
    return Response.json({ error: 'Failed to load skip list' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await clearAllSkipEntries();
    return Response.json({ cleared: true });
  } catch (err) {
    console.error('[DELETE /api/skip-list]', err);
    return Response.json({ error: 'Failed to clear skip list' }, { status: 500 });
  }
}
