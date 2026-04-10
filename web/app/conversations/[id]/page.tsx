import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getHistory } from '@/lib/backend';
import { ConversationView } from '@/components/conversation-view';
import { CloseConversationButton } from '@/components/close-conversation-button';
import { SendMessageForm } from '@/components/send-message-form';

export const dynamic = 'force-dynamic';

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const history = await getHistory();
  const conversation = await history.getConversation(id);

  if (!conversation) {
    notFound();
  }

  const messages = await history.getConversationMessages(id);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1 style={{ flex: 1 }}>Conversation</h1>
        {!conversation.closed && (
          <CloseConversationButton conversationId={id} />
        )}
      </div>

      <div className="meta-grid" style={{ marginBottom: '1.5rem' }}>
        <span className="meta-label">Automation</span>
        <span className="meta-value">
          <Link href={`/automations/${encodeURIComponent(conversation.automation_name)}`}>
            {conversation.automation_name}
          </Link>
        </span>

        <span className="meta-label">Status</span>
        <span className="meta-value">
          <span className={`badge ${conversation.closed ? 'badge-fail' : 'badge-ok'}`}>
            {conversation.closed ? 'Closed' : 'Active'}
          </span>
        </span>

        <span className="meta-label">Turns</span>
        <span className="meta-value">{conversation.total_turns}</span>

        {conversation.total_cost_usd > 0 && (
          <>
            <span className="meta-label">Total Cost</span>
            <span className="meta-value">${conversation.total_cost_usd.toFixed(4)}</span>
          </>
        )}

        <span className="meta-label">Created</span>
        <span className="meta-value">
          <code>{String(conversation.created_at)}</code>
        </span>

        <span className="meta-label">Updated</span>
        <span className="meta-value">
          <code>{String(conversation.updated_at)}</code>
        </span>
      </div>

      <h2 className="cs-section">Messages ({messages.length})</h2>
      <ConversationView messages={messages} />

      {!conversation.closed && (
        <SendMessageForm conversationId={id} />
      )}
    </>
  );
}
