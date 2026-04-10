'use client';

import { useRouter } from 'next/navigation';
import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';

export function SkipRetryButton({ name }: { name: string }) {
  const [state, setState] = useState<'idle' | 'clearing' | 'done' | 'error'>('idle');
  const router = useRouter();
  const t = useTranslations('skipList');

  const handleRetry = useCallback(async () => {
    setState('clearing');
    try {
      const res = await fetch(`/api/skip-list/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error('Failed to clear skip entry');
      }
      setState('done');
      router.refresh();
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }, [name, router]);

  const label =
    state === 'clearing'
      ? t('clearing')
      : state === 'done'
        ? t('cleared')
        : state === 'error'
          ? t('clearFailed')
          : t('retry');

  return (
    <button
      className="cs-btn"
      onClick={handleRetry}
      disabled={state === 'clearing'}
    >
      {label}
    </button>
  );
}
