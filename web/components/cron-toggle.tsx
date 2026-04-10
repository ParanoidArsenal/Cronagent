'use client';

import { useState, useCallback, useRef } from 'react';
import { useTranslations, useLocale } from 'next-intl';

interface CronToggleProps {
  name: string;
  initialEnabled: boolean;
  schedule: string;
  initialNextRun: string | null;
}

export function CronToggle({ name, initialEnabled, schedule, initialNextRun }: CronToggleProps) {
  const t = useTranslations('cronToggle');
  const locale = useLocale();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [nextRun, setNextRun] = useState(initialNextRun);
  const [loading, setLoading] = useState(false);
  const busyRef = useRef(false);

  const handleToggle = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;

    const newEnabled = !enabled;
    setLoading(true);
    setEnabled(newEnabled); // optimistic

    try {
      const action = newEnabled ? 'start' : 'stop';
      const res = await fetch(`/api/scheduler/${encodeURIComponent(name)}/${action}`, {
        method: 'POST',
      });

      if (!res.ok) {
        setEnabled(!newEnabled); // rollback
        return;
      }

      // Refresh status to get updated nextRun
      if (newEnabled) {
        const statusRes = await fetch('/api/scheduler');
        if (statusRes.ok) {
          const jobs = await statusRes.json();
          const job = jobs.find((j: { name: string }) => j.name === name);
          if (job) {
            setNextRun(job.nextRun);
          }
        }
      } else {
        setNextRun(null);
      }
    } catch {
      setEnabled(!newEnabled); // rollback on error
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  }, [name, enabled]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div className="toggle-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={handleToggle}
            disabled={loading}
          />
          <span className="toggle-track" />
          <span className="toggle-thumb" />
        </label>
        <span className="toggle-label">
          {loading ? t('updating') : enabled ? t('enabled') : t('disabled')}
        </span>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--cs-text-dim)' }}>
        <span>{t('schedule')} <code>{schedule}</code></span>
        {enabled && nextRun && (
          <span style={{ marginLeft: '1rem' }}>
            {t('nextRun')} {new Date(nextRun).toLocaleString(locale)}
          </span>
        )}
      </div>
    </div>
  );
}
