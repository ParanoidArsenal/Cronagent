'use client';

import Link from 'next/link';
import { StatusBadge } from './status-badge';
import type { RunRecord } from '@/lib/backend';
import { useTranslations, useLocale } from 'next-intl';

export function HistoryTable({ records, showName = true }: { records: RunRecord[]; showName?: boolean }) {
  const t = useTranslations('historyTable');
  const locale = useLocale();

  if (records.length === 0) {
    return <p className="empty-state">{t('noRuns')}</p>;
  }

  return (
    <table className="cs-table">
      <thead>
        <tr>
          <th>{t('id')}</th>
          {showName && <th>{t('automation')}</th>}
          <th>{t('status')}</th>
          <th>{t('duration')}</th>
          <th>{t('cost')}</th>
          <th>{t('started')}</th>
          <th>{t('log')}</th>
        </tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <tr key={r.id}>
            <td>
              <Link href={`/runs/${r.id}`}>#{r.id}</Link>
            </td>
            {showName && (
              <td>
                <Link href={`/automations/${encodeURIComponent(r.automation_name)}`}>
                  {r.automation_name}
                </Link>
              </td>
            )}
            <td>
              <StatusBadge success={r.success} status={r.status} />
            </td>
            <td>{r.duration_ms != null ? formatDuration(r.duration_ms) : '—'}</td>
            <td>{r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : '-'}</td>
            <td>{formatDate(r.started_at, locale)}</td>
            <td
              style={{
                fontFamily: 'var(--cs-font-mono)',
                fontSize: '0.75rem',
                color: r.output ? 'var(--cs-text-dim)' : 'var(--cs-red)',
                maxWidth: '400px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <Link href={`/runs/${r.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                {formatPreview(r.output, r.error)}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function formatPreview(output: string, error: string | null): string {
  const text = output || error || '';
  if (!text) return '-';
  const collapsed = text.replace(/\n/g, ' ').trim();
  return collapsed.length > 200 ? collapsed.slice(0, 200) + '\u2026' : collapsed;
}

function formatDate(iso: string | Date, locale: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
