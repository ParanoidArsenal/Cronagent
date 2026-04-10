import { getHistory } from '@/lib/backend';
import { CostChart } from '@/components/cost-chart';
import { AgentStatsTable } from '@/components/agent-stats-table';
import { formatTokens } from '@/lib/format';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const t = await getTranslations('analytics');
  const history = await getHistory();
  const [usage7d, usage30d, agentStats] = await Promise.all([
    history.getUsageStats(7),
    history.getUsageStats(30),
    history.getAgentStats(),
  ]);

  const totalTokens = agentStats.reduce(
    (acc, a) => acc + Number(a.total_input_tokens) + Number(a.total_output_tokens),
    0,
  );
  const totalCost = agentStats.reduce((acc, a) => acc + a.total_cost, 0);
  const totalRuns = agentStats.reduce((acc, a) => acc + a.total_runs, 0);
  const avgSuccessRate =
    totalRuns > 0
      ? agentStats.reduce((acc, a) => acc + a.success_rate * a.total_runs, 0) / totalRuns
      : 0;

  return (
    <>
      <div className="page-header">
        <h1>{t('title')}</h1>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-card-label">{t('totalRuns')}</div>
          <div className="stat-card-value">{totalRuns}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('totalTokens')}</div>
          <div className="stat-card-value">{formatTokens(totalTokens)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('totalCost')}</div>
          <div className="stat-card-value">
            {totalCost > 0 ? `$${totalCost.toFixed(4)}` : '$0.00'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('avgSuccessRate')}</div>
          <div className="stat-card-value">
            {totalRuns > 0 ? `${avgSuccessRate.toFixed(1)}%` : '-'}
          </div>
        </div>
      </div>

      <h2 className="cs-section">{t('tokens7d')}</h2>
      <CostChart data={usage7d} title="" mode="tokens" />

      <h2 className="cs-section">{t('tokens30d')}</h2>
      <CostChart data={usage30d} title="" mode="tokens" />

      <h2 className="cs-section">{t('cost7d')}</h2>
      <CostChart data={usage7d} title="" mode="cost" />

      <h2 className="cs-section">{t('cost30d')}</h2>
      <CostChart data={usage30d} title="" mode="cost" />

      <h2 className="cs-section">{t('agentStats')}</h2>
      <AgentStatsTable data={agentStats} />
    </>
  );
}

