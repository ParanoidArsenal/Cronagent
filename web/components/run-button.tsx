'use client';

import { useRouter } from 'next/navigation';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';

export function RunButton({ name }: { name: string }) {
  const [state, setState] = useState<'idle' | 'running' | 'stopping' | 'done' | 'error'>('idle');
  const router = useRouter();
  const t = useTranslations('runButton');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Check if already running on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/automations/${encodeURIComponent(name)}/run`);
        const data = await res.json();
        if (!cancelled && data.running) {
          setState('running');
          startPolling();
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await fetch(`/api/automations/${encodeURIComponent(name)}/run`);
        const data = await status.json();
        if (!data.running) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setState('done');
          router.refresh();
          setTimeout(() => setState('idle'), 3000);
        }
      } catch {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setState('error');
      }
    }, 2000);
  }, [name, router]);

  const handleRun = useCallback(async () => {
    setState('running');
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(name)}/run`, {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('failedToStart'));
      }

      startPolling();
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }, [name, t, startPolling]);

  const handleStop = useCallback(async () => {
    setState('stopping');
    try {
      await fetch(`/api/automations/${encodeURIComponent(name)}/run`, {
        method: 'DELETE',
      });
      // Keep polling — the poll loop will detect !running and transition to done
    } catch {
      // Even if the request fails, keep polling — the run may have finished
    }
  }, [name]);

  if (state === 'running') {
    return (
      <button className="cs-btn cs-btn-danger" onClick={handleStop}>
        {t('stop')}
      </button>
    );
  }

  if (state === 'stopping') {
    return (
      <button className="cs-btn cs-btn-danger" disabled>
        {t('stopping')}
      </button>
    );
  }

  const label =
    state === 'done'
      ? t('done')
      : state === 'error'
        ? t('failed')
        : t('run');

  return (
    <button
      className="cs-btn"
      onClick={handleRun}
      disabled={state === 'done' || state === 'error'}
    >
      {label}
    </button>
  );
}
