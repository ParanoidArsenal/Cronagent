'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export type NotifyChannelValue = 'default' | 'always' | 'on_failure' | 'on_success' | 'off';

export interface NotifyChannelConfig {
  webhook: NotifyChannelValue;
  telegram: NotifyChannelValue;
  mattermost: NotifyChannelValue;
}

export interface AutomationFormData {
  name: string;
  description: string;
  mode: 'claude' | 'caila' | 'shell' | 'composed';
  trigger: 'manual' | 'cron' | 'webhook';
  schedule: string;
  timeout: number;
  model: string;
  mcp: string[];
  sandbox: boolean;
  conversation: boolean;
  notify: boolean;
  notifyChannels: NotifyChannelConfig;
  instructions: string;
  composeSteps: string;
  onComplete: string;
  maxRetries: number;
  retryDelayMs: number;
  maxTurns: number;
}

const DEFAULTS: AutomationFormData = {
  name: '',
  description: '',
  mode: 'claude',
  trigger: 'manual',
  schedule: '',
  timeout: 300,
  model: 'sonnet',
  mcp: [],
  sandbox: false,
  conversation: false,
  notify: true,
  notifyChannels: { webhook: 'default', telegram: 'default', mattermost: 'default' },
  instructions: '',
  composeSteps: '',
  onComplete: '',
  maxRetries: 0,
  retryDelayMs: 1000,
  maxTurns: 0,
};

interface Props {
  initial?: AutomationFormData;
  editMode?: boolean;
  originalName?: string;
}

