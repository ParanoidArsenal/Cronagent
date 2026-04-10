'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';

type ThrottleConfig = {
  maxConcurrent: number;
  maxPerHour: number;
  cooldownSeconds: number;
  enabled: boolean;
};

export function ThrottleForm() {
  const t = useTranslations('throttleForm');
  const [config, setConfig] = useState<ThrottleConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings/throttle')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setMessage({ type: 'error', text: t('failedToLoad') }));
  }, [t]);

  const update = useCallback(<K extends keyof ThrottleConfig>(key: K, value: ThrottleConfig[K]) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
    setMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch('/api/settings/throttle', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error || t('failedToSave') });
      } else {
        setMessage({ type: 'success', text: t('saved') });
      }
    } catch {
      setMessage({ type: 'error', text: t('networkError') });
    } finally {
      setSaving(false);
    }
  }, [config, t]);

  if (!config) {
    return <p className="empty-state">{t('loading')}</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 500 }}>
      {message && (
        <div className={`alert ${message.type === 'success' ? 'alert-success' : 'alert-error'}`}>
          {message.text}
        </div>
      )}

      <div className="toggle-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => update('enabled', e.target.checked)}
          />
          <span className="toggle-track" />
          <span className="toggle-thumb" />
        </label>
        <span className="toggle-label" style={{ fontWeight: 500 }}>{t('enableThrottling')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('maxConcurrent')}</label>
        <input
          className="form-input"
          type="number"
          value={String(config.maxConcurrent)}
          onChange={(e) => update('maxConcurrent', parseInt(e.target.value) || 1)}
          disabled={!config.enabled}
        />
        <span className="form-hint">{t('maxConcurrentHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('maxPerHour')}</label>
        <input
          className="form-input"
          type="number"
          value={String(config.maxPerHour)}
          onChange={(e) => update('maxPerHour', parseInt(e.target.value) || 0)}
          disabled={!config.enabled}
        />
        <span className="form-hint">{t('maxPerHourHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('cooldown')}</label>
        <input
          className="form-input"
          type="number"
          value={String(config.cooldownSeconds)}
          onChange={(e) => update('cooldownSeconds', parseInt(e.target.value) || 0)}
          disabled={!config.enabled}
        />
        <span className="form-hint">{t('cooldownHint')}</span>
      </div>

      <div style={{ paddingTop: '0.5rem' }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('saving') : t('saveSettings')}
        </button>
      </div>
    </div>
  );
}
