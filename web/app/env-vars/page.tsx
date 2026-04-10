import { getEnvVars } from '@/lib/backend';
import { EnvVarToggle } from '@/components/env-var-toggle';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function EnvVarsPage() {
  const t = await getTranslations('envVars');
  const vars = await getEnvVars();

  return (
    <>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1 style={{ flex: 1 }}>{t('title')}</h1>
        <Link href="/env-vars/new">
          <button className="btn btn-primary">{t('addVar')}</button>
        </Link>
      </div>

      {vars.length === 0 ? (
        <p className="empty-state">{t('emptyState')}</p>
      ) : (
        <table className="cs-table">
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('value')}</th>
              <th>{t('description')}</th>
              <th>{t('enabled')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => (
              <tr key={v.name}>
                <td>
                  <Link href={`/env-vars/${encodeURIComponent(v.name)}/edit`} style={{ fontWeight: 500 }}>
                    <code>{v.name}</code>
                  </Link>
                </td>
                <td>
                  <code style={{ opacity: 0.5 }}>{'••••••••'}</code>
                </td>
                <td>{v.description || '-'}</td>
                <td>
                  <EnvVarToggle name={v.name} initialEnabled={v.enabled} />
                </td>
                <td>
                  <Link href={`/env-vars/${encodeURIComponent(v.name)}/edit`}>
                    <button className="btn btn-sm">{t('edit')}</button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
