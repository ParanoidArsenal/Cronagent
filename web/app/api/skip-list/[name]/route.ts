import { clearSkipEntry } from '@/lib/backend';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const decodedName = decodeURIComponent(name);
    await clearSkipEntry(decodedName);
    return Response.json({ cleared: true, name: decodedName });
  } catch (err) {
    console.error('[DELETE /api/skip-list/[name]]', err);
    return Response.json({ error: 'Failed to clear skip entry' }, { status: 500 });
  }
}
