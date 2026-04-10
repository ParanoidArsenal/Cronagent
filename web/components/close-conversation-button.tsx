'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

export function CloseConversationButton({ conversationId }: { conversationId: string }) {
  const [closing, setClosing] = useState(false);
  const router = useRouter();

  const handleClose = useCallback(async () => {
    setClosing(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/close`, { method: 'POST' });
      if (!res.ok) {
        setClosing(false);
        return;
      }
      router.refresh();
    } catch {
      setClosing(false);
    }
  }, [conversationId, router]);

  return (
    <button
      className="btn btn-secondary"
      onClick={handleClose}
      disabled={closing}
    >
      {closing ? 'Closing...' : 'Close Conversation'}
    </button>
  );
}
