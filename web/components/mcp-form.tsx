'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface McpFormProps {
  initial?: {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    enabled: boolean;
  };
  editMode?: boolean;
}

export function McpForm({ initial, editMode }: McpFormProps) {
  const router = useRouter();
  const t = useTranslations('mcpForm');
  const [name, setName] = useState(initial?.name ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [argsText, setArgsText] = useState(
    initial?.args ? JSON.stringify(initial.args, null, 2) : '[]',
  );
  const [envText, setEnvText] = useState(
    initial?.env ? JSON.stringify(initial.env, null, 2) : '{}',
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSave = useCallback(async () => {
    setMessage(null);

    let args: string[];
    let env: Record<string, string>;
    try {
      args = JSON.parse(argsText);
      if (!Array.isArray(args)) throw new Error('Args must be an array');
    } catch {
      setMessage({ type: 'error', text: t('argsError') });
      return;
    }
    try {
      env = JSON.parse(envText);
      if (typeof env !== 'object' || Array.isArray(env)) throw new Error('Env must be an object');
    } catch {
      setMessage({ type: 'error', text: t('envError') });
      return;
    }

    setSaving(true);
    try {
      const url = editMode
        ? `/api/mcp/${encodeURIComponent(initial!.name)}`
        : '/api/mcp';
      const method = editMode ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, args, env, enabled }),
      });

      if (!res.ok) {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error || t('failedToSave') });
      } else {
        router.push('/mcp');
        router.refresh();
      }
    } catch {
      setMessage({ type: 'error', text: t('networkError') });
    } finally {
      setSaving(false);
    }
  }, [name, command, argsText, envText, enabled, editMode, initial, router, t]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 600 }}>
      {message && (
        <div className={`alert ${message.type === 'success' ? 'alert-success' : 'alert-error'}`}>
          {message.text}
        </div>
      )}

      <div className="form-field">
        <label className="form-label">{t('name')}</label>
        <input
          className="form-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('namePlaceholder')}
          disabled={editMode}
        />
        <span className="form-hint">{t('nameHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('command')}</label>
        <input
          className="form-input"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={t('commandPlaceholder')}
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t('args')}</label>
        <textarea
          className="form-input"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          rows={3}
          style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
          placeholder={t('argsPlaceholder')}
        />
        <span className="form-hint">{t('argsHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('env')}</label>
        <textarea
          className="form-input"
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          rows={4}
          style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
          placeholder={t('envPlaceholder')}
        />
        <span className="form-hint">{t('envHint')}</span>
      </div>

      <div className="toggle-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span className="toggle-track" />
          <span className="toggle-thumb" />
        </label>
        <span className="toggle-label">{t('enabled')}</span>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '0.5rem' }}>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('saving') : editMode ? t('updateServer') : t('createServer')}
        </button>
        <button className="btn" onClick={() => router.push('/mcp')}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}
