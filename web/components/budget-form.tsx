'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';

type BudgetConfig = {
  dailyBudget: number;
  reservePercent: number;
  workHoursStart: number;
  workHoursEnd: number;
  offHoursMultiplier: number;
  enabled: boolean;
};

export function BudgetForm() {
  const t = useTranslations('budgetForm');
  const [config, setConfig] = useState<BudgetConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings/budget')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setMessage({ type: 'error', text: t('failedToLoad') }));
  }, [t]);

  const update = useCallback(<K extends keyof BudgetConfig>(key: K, value: BudgetConfig[K]) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
    setMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch('/api/settings/budget', {
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
        <span className="toggle-label" style={{ fontWeight: 500 }}>{t('enableBudget')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('dailyBudget')}</label>
        <input
          className="form-input"
          type="number"
          step="0.01"
          value={String(config.dailyBudget)}
          onChange={(e) => update('dailyBudget', parseFloat(e.target.value) || 0)}
          disabled={!config.enabled}
        />
        <span className="form-hint">{t('dailyBudgetHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('reservePercent')}</label>
        <input
          className="form-input"
          type="number"
          value={String(config.reservePercent)}
          onChange={(e) => update('reservePercent', parseInt(e.target.value) || 0)}
          disabled={!config.enabled}
        />
        <span className="form-hint">{t('reservePercentHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('workHoursStart')}</label>
        <input
          className="form-input"
          type="number"
          min="0"
          max="23"
          value={String(config.workHoursStart)}
          onChange={(e) => update('workHoursStart', parseInt(e.target.value) || 0)}
          disabled={!config.enabled}
        />
        <span className="form-hint">{t('workHoursStartHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('workHoursEnd')}</label>
        <input
          className="form-input"
          type="number"
          min="0"
          max="23"
          value={String(config.workHoursEnd)}
          onChange={(e) => update('workHoursEnd', parseInt(e.target.value) || 0)}
          disabled={!config.enabled}
        />
        <span className="form-hint">{t('workHoursEndHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('offHoursMultiplier')}</label>
        <input
          className="form-input"
          type="number"
          step="0.1"
          min="0.1"
          max="10"
          value={String(config.offHoursMultiplier)}
          onChange={(e) => update('offHoursMultiplier', parseFloat(e.target.value) || 0.5)}
          disabled={!config.enabled}
        />
        <span className="form-hint">{t('offHoursMultiplierHint')}</span>
      </div>

      <div style={{ paddingTop: '0.5rem' }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('saving') : t('saveSettings')}
        </button>
      </div>
    </div>
  );
}
