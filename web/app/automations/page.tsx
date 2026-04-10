import { getAutomations, getHistory, getSkippedNames } from '@/lib/backend';
import { StatusBadge, ModeBadge, TriggerBadge, SkipBadge } from '@/components/status-badge';
import { RunButton } from '@/components/run-button';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function AutomationsPage() {
  const t = await getTranslations('automations');
  const automations = await getAutomations();
  const history = await getHistory();
  const skippedNames = await getSkippedNames();

  const lastRuns = new Map<string, boolean>();
  for (const a of automations) {
    const lr = await history.getLastRun(a.name);
    if (lr) lastRuns.set(a.name, !!lr.success);
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1 style={{ flex: 1 }}>{t('title')}</h1>
        <Link href="/automations/new">
          <button className="btn btn-primary">{t('newAutomation')}</button>
        </Link>
      </div>

      <table className="cs-table">
        <thead>
          <tr>
            <th>{t('name')}</th>
            <th>{t('description')}</th>
            <th>{t('mode')}</th>
            <th>{t('trigger')}</th>
            <th>{t('lastRun')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {automations.map((a) => (
              <tr key={a.name}>
                <td>
                  <Link href={`/automations/${encodeURIComponent(a.name)}`} style={{ fontWeight: 500 }}>
                    {a.name}
                  </Link>
                </td>
                <td>{a.description}</td>
                <td>
                  <ModeBadge mode={a.mode} />
                </td>
                <td>
                  <TriggerBadge trigger={a.trigger} schedule={a.schedule} />
                </td>
                <td>
                  {skippedNames.has(a.name) && <SkipBadge />}
                  {' '}
                  {lastRuns.has(a.name) ? <StatusBadge success={lastRuns.get(a.name)!} /> : '-'}
                </td>
                <td>
                  <RunButton name={a.name} />
                </td>
              </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
