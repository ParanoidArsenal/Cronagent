import type { AgentStat } from '@/lib/backend';
import { formatTokens } from '@/lib/format';

interface AgentStatsTableProps {
  data: AgentStat[];
}

export function AgentStatsTable({ data }: AgentStatsTableProps) {
  if (data.length === 0) {
    return <p className="empty-state">No agent data yet.</p>;
  }

  return (
    <table className="cs-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Runs</th>
          <th>Success</th>
          <th>Input Tokens</th>
          <th>Output Tokens</th>
          <th>Avg Cost</th>
          <th>Total Cost</th>
          <th>Avg Duration</th>
        </tr>
      </thead>
      <tbody>
        {data.map((a) => (
          <tr key={a.automation_name}>
            <td style={{ fontWeight: 500, color: 'var(--cs-text-bright)' }}>
              {a.automation_name}
            </td>
            <td>{a.total_runs}</td>
            <td>
              <span className={a.success_rate >= 80 ? 'badge badge-ok' : a.success_rate >= 50 ? 'badge badge-amber' : 'badge badge-fail'}>
                {a.success_rate.toFixed(1)}%
              </span>
            </td>
            <td>{formatTokens(a.total_input_tokens)}</td>
            <td>{formatTokens(a.total_output_tokens)}</td>
            <td>${a.avg_cost.toFixed(4)}</td>
            <td>${a.total_cost.toFixed(4)}</td>
            <td>{formatDuration(a.avg_duration_ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
