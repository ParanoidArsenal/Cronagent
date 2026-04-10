import type { UsageStat } from '@/lib/backend';
import { formatTokens } from '@/lib/format';

interface CostChartProps {
  data: UsageStat[];
  title: string;
  mode: 'cost' | 'tokens';
}

export function CostChart({ data, title, mode }: CostChartProps) {
  if (data.length === 0) {
    return (
      <div className="chart-container">
        <h3 className="chart-title">{title}</h3>
        <p className="empty-state">No data for this period.</p>
      </div>
    );
  }

  let maxValue: number;
  if (mode === 'cost') {
    maxValue = Math.max(...data.map((d) => d.total_cost), 0.001);
  } else {
    // Use combined input+output as max so stacked bars never overflow
    maxValue = Math.max(...data.map((d) => d.total_input_tokens + d.total_output_tokens), 1);
  }

  return (
    <div className="chart-container">
      {title && <h3 className="chart-title">{title}</h3>}
      <div className="chart-bars">
        {data.map((d) => {
          const dayLabel = new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

          if (mode === 'cost') {
            const pct = (d.total_cost / maxValue) * 100;
            return (
              <div key={d.day} className="chart-bar-col">
                <div className="chart-bar-value">${d.total_cost.toFixed(3)}</div>
                <div className="chart-bar-track">
                  <div
                    className="chart-bar chart-bar-accent"
                    style={{ height: `${Math.max(pct, 2)}%` }}
                  />
                </div>
                <div className="chart-bar-label">{dayLabel}</div>
              </div>
            );
          }

          const total = d.total_input_tokens + d.total_output_tokens;
          const barPct = (total / maxValue) * 100;
          const inputPct = total > 0 ? (d.total_input_tokens / total) * barPct : 0;
          const outputPct = total > 0 ? (d.total_output_tokens / total) * barPct : 0;
          return (
            <div key={d.day} className="chart-bar-col">
              <div className="chart-bar-value">
                {formatTokens(d.total_input_tokens + d.total_output_tokens)}
              </div>
              <div className="chart-bar-track">
                <div
                  className="chart-bar chart-bar-blue"
                  style={{ height: inputPct > 0 ? `${Math.max(inputPct, 1)}%` : '0%' }}
                />
                <div
                  className="chart-bar chart-bar-violet"
                  style={{ height: outputPct > 0 ? `${Math.max(outputPct, 1)}%` : '0%' }}
                />
              </div>
              <div className="chart-bar-label">{dayLabel}</div>
            </div>
          );
        })}
      </div>
      {mode === 'tokens' && (
        <div className="chart-legend">
          <span className="chart-legend-item">
            <span className="chart-legend-swatch chart-legend-blue" /> Input
          </span>
          <span className="chart-legend-item">
            <span className="chart-legend-swatch chart-legend-violet" /> Output
          </span>
        </div>
      )}
    </div>
  );
}

