import { getMcpServers } from '@/lib/backend';
import { McpToggle } from '@/components/mcp-toggle';
import { McpTestButton } from '@/components/mcp-test-button';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function McpPage() {
  const t = await getTranslations('mcp');
  const servers = await getMcpServers();

  return (
    <>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1 style={{ flex: 1 }}>{t('title')}</h1>
        <Link href="/mcp/new">
          <button className="btn btn-primary">{t('addServer')}</button>
        </Link>
      </div>

      {servers.length === 0 ? (
        <p className="empty-state">{t('emptyState')}</p>
      ) : (
        <table className="cs-table">
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('command')}</th>
              <th>{t('envVars')}</th>
              <th>{t('enabled')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.name}>
                <td>
                  <Link href={`/mcp/${encodeURIComponent(s.name)}/edit`} style={{ fontWeight: 500 }}>
                    {s.name}
                  </Link>
                </td>
                <td>
                  <code>{s.command} {s.args.join(' ')}</code>
                </td>
                <td>
                  {Object.keys(s.env).length > 0
                    ? Object.keys(s.env).join(', ')
                    : '-'}
                </td>
                <td>
                  <McpToggle name={s.name} initialEnabled={s.enabled} />
                </td>
                <td style={{ display: 'flex', gap: '0.5rem' }}>
                  <McpTestButton name={s.name} />
                  <Link href={`/mcp/${encodeURIComponent(s.name)}/edit`}>
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
