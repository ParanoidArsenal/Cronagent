'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export function SendMessageForm({ conversationId }: { conversationId: string }) {
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const t = useTranslations('sendMessage');

  const handleSend = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed) return;

    setState('sending');
    setError(null);

    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('sendFailed'));
      }

      setMessage('');

      // Poll until message send completes
      const poll = setInterval(async () => {
        try {
          const status = await fetch(`/api/conversations/${conversationId}/messages`);
          const data = await status.json();
          if (!data.sending) {
            clearInterval(poll);
            setState('done');
            router.refresh();
            setTimeout(() => setState('idle'), 2000);
          }
        } catch {
          clearInterval(poll);
          setState('error');
          setError(t('pollFailed'));
        }
      }, 2000);
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : t('networkError'));
      setTimeout(() => setState('idle'), 3000);
    }
  }, [conversationId, message, router, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const isBusy = state === 'sending';

  return (
    <div className="send-message-form">
      <textarea
        className="send-message-input"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('placeholder')}
        disabled={isBusy}
        rows={3}
      />
      <div className="send-message-actions">
        {error && <span className="send-message-error">{error}</span>}
        <span className="send-message-hint">{t('hint')}</span>
        <button
          className="cs-btn"
          onClick={handleSend}
          disabled={isBusy || !message.trim()}
        >
          {isBusy ? t('sending') : state === 'done' ? t('sent') : t('send')}
        </button>
      </div>
    </div>
  );
}
