import { generateAutomationContent } from '@/lib/backend';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const description = typeof body?.description === 'string' ? body.description.trim() : '';

    if (!description || description.length < 5) {
      return Response.json(
        { error: 'Description must be at least 5 characters' },
        { status: 400 },
      );
    }

    const result = await generateAutomationContent(description);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generation failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
