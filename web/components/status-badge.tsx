'use client';

import { useTranslations } from 'next-intl';

export function StatusBadge({
  success,
  status,
}: {
  success: boolean | number | null;
  status?: 'running' | 'success' | 'failed' | null;
}) {
  const t = useTranslations('statusBadge');
  if (status === 'running') {
    return <span className="badge badge-blue">{t('running')}</span>;
  }
  const ok = success === true || success === 1;
  return (
    <span className={`badge ${ok ? 'badge-ok' : 'badge-fail'}`}>
      {ok ? t('ok') : t('fail')}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  const cls = mode === 'claude' ? 'badge-violet' : mode === 'caila' ? 'badge-green' : mode === 'composed' ? 'badge-amber' : 'badge-blue';
  return (
    <span className={`badge ${cls}`}>
      {mode}
    </span>
  );
}

export function SkipBadge() {
  const t = useTranslations('statusBadge');
  return (
    <span className="badge badge-orange">
      {t('skip')}
    </span>
  );
}

export function TriggerBadge({ trigger, schedule }: { trigger: string; schedule?: string | null }) {
  if (trigger === 'cron' && schedule) {
    return (
      <span className="badge badge-orange">
        cron({schedule})
      </span>
    );
  }
  return (
    <span className="badge badge-gray">
      {trigger}
    </span>
  );
}
