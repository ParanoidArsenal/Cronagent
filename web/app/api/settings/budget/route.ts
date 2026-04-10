import { getBudgetConfig, setBudgetConfig } from '@/lib/backend';
import { BudgetConfigSchema } from '@cronagent/history';

export async function GET() {
  const config = await getBudgetConfig();
  return Response.json(config);
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const result = BudgetConfigSchema.safeParse(body);

    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return Response.json({ error: messages.join('; ') }, { status: 400 });
    }

    await setBudgetConfig(result.data);
    return Response.json({ saved: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