export function AutomationForm({ initial, editMode = false, originalName }: Props) {
  const router = useRouter();
  const t = useTranslations('automationForm');
  const [form, setForm] = useState<AutomationFormData>(initial ?? DEFAULTS);
  const [mcpInput, setMcpInput] = useState(initial?.mcp.join(', ') ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const update = useCallback(<K extends keyof AutomationFormData>(key: K, value: AutomationFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) {
      setError(t('nameRequired'));
      return;
    }
    if (form.trigger === 'cron' && !form.schedule.trim()) {
      setError(t('scheduleRequired'));
      return;
    }
    if (form.mode === 'composed') {
      if (!form.composeSteps.trim()) {
        setError(t('composeStepsRequired'));
        return;
      }
    } else if (!form.instructions.trim()) {
      setError(t('instructionsRequired'));
      return;
    }

    setSaving(true);
    setError(null);

    // Build notify config from toggle + per-channel settings
    let notifyConfig: boolean | Record<string, boolean | string> = form.notify;
    if (form.notify) {
      const channels: Record<string, boolean | string> = {};
      for (const [ch, val] of Object.entries(form.notifyChannels)) {
        if (val === 'always') channels[ch] = true;
        else if (val === 'off') channels[ch] = false;
        else if (val === 'on_failure' || val === 'on_success') channels[ch] = val;
        // 'default' → omit from config
      }
      notifyConfig = Object.keys(channels).length > 0 ? channels : true;
    }

    const { notifyChannels: _nc, maxTurns: mt, ...rest } = form;
    const payload = {
      ...rest,
      notify: notifyConfig,
      maxTurns: mt > 0 ? mt : undefined,
      schedule: form.trigger === 'cron' ? form.schedule : null,
      mcp: mcpInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      composeSteps: form.mode === 'composed' ? form.composeSteps : undefined,
      onComplete: form.mode === 'composed' ? form.onComplete : undefined,
    };

    try {
      const url = editMode
        ? `/api/automations/${encodeURIComponent(originalName ?? form.name)}`
        : '/api/automations';
      const method = editMode ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('failedToSave'));
        setSaving(false);
        return;
      }

      router.push(`/automations/${encodeURIComponent(form.name)}`);
      router.refresh();
    } catch {
      setError(t('networkError'));
      setSaving(false);
    }
  }, [form, mcpInput, editMode, originalName, router, t]);

  const handleDelete = useCallback(async () => {
    if (!confirm(t('confirmDelete', { name: originalName ?? form.name }))) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(originalName ?? form.name)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || t('failedToDelete'));
        setDeleting(false);
        return;
      }
      router.push('/automations');
      router.refresh();
    } catch {
      setError(t('networkError'));
      setDeleting(false);
    }
  }, [originalName, form.name, router, t]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 700 }}>
      {error && (
        <div className="alert alert-error">{error}</div>
      )}

      {/* Name */}
      <div className="form-field">
        <label className="form-label">{t('name')}</label>
        <input
          className="form-input"
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          placeholder={t('namePlaceholder')}
        />
      </div>

      {/* Description */}
      <div className="form-field">
        <label className="form-label">{t('description')}</label>
        <input
          className="form-input"
          value={form.description}
          onChange={(e) => update('description', e.target.value)}
          placeholder={t('descriptionPlaceholder')}
        />
      </div>

      {/* Mode */}
      <div className="form-field">
        <label className="form-label">{t('mode')}</label>
        <select
          className="form-select"
          value={form.mode}
          onChange={(e) => update('mode', e.target.value as AutomationFormData['mode'])}
          disabled={editMode && form.mode === 'composed'}
        >
          <option value="claude">{t('modeClaude')}</option>
          <option value="caila">{t('modeCaila')}</option>
          <option value="shell">{t('modeShell')}</option>
          {(editMode && form.mode === 'composed') && (
            <option value="composed">{t('modeComposed')}</option>
          )}
        </select>
      </div>

      {/* Trigger */}
      <div className="form-field">
        <label className="form-label">{t('trigger')}</label>
        <select
          className="form-select"
          value={form.trigger}
          onChange={(e) => update('trigger', e.target.value as 'manual' | 'cron' | 'webhook')}
        >
          <option value="manual">{t('triggerManual')}</option>
          <option value="cron">{t('triggerCron')}</option>
          <option value="webhook">{t('triggerWebhook')}</option>
        </select>
      </div>

      {/* Schedule (cron) */}
      {form.trigger === 'cron' && (
        <div className="form-field">
          <label className="form-label">{t('cronSchedule')}</label>
          <input
            className="form-input"
            value={form.schedule}
            onChange={(e) => update('schedule', e.target.value)}
            placeholder={t('cronPlaceholder')}
          />
          <span className="form-hint">{t('cronHint')}</span>
        </div>
      )}

      {/* Timeout (not for composed) */}
      {form.mode !== 'composed' && (
        <div className="form-field">
          <label className="form-label">{t('timeout')}</label>
          <input
            className="form-input"
            type="number"
            value={String(form.timeout)}
            onChange={(e) => update('timeout', parseInt(e.target.value) || 300)}
            placeholder="300"
          />
        </div>
      )}

      {/* Model (claude mode: select, caila mode: free-text) */}
      {form.mode === 'claude' && (
        <div className="form-field">
          <label className="form-label">{t('model')}</label>
          <select
            className="form-select"
            value={form.model}
            onChange={(e) => update('model', e.target.value)}
          >
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
            <option value="haiku">Haiku</option>
          </select>
        </div>
      )}
      {form.mode === 'caila' && (
        <div className="form-field">
          <label className="form-label">{t('model')}</label>
          <input
            className="form-input"
            value={form.model}
            onChange={(e) => update('model', e.target.value)}
            placeholder={t('cailaModelPlaceholder')}
          />
        </div>
      )}

      {/* Max Turns (claude mode only) */}
      {form.mode === 'claude' && (
        <div className="form-field">
          <label className="form-label">{t('maxTurns')}</label>
          <input
            className="form-input"
            type="number"
            min={0}
            value={form.maxTurns || ''}
            onChange={(e) => update('maxTurns', e.target.value === '' ? 0 : Math.max(0, parseInt(e.target.value) || 0))}
          />
          <span className="form-hint">{t('maxTurnsHint')}</span>
        </div>
      )}

      {/* MCP Servers (claude mode only) */}
      {form.mode === 'claude' && (
        <div className="form-field">
          <label className="form-label">{t('mcpServers')}</label>
          <input
            className="form-input"
            value={mcpInput}
            onChange={(e) => setMcpInput(e.target.value)}
            placeholder={t('mcpPlaceholder')}
          />
        </div>
      )}

      {/* Sandbox (not for composed or caila) */}
      {form.mode !== 'composed' && form.mode !== 'caila' && (
        <div className="toggle-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={form.sandbox}
              onChange={(e) => update('sandbox', e.target.checked)}
            />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </label>
          <span className="toggle-label">{t('sandbox')}</span>
        </div>
      )}

      {/* Conversation (claude mode only, not sandbox) */}
      {form.mode === 'claude' && !form.sandbox && (
        <div className="toggle-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={form.conversation}
              onChange={(e) => update('conversation', e.target.checked)}
            />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </label>
          <span className="toggle-label">{t('conversation')}</span>
        </div>
      )}

      {/* Notify on completion */}
      <div className="toggle-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={form.notify}
            onChange={(e) => update('notify', e.target.checked)}
          />
          <span className="toggle-track" />
          <span className="toggle-thumb" />
        </label>
        <span className="toggle-label">{t('notify')}</span>
      </div>

      {form.notify && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingLeft: '2.5rem' }}>
          {(['webhook', 'telegram', 'mattermost'] as const).map((ch) => (
            <div key={ch} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span style={{ minWidth: 100, fontSize: '0.875rem' }}>
                {t({ webhook: 'notifyChannelWebhook', telegram: 'notifyChannelTelegram', mattermost: 'notifyChannelMattermost' }[ch])}
              </span>
              <select
                className="form-select"
                style={{ flex: 1, maxWidth: 200 }}
                value={form.notifyChannels[ch]}
                onChange={(e) => {
                  const updated = { ...form.notifyChannels, [ch]: e.target.value };
                  setForm((prev) => ({ ...prev, notifyChannels: updated }));
                }}
              >
                <option value="default">{t('notifyDefault')}</option>
                <option value="always">{t('notifyAlways')}</option>
                <option value="on_failure">{t('notifyOnFailure')}</option>
                <option value="on_success">{t('notifyOnSuccess')}</option>
                <option value="off">{t('notifyOff')}</option>
              </select>
            </div>
          ))}
        </div>
      )}

      {/* Max Retries (not for composed) */}
      {form.mode !== 'composed' && (
        <div className="form-field">
          <label className="form-label">{t('maxRetries')}</label>
          <input
            className="form-input"
            type="number"
            min={0}
            max={10}
            value={String(form.maxRetries)}
            onChange={(e) => update('maxRetries', Math.min(10, Math.max(0, parseInt(e.target.value) || 0)))}
          />
          <span className="form-hint">{t('maxRetriesHint')}</span>
        </div>
      )}

      {/* Retry Delay (only when retries > 0) */}
      {form.mode !== 'composed' && form.maxRetries > 0 && (
        <div className="form-field">
          <label className="form-label">{t('retryDelayMs')}</label>
          <input
            className="form-input"
            type="number"
            min={0}
            value={String(form.retryDelayMs)}
            onChange={(e) => update('retryDelayMs', parseInt(e.target.value) || 1000)}
          />
          <span className="form-hint">{t('retryDelayMsHint')}</span>
        </div>
      )}

      {/* Compose Steps (composed mode) */}
      {form.mode === 'composed' && (
        <>
          <div className="form-field">
            <label className="form-label">{t('composeStepsLabel')}</label>
            <textarea
              className="form-textarea"
              value={form.composeSteps}
              onChange={(e) => update('composeSteps', e.target.value)}
              placeholder={t('composeStepsPlaceholder')}
              rows={6}
            />
            <span className="form-hint">{t('composeStepsHint')}</span>
          </div>
          <div className="form-field">
            <label className="form-label">{t('onCompleteLabel')}</label>
            <textarea
              className="form-textarea"
              value={form.onComplete}
              onChange={(e) => update('onComplete', e.target.value)}
              placeholder={t('onCompletePlaceholder')}
              rows={3}
            />
            <span className="form-hint">{t('onCompleteHint')}</span>
          </div>
        </>
      )}

      {/* Instructions / Steps (claude/shell modes) */}
      {form.mode !== 'composed' && (
        <div className="form-field">
          <label className="form-label">
            {form.mode === 'shell' ? t('shellStepsLabel') : t('instructionsLabel')}
          </label>
          <textarea
            className="form-textarea"
            value={form.instructions}
            onChange={(e) => update('instructions', e.target.value)}
            placeholder={
              form.mode === 'shell'
                ? t('shellPlaceholder')
                : t('instructionsPlaceholder')
            }
            rows={12}
          />
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '0.5rem' }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('saving') : editMode ? t('saveChanges') : t('createAutomation')}
        </button>
        <button className="btn btn-secondary" onClick={() => router.back()} disabled={saving}>
          {t('cancel')}
        </button>
        {editMode && (
          <button
            className="btn btn-danger"
            onClick={handleDelete}
            disabled={deleting}
            style={{ marginLeft: 'auto' }}
          >
            {deleting ? t('deleting') : t('delete')}
          </button>
        )}
      </div>
    </div>
  );
}
