'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { AutomationFormData } from './automation-form';

interface Props {
  onGenerated: (data: AutomationFormData) => void;
}

export function GenerateAutomation({ onGenerated }: Props) {
  const t = useTranslations('generateAutomation');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (description.trim().length < 5) {
      setError(t('descriptionTooShort'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/automations/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('generationFailed'));
        setLoading(false);
        return;
      }

      onGenerated({
        name: data.name ?? '',
        description: data.description ?? '',
        mode: data.mode ?? 'claude',
        trigger: data.trigger ?? 'manual',
        schedule: data.schedule ?? '',
        timeout: 300,
        model: 'sonnet',
        mcp: Array.isArray(data.mcp) ? data.mcp : [],
        sandbox: false,
        conversation: false,
        notify: data.trigger === 'cron',
        notifyChannels: { webhook: 'default', telegram: 'default', mattermost: 'default' },
        instructions: data.instructions ?? '',
        composeSteps: '',
        onComplete: '',
        maxRetries: 0,
        retryDelayMs: 1000,
        maxTurns: 0,
      });
    } catch {
      setError(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [description, onGenerated, t]);

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <div className="form-field">
        <label className="form-label">{t('label')}</label>
        <textarea
          className="form-textarea"
          value={description}
          onChange={(e) => { setDescription(e.target.value); setError(null); }}
          placeholder={t('placeholder')}
          rows={3}
          disabled={loading}
        />
      </div>
      {error && <div className="alert alert-error" style={{ marginBottom: '0.75rem' }}>{error}</div>}
      <button
        className="btn btn-primary"
        onClick={handleGenerate}
        disabled={loading || description.trim().length < 5}
      >
        {loading ? t('generating') : t('generateButton')}
      </button>
    </div>
  );
}
