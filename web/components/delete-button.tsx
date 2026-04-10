'use client';

import { useRouter } from 'next/navigation';
import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';

export function DeleteButton({ name }: { name: string }) {
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();
  const t = useTranslations('automationDetail');

  const handleDelete = useCallback(async () => {
    if (!confirm(t('confirmDelete', { name }))) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || t('failedToDelete'));
        setDeleting(false);
        return;
      }
      router.push('/automations');
      router.refresh();
    } catch {
      alert(t('failedToDelete'));
      setDeleting(false);
    }
  }, [name, router, t]);

  return (
    <button
      className="btn btn-danger"
      onClick={handleDelete}
      disabled={deleting}
    >
      {deleting ? t('deleting') : t('delete')}
    </button>
  );
}
