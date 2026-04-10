'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface EnvVarFormProps {
  initial?: {
    name: string;
    value: string;
    description: string;
    enabled: boolean;
  };
  editMode?: boolean;
}

export function EnvVarForm({ initial, editMode }: EnvVarFormProps) {
  const router = useRouter();
  const t = useTranslations('envVarForm');
  const [name, setName] = useState(initial?.name ?? '');
  const [value, setValue] = useState(initial?.value ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSave = useCallback(async () => {
    setMessage(null);
    setSaving(true);

    try {
      const url = editMode
        ? `/api/env-vars/${encodeURIComponent(initial!.name)}`
        : '/api/env-vars';
      const method = editMode ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value, description, enabled }),
      });

      if (!res.ok) {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error || t('failedToSave') });
      } else {
        router.push('/env-vars');
        router.refresh();
      }
    } catch {
      setMessage({ type: 'error', text: t('networkError') });
    } finally {
      setSaving(false);
    }
  }, [name, value, description, enabled, editMode, initial, router, t]);

  const handleDelete = useCallback(async () => {
    if (!editMode || !initial) return;
    if (!confirm(t('confirmDelete'))) return;

    setMessage(null);
    setDeleting(true);

    try {
      const res = await fetch(`/api/env-vars/${encodeURIComponent(initial.name)}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error || t('failedToSave') });
      } else {
        router.push('/env-vars');
        router.refresh();
      }
    } catch {
      setMessage({ type: 'error', text: t('networkError') });
    } finally {
      setDeleting(false);
    }
  }, [editMode, initial, router, t]);

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
          style={{ fontFamily: 'monospace' }}
        />
        <span className="form-hint">{t('nameHint')}</span>
      </div>

      <div className="form-field">
        <label className="form-label">{t('value')}</label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            className="form-input"
            type={showValue ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('valuePlaceholder')}
            style={{ flex: 1, fontFamily: 'monospace' }}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowValue(!showValue)}
          >
            {showValue ? t('hide') : t('show')}
          </button>
        </div>
      </div>

      <div className="form-field">
        <label className="form-label">{t('description')}</label>
        <input
          className="form-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('descriptionPlaceholder')}
        />
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
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || deleting}>
          {saving ? t('saving') : editMode ? t('updateVar') : t('createVar')}
        </button>
        <button className="btn" onClick={() => router.push('/env-vars')} disabled={saving || deleting}>
          {t('cancel')}
        </button>
        {editMode && (
          <button
            className="btn"
            style={{ marginLeft: 'auto', color: '#ff4444' }}
            onClick={handleDelete}
            disabled={saving || deleting}
          >
            {deleting ? t('deleting') : t('deleteVar')}
          </button>
        )}
      </div>
    </div>
  );
}
