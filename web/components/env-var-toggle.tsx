'use client';

import { useState, useCallback, useRef } from 'react';

interface EnvVarToggleProps {
  name: string;
  initialEnabled: boolean;
}

export function EnvVarToggle({ name, initialEnabled }: EnvVarToggleProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [loading, setLoading] = useState(false);
  const busyRef = useRef(false);

  const handleToggle = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;

    const newEnabled = !enabled;
    setLoading(true);
    setEnabled(newEnabled); // optimistic

    try {
      const res = await fetch(`/api/env-vars/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled }),
      });

      if (!res.ok) {
        setEnabled(!newEnabled); // rollback
      }
    } catch {
      setEnabled(!newEnabled); // rollback
    } finally {
      setLoading(false);
      busyRef.current = false;
    }
  }, [name, enabled]);

  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={enabled}
        onChange={handleToggle}
        disabled={loading}
      />
      <span className="toggle-track" />
      <span className="toggle-thumb" />
    </label>
  );
}
