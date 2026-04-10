'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Invisible component that periodically refreshes server-rendered data.
 * Uses Next.js router.refresh() — no full page reload, just re-fetches
 * server components with fresh data.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
