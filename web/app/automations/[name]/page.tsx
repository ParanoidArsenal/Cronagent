import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAutomations, getHistory, getSchedulerStatus, isComposedAutomation, getSkippedNames } from '@/lib/backend';
import { ModeBadge, TriggerBadge, SkipBadge } from '@/components/status-badge';
import { RunButton } from '@/components/run-button';
import { DeleteButton } from '@/components/delete-button';
import { AutoRefresh } from '@/components/auto-refresh';
import { SkipRetryButton } from '@/components/skip-retry-button';
import { CronToggle } from '@/components/cron-toggle';
import { HistoryTable } from '@/components/history-table';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function AutomationDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const t = await getTranslations('automationDetail');
  const { name } = await params;
  const decodedName = decodeURIComponent(name);

  const automations = await getAutomations();
  const automation = automations.find((a) => a.name === decodedName);

  if (!automation) {
    notFound();
  }

  const history = await getHistory();
  const runs = await history.getHistory(decodedName, 20);
  const conversations = automation.conversation
    ? await history.getConversationHistory(decodedName, 10)
    : [];

  // Fetch cron state for cron-triggered automations
  let cronEnabled = false;
  let cronNextRun: string | null = null;
  if (automation.trigger === 'cron' && automation.schedule) {
    const statuses = await getSchedulerStatus();
    const job = statuses.find((s) => s.name === decodedName);
    cronEnabled = job?.enabled ?? false;
    cronNextRun = job?.nextRun ?? null;
  }

  const skippedNames = await getSkippedNames();
  const isSkipped = skippedNames.has(decodedName);

  const isComposed = isComposedAutomation(automation.instructions);
  let composeSteps: string[] = [];
  if (isComposed) {
    try {
      composeSteps = JSON.parse(automation.instructions).compose ?? [];
    } catch {
      // invalid JSON
    }
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1 style={{ flex: 1 }}>{automation.name}</h1>
        <Link href={`/automations/${encodeURIComponent(automation.name)}/edit`}>
          <button className="btn btn-secondary">{t('edit')}</button>
        </Link>
        <RunButton name={automation.name} />
        <DeleteButton name={automation.name} />
      </div>

      {automation.description && (
        <p style={{ color: 'var(--cs-text-dim)', marginTop: 0, marginBottom: '1.5rem' }}>
          {automation.description}
        </p>
      )}

      {isSkipped && (
        <div className="callout callout-orange" style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ flex: 1 }}>
            <SkipBadge /> {t('skipBanner')}
          </div>
          <SkipRetryButton name={decodedName} />
        </div>
      )}

      <div className="meta-grid">
        <span className="meta-label">{t('mode')}</span>
        <span className="meta-value">
          <ModeBadge mode={isComposed ? 'composed' : automation.mode} />
        </span>

        <span className="meta-label">{t('trigger')}</span>
        <span className="meta-value">
          <TriggerBadge trigger={automation.trigger} schedule={automation.schedule} />
        </span>

        <span className="meta-label">{t('timeout')}</span>
        <span className="meta-value">{automation.timeout}s</span>

        <span className="meta-label">{t('sandbox')}</span>
        <span className="meta-value">{automation.sandbox ? '✔' : '✘'}</span>

        {automation.conversation && (
          <>
            <span className="meta-label">{t('conversation')}</span>
            <span className="meta-value">✔</span>
          </>
        )}

        {automation.mcp.length > 0 && (
          <>
            <span className="meta-label">{t('mcpServers')}</span>
            <span className="meta-value">
              {automation.mcp.map((m) => (
                <code key={m} style={{ marginRight: '0.25rem' }}>
                  {m}
                </code>
              ))}
            </span>
          </>
        )}

        {(automation.mode === 'claude' || automation.mode === 'caila') && (
          <>
            <span className="meta-label">{t('model')}</span>
            <span className="meta-value">
              <code>{automation.model}</code>
            </span>
          </>
        )}

        {automation.maxRetries > 0 && (
          <>
            <span className="meta-label">{t('maxRetries')}</span>
            <span className="meta-value">{automation.maxRetries}</span>

            <span className="meta-label">{t('retryDelayMs')}</span>
            <span className="meta-value">{automation.retryDelayMs}ms</span>
          </>
        )}

        <span className="meta-label">{t('file')}</span>
        <span className="meta-value">
          <code>{automation.filePath}</code>
        </span>
      </div>

      {automation.trigger === 'cron' && automation.schedule && (
        <div style={{ margin: '1.5rem 0' }}>
          <h2 className="cs-section">{t('cronSchedule')}</h2>
          <CronToggle
            name={automation.name}
            initialEnabled={cronEnabled}
            schedule={automation.schedule}
            initialNextRun={cronNextRun}
          />
        </div>
      )}

      {isComposed ? (
        <>
          <h2 className="cs-section">{t('steps')}</h2>
          <div className="callout callout-amber" style={{ marginBottom: '1rem' }}>
            {t('composedCallout')}
          </div>
          <ol style={{ paddingLeft: '1.5rem', marginBottom: '2rem' }}>
            {composeSteps.map((step, i) => (
              <li key={i} style={{ marginBottom: '0.25rem' }}>
                <code>{step}</code>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <h2 className="cs-section">
            {automation.mode === 'shell' ? t('steps') : t('instructions')}
          </h2>
          <div className="output-block" style={{ marginBottom: '2rem' }}>
            {automation.instructions}
          </div>
        </>
      )}

      {conversations.length > 0 && (
        <>
          <h2 className="cs-section">{t('conversations')}</h2>
          <table className="cs-table" style={{ marginBottom: '2rem' }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Turns</th>
                <th>Cost</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/conversations/${c.id}`}>
                      <span className={`badge ${c.closed ? 'badge-fail' : 'badge-ok'}`}>
                        {c.closed ? 'Closed' : 'Active'}
                      </span>
                    </Link>
                  </td>
                  <td>{c.total_turns}</td>
                  <td>{c.total_cost_usd > 0 ? `$${c.total_cost_usd.toFixed(4)}` : '-'}</td>
                  <td>{String(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2 className="cs-section">{t('runHistory')}</h2>
      <HistoryTable records={runs} showName={false} />
      <AutoRefresh intervalMs={15_000} />
    </>
  );
}
