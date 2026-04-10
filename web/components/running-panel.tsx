'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Live view for an in-flight run. Renders the current stage, turn count, and
 * elapsed time computed client-side from `startedAt`. The parent page is
 * expected to mount `<AutoRefresh intervalMs={2000} />` so new stage/turn
 * values arrive via router.refresh() re-rendering.
 */
export function RunningPanel({
  startedAt,
  currentStage,
  turnCount,
}: {
  startedAt: string | Date;
  currentStage: string | null;
  turnCount: number | null;
}) {
  const t = useTranslations('runDetail');
  const startedMs = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt.getTime();
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedMs);

  useEffect(() => {
    const id = setInterval(() => setElapsedMs(Date.now() - startedMs), 1000);
    return () => clearInterval(id);
  }, [startedMs]);

  const stageLabel = formatStage(currentStage);
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));

  return (
    <div className="callout callout-blue" style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
        <span className="spinner" aria-hidden />
        <strong>{t('running')}</strong>
      </div>
      <div className="meta-grid">
        <span className="meta-label">{t('stageLabel')}</span>
        <span className="meta-value"><code>{stageLabel}</code></span>
        <span className="meta-label">{t('turn')}</span>
        <span className="meta-value">{turnCount ?? 0}</span>
        <span className="meta-label">{t('elapsed')}</span>
        <span className="meta-value">{formatSeconds(seconds)}</span>
      </div>
    </div>
  );
}

function formatStage(stage: string | null): string {
  if (!stage) return '…';
  if (stage === 'thinking') return 'thinking…';
  if (stage.startsWith('tool_use:')) return `→ ${stage.slice('tool_use:'.length)}`;
  return stage;
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
