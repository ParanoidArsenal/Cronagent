'use client';

import type { ConversationMessageRecord } from '@/lib/backend';

export function ConversationView({ messages }: { messages: ConversationMessageRecord[] }) {
  if (messages.length === 0) {
    return <p className="empty-state">No messages yet.</p>;
  }

  return (
    <div className="conversation-thread">
      {messages.map((msg) => (
        <div key={msg.id} className={`conv-message conv-role-${msg.role}`}>
          <span className="conv-role-label">{roleLabel(msg.role)}</span>
          {msg.tool_name && (
            <span className="conv-tool-name">{msg.tool_name}</span>
          )}
          <div className="conv-content">
            {msg.content}
          </div>
        </div>
      ))}
    </div>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user': return 'User';
    case 'assistant': return 'Assistant';
    case 'tool_use': return 'Tool Call';
    case 'tool_result': return 'Tool Result';
    default: return role;
  }
}
