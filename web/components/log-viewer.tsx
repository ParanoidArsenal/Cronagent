'use client';

import { useCallback, useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
}

interface LogEvent {
  type: string;
  /** Direct content array (legacy / normalized format). */
  content?: ContentBlock[];
  /** Claude CLI stream-json wraps assistant/user content under `message`. */
  message?: { content?: ContentBlock[] } | string;
  result?: string;
  error?: string;
  errors?: string[];
  is_error?: boolean;
  mcp_servers?: unknown[];
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface LogViewerProps {
  logUrl: string;
  rawLogUrl: string;
  /** When true, the viewer re-fetches `logUrl` every 2s for live tailing. */
  running?: boolean;
  labels: {
    loading: string;
    fetchError: string;
    viewRaw: string;
    toolCall: string;
    toolResult: string;
    result: string;
    error: string;
    noEntries: string;
  };
}

const POLL_INTERVAL_MS = 2000;

export function LogViewer({ logUrl, rawLogUrl, running, labels }: LogViewerProps) {
  const [entries, setEntries] = useState<LogEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLog = useCallback(async () => {
    try {
      const res = await fetch(logUrl);
      if (!res.ok) throw new Error(`${res.status}`);
      const text = await res.text();
      const events = text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line) as LogEvent; }
          catch { return null; }
        })
        .filter((e): e is LogEvent => e !== null);
      setEntries(events);
      setError(null);
    } catch {
      setError(labels.fetchError);
    }
  }, [logUrl, labels.fetchError]);

  useEffect(() => {
    void loadLog();
  }, [loadLog]);

  // While the run is in progress, poll the log endpoint so newly-flushed
  // stream-json events appear in the timeline live. Stops automatically when
  // `running` flips to false (the parent page learns this via its
  // <AutoRefresh> server-component re-render) or when the component unmounts.
  // Mirrors the polling pattern used by web/components/run-button.tsx.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      void loadLog();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [running, loadLog]);

  if (error) {
    return (
      <div className="callout callout-red">{error}</div>
    );
  }

  if (entries === null) {
    return (
      <div className="loading-indicator">
        <span className="spinner" aria-hidden />
        {labels.loading}
      </div>
    );
  }

  const rendered = renderEntries(entries, labels);

  return (
    <>
      <div className="log-timeline">
        {rendered.length === 0 && (
          <p style={{ color: 'var(--cs-text-dim)', fontSize: '0.85rem' }}>{labels.noEntries}</p>
        )}
        {rendered}
      </div>
      <p style={{ color: 'var(--cs-text-dim)', fontSize: '0.8rem', marginTop: '0.75rem' }}>
        <a href={rawLogUrl} target="_blank" rel="noopener noreferrer">{labels.viewRaw}</a>
      </p>
    </>
  );
}

/** Extract the content array from a log event, handling both top-level and
 *  nested `message.content` layouts emitted by the Claude CLI. */
function getContent(event: LogEvent): ContentBlock[] | undefined {
  if (Array.isArray(event.content)) return event.content;
  if (event.message && typeof event.message === 'object' && Array.isArray(event.message.content)) {
    return event.message.content;
  }
  return undefined;
}

function renderEntries(events: LogEvent[], labels: LogViewerProps['labels']) {
  const elements: React.ReactNode[] = [];
  let idx = 0;

  for (const event of events) {
    if (event.type === 'system') continue;

    const content = getContent(event);

    if (event.type === 'assistant' && content) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          elements.push(
            <div key={idx++} className="log-entry log-entry-assistant">
              <div className="log-entry-content">{block.text}</div>
            </div>
          );
        } else if (block.type === 'tool_use') {
          const inputStr = block.input
            ? (typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2))
            : '';
          elements.push(
            <details key={idx++} className="log-entry log-entry-tool">
              <summary>{labels.toolCall}: {block.name ?? 'unknown'}</summary>
              <div className="log-entry-content">{inputStr}</div>
            </details>
          );
        }
      }
    }

    if (event.type === 'user' && content) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '', null, 2);
          const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n...' : content;
          elements.push(
            <details key={idx++} className="log-entry log-entry-tool">
              <summary>{labels.toolResult}</summary>
              <div className="log-entry-content">{truncated}</div>
            </details>
          );
        }
      }
    }

    if (event.type === 'result') {
      if (event.is_error) {
        const msg = event.error
          ?? (Array.isArray(event.errors) ? event.errors.join('; ') : null)
          ?? event.result
          ?? 'Unknown error';
        elements.push(
          <div key={idx++} className="log-entry log-entry-error">
            <strong>{labels.error}</strong>
            <div className="log-entry-content">{msg}</div>
          </div>
        );
      } else {
        const cost = event.total_cost_usd;
        const tokens = event.usage;
        const meta = [
          cost != null ? `$${cost.toFixed(4)}` : null,
          tokens?.input_tokens != null ? `${tokens.input_tokens.toLocaleString()} in` : null,
          tokens?.output_tokens != null ? `${tokens.output_tokens.toLocaleString()} out` : null,
        ].filter(Boolean).join(' | ');

        if (event.result && event.result.trim().length > 0) {
          elements.push(
            <details key={idx++} className="log-entry log-entry-result">
              <summary>
                <strong>{labels.result}</strong>
                {meta && <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}>({meta})</span>}
              </summary>
              <div className="log-result-prose prose">
                <Markdown remarkPlugins={[remarkGfm]}>{event.result}</Markdown>
              </div>
            </details>
          );
        } else {
          elements.push(
            <div key={idx++} className="log-entry log-entry-result">
              <strong>{labels.result}</strong>
              {meta && <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}>({meta})</span>}
            </div>
          );
        }
      }
    }

    if (event.type === 'error') {
      elements.push(
        <div key={idx++} className="log-entry log-entry-error">
          <strong>{labels.error}</strong>
          <div className="log-entry-content">{(typeof event.message === 'string' ? event.message : undefined) ?? event.error ?? 'Unknown error'}</div>
        </div>
      );
    }
  }

  return elements;
}
