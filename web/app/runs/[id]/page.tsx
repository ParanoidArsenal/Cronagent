import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getHistory } from '@/lib/backend';
import { StatusBadge, ModeBadge } from '@/components/status-badge';
import { AutoRefresh } from '@/components/auto-refresh';
import { RunningPanel } from '@/components/running-panel';
import { RunOutput } from '@/components/run-output';
import { LogViewer } from '@/components/log-viewer';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations('runDetail');
  const { id } = await params;
  const history = await getHistory();
  const record = await history.getById(parseInt(id, 10));

  if (!record) {
    notFound();
  }

  const isRunning = record.status === 'running';

  return (
    <>
      {isRunning && <AutoRefresh intervalMs={2000} />}
      <div className="page-header">
        <h1>{t('title', { id: record.id })}</h1>
      </div>

      {isRunning && (
        <RunningPanel
          startedAt={record.started_at}
          currentStage={record.current_stage}
          turnCount={record.turn_count}
        />
      )}

      <div className="meta-grid" style={{ marginBottom: '1.5rem' }}>
        <span className="meta-label">{t('automation')}</span>
        <span className="meta-value">
          <Link href={`/automations/${encodeURIComponent(record.automation_name)}`}>
            {record.automation_name}
          </Link>
        </span>

        <span className="meta-label">{t('status')}</span>
        <span className="meta-value">
          <StatusBadge success={record.success} status={record.status} />
        </span>

        <span className="meta-label">{t('mode')}</span>
        <span className="meta-value">
          <ModeBadge mode={record.mode} />
        </span>

        <span className="meta-label">{t('duration')}</span>
        <span className="meta-value">
          {record.duration_ms == null
            ? '—'
            : record.duration_ms < 1000
              ? `${record.duration_ms}ms`
              : `${(record.duration_ms / 1000).toFixed(1)}s`}
        </span>

        {record.cost_usd != null && record.cost_usd > 0 && (
          <>
            <span className="meta-label">{t('cost')}</span>
            <span className="meta-value">${record.cost_usd.toFixed(4)}</span>
          </>
        )}

        {record.input_tokens != null && record.input_tokens > 0 && (
          <>
            <span className="meta-label">{t('inputTokens')}</span>
            <span className="meta-value">{record.input_tokens.toLocaleString()}</span>
          </>
        )}

        {record.output_tokens != null && record.output_tokens > 0 && (
          <>
            <span className="meta-label">{t('outputTokens')}</span>
            <span className="meta-value">{record.output_tokens.toLocaleString()}</span>
          </>
        )}

        {record.total_attempts != null && record.total_attempts > 1 && (
          <>
            <span className="meta-label">{t('attempts')}</span>
            <span className="meta-value">
              {t('attemptOf', { attempt: record.attempt_number ?? 1, total: record.total_attempts ?? 1 })}
            </span>
          </>
        )}

        {record.conversation_id && (
          <>
            <span className="meta-label">{t('conversation')}</span>
            <span className="meta-value">
              <Link href={`/conversations/${record.conversation_id}`}>
                View Conversation
              </Link>
            </span>
          </>
        )}

        <span className="meta-label">{t('started')}</span>
        <span className="meta-value">
          <code>{String(record.started_at)}</code>
        </span>

        <span className="meta-label">{t('finished')}</span>
        <span className="meta-value">
          <code>{record.finished_at ? String(record.finished_at) : '—'}</code>
        </span>
      </div>

      {record.error && (
        <div className="callout callout-red" style={{ marginBottom: '1rem' }}>
          <strong>{t('error')}</strong>
          <pre style={{ margin: '0.5rem 0 0', whiteSpace: 'pre-wrap', fontFamily: 'var(--cs-font-mono)', fontSize: '0.85rem' }}>
            {record.error}
          </pre>
        </div>
      )}

      <h2 className="cs-section">{t('output')}</h2>
      <RunOutput output={record.output} fallbackText={t('noOutput')} />

      {record.log_file && (
        <>
          <h2 className="cs-section">{t('streamLog')}</h2>
          <LogViewer
            logUrl={`/api/runs/${record.id}/log`}
            rawLogUrl={`/api/runs/${record.id}/log`}
            running={isRunning}
            labels={{
              loading: t('logLoading'),
              fetchError: t('logFetchError'),
              viewRaw: t('viewRawLog'),
              toolCall: t('logToolCall'),
              toolResult: t('logToolResult'),
              result: t('logResult'),
              error: t('logError'),
              noEntries: t('logNoEntries'),
            }}
          />
        </>
      )}
    </>
  );
}
