'use client';

import { useState, useCallback, useRef } from 'react';

interface McpTestButtonProps {
  name: string;
}

export function McpTestButton({ name }: McpTestButtonProps) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const busyRef = useRef(false);

  const handleTest = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus('testing');

    try {
      const res = await fetch(`/api/mcp/${encodeURIComponent(name)}/test`, {
        method: 'POST',
      });
      const data = await res.json();
      setStatus(data.ok ? 'ok' : 'error');
    } catch {
      setStatus('error');
    } finally {
      busyRef.current = false;
      // Reset after 5 seconds
      setTimeout(() => setStatus('idle'), 5000);
    }
  }, [name]);

  const label = {
    idle: 'Test',
    testing: 'Testing...',
    ok: 'OK',
    error: 'Failed',
  }[status];

  const className = status === 'ok'
    ? 'btn btn-sm'
    : status === 'error'
      ? 'btn btn-sm btn-danger'
      : 'btn btn-sm';

  return (
    <button
      className={className}
      onClick={handleTest}
      disabled={status === 'testing'}
      style={status === 'ok' ? { color: 'var(--cs-ok)' } : undefined}
    >
      {label}
    </button>
  );
}
