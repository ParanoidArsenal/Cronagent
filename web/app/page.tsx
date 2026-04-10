import { getAutomations, getHistory, getUsageTracker, getBudgetConfig, getSkippedNames } from '@/lib/backend';
import { HistoryTable } from '@/components/history-table';
import { StatusBadge, ModeBadge, SkipBadge } from '@/components/status-badge';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const t = await getTranslations('dashboard');
  const automations = await getAutomations();
  const history = await getHistory();
  const recentRuns = await history.getHistory(undefined, 10);
  const totalCost = await history.getTotalCost();

  const budgetConfig = await getBudgetConfig();
  const tracker = await getUsageTracker();
  const budgetPrediction = budgetConfig.enabled
    ? await tracker.predict(budgetConfig)
    : null;

  const successCount = recentRuns.filter((r) => r.success).length;

  const skippedNames = await getSkippedNames();

  const lastRuns = new Map<string, boolean>();
  for (const a of automations) {
    const lr = await history.getLastRun(a.name);
    if (lr) lastRuns.set(a.name, !!lr.success);
  }

  return (
    <>
      <div className="page-header">
        <h1>{t('title')}</h1>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-card-label">{t('automations')}</div>
          <div className="stat-card-value">{automations.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('totalRuns')}</div>
          <div className="stat-card-value">{recentRuns.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('successRate')}</div>
          <div className="stat-card-value">
            {recentRuns.length > 0
              ? `${Math.round((successCount / recentRuns.length) * 100)}%`
              : '-'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('totalCost')}</div>
          <div className="stat-card-value">
            {totalCost > 0 ? `$${totalCost.toFixed(4)}` : '$0.00'}
          </div>
        </div>
        {budgetPrediction && (
          <>
            <div className="stat-card">
              <div className="stat-card-label">{t('todaySpent')}</div>
              <div className="stat-card-value">
                ${budgetPrediction.todaySpent.toFixed(4)}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card-label">{t('budgetRemaining')}</div>
              <div className="stat-card-value">
                ${budgetPrediction.remaining.toFixed(4)}
              </div>
            </div>
          </>
        )}
      </div>

      <h2 className="cs-section">{t('automationsSection')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '2rem' }}>
        {automations.map((a) => (
            <Link
              key={a.name}
              href={`/automations/${encodeURIComponent(a.name)}`}
              className="automation-card"
            >
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 500, color: 'var(--cs-text-bright)' }}>{a.name}</span>
                <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--cs-text-dim)' }}>
                  {a.description}
                </span>
              </div>
              <ModeBadge mode={a.mode} />
              {skippedNames.has(a.name) && <SkipBadge />}
              {lastRuns.has(a.name) && <StatusBadge success={lastRuns.get(a.name)!} />}
            </Link>
        ))}
      </div>

      <h2 className="cs-section">{t('recentRuns')}</h2>
      <HistoryTable records={recentRuns} />
    </>
  );
}
