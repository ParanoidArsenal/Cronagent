import { getAutomations, getHistory } from '@/lib/backend';

export async function GET() {
  const automations = await getAutomations();
  const history = await getHistory();

  const recentRuns = await history.getHistory(undefined, 5);
  const totalCost = await history.getTotalCost();

  const successCount = recentRuns.filter((r) => r.success).length;
  const failCount = recentRuns.length - successCount;

  return Response.json({
    automationCount: automations.length,
    totalCost,
    recentRuns,
    successCount,
    failCount,
  });
}
