/**
 * Structural tests for live Claude run log streaming.
 *
 * Asserts the wiring between the runner's onLogFile callback, History's
 * updateLogFile method, both runner call sites (web triggerRun + cron
 * scheduler), the log API endpoint's tolerance for missing files, and the
 * LogViewer's polling-while-running behavior.
 *
 * Follows the source-inspection pattern from tests/run-stage-tracking.test.ts
 * and tests/log-file.test.ts — no DB or HTTP server, just regex/string
 * assertions on the source files.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let typesSrc: string;
let runnerSrc: string;
let historySrc: string;
let backendSrc: string;
let schedulerSrc: string;
let logRouteSrc: string;
let runsPageSrc: string;
let logViewerSrc: string;

beforeAll(async () => {
  typesSrc = await readFile(resolve(__dirname, '../src/types.ts'), 'utf-8');
  runnerSrc = await readFile(resolve(__dirname, '../src/runner.ts'), 'utf-8');
  historySrc = await readFile(resolve(__dirname, '../src/history.ts'), 'utf-8');
  backendSrc = await readFile(resolve(__dirname, '../web/lib/backend.ts'), 'utf-8');
  schedulerSrc = await readFile(resolve(__dirname, '../src/scheduler.ts'), 'utf-8');
  logRouteSrc = await readFile(resolve(__dirname, '../web/app/api/runs/[id]/log/route.ts'), 'utf-8');
  runsPageSrc = await readFile(resolve(__dirname, '../web/app/runs/[id]/page.tsx'), 'utf-8');
  logViewerSrc = await readFile(resolve(__dirname, '../web/components/log-viewer.tsx'), 'utf-8');
});

describe('types.ts — LogFileCallback type', () => {
  it('exports LogFileCallback as a function from path to void', () => {
    expect(typesSrc).toMatch(/export type LogFileCallback\s*=\s*\(path:\s*string\)\s*=>\s*void/);
  });
});

describe('runner.ts — onLogFile parameter', () => {
  it('imports LogFileCallback from types', () => {
    expect(runnerSrc).toContain('LogFileCallback');
  });

  it('accepts onLogFile in execute()', () => {
    expect(runnerSrc).toMatch(/execute\([\s\S]*?onLogFile\?:\s*LogFileCallback/);
  });

  it('accepts onLogFile in executeClaudeMode()', () => {
    expect(runnerSrc).toMatch(/executeClaudeMode\([\s\S]*?onLogFile\?:\s*LogFileCallback/);
  });

  it('forwards onLogFile from execute() to executeClaudeMode()', () => {
    expect(runnerSrc).toMatch(/executeClaudeMode\([^)]*onLogFile[^)]*\)/);
  });

  it('invokes onLogFile after constructing the log file path', () => {
    expect(runnerSrc).toMatch(/if \(logFile && onLogFile\)/);
    expect(runnerSrc).toMatch(/onLogFile\(logFile\)/);
  });

  it('wraps the onLogFile invocation in try/catch so a callback throw cannot kill the run', () => {
    // The invocation block must be inside a try { ... } catch { ... } structure.
    expect(runnerSrc).toMatch(/try\s*\{\s*onLogFile\(logFile\);\s*\}\s*catch/);
  });
});

describe('history.ts — updateLogFile method', () => {
  it('exposes updateLogFile', () => {
    expect(historySrc).toContain('async updateLogFile(');
  });

  it('updates log_file with a parameterized UPDATE query', () => {
    expect(historySrc).toMatch(/UPDATE run_history SET log_file = \$2 WHERE id = \$1/);
  });

  it('only updates rows that are still running', () => {
    expect(historySrc).toMatch(/updateLogFile[\s\S]*?status = 'running'/);
  });
});

describe('backend.ts — triggerRun wires onLogFile', () => {
  it('builds an onLogFile closure that calls history.updateLogFile', () => {
    expect(backendSrc).toMatch(/const onLogFile\s*=\s*\(path: string\)\s*=>\s*\{[\s\S]*?history\.updateLogFile\(runId, path\)/);
  });

  it('passes onLogFile into runner.execute', () => {
    expect(backendSrc).toMatch(/runner\.execute\([^)]*onLogFile[^)]*\)/);
  });

  it('logs failures from updateLogFile without crashing the run', () => {
    expect(backendSrc).toMatch(/updateLogFile\([^)]*\)\.catch/);
  });
});

describe('scheduler.ts — cron path wires onLogFile', () => {
  it('builds an onLogFile closure that calls history.updateLogFile', () => {
    expect(schedulerSrc).toMatch(/const onLogFile\s*=[\s\S]*?this\.history\.updateLogFile\(runId, path\)/);
  });

  it('passes onLogFile into runner.execute', () => {
    expect(schedulerSrc).toMatch(/runner\.execute\([^)]*onLogFile[^)]*\)/);
  });
});

describe('log API route — tolerates missing file for in-flight runs', () => {
  it('returns an empty 200 instead of 404 on ENOENT', () => {
    expect(logRouteSrc).toMatch(/code === 'ENOENT'/);
    expect(logRouteSrc).toContain("new Response('', { headers: PLAIN_TEXT_HEADERS })");
  });

  it('sends Cache-Control: no-store so polling clients always get fresh content', () => {
    expect(logRouteSrc).toMatch(/'Cache-Control':\s*'no-store'/);
  });

  it('still returns 404 when no log file is recorded for the run', () => {
    expect(logRouteSrc).toContain('No log file for this run');
  });
});

describe('runs detail page — passes running prop to LogViewer', () => {
  it('passes running={isRunning} to LogViewer', () => {
    expect(runsPageSrc).toMatch(/<LogViewer[\s\S]*?running=\{isRunning\}/);
  });

  it('renders LogViewer when record.log_file is set (no longer gated on finished status)', () => {
    expect(runsPageSrc).toMatch(/record\.log_file && \([\s\S]*?<LogViewer/);
  });
});

describe('log-viewer — polls while run is in progress', () => {
  it('declares running as a prop on LogViewerProps', () => {
    expect(logViewerSrc).toMatch(/running\?:\s*boolean/);
  });

  it('destructures running in the component signature', () => {
    expect(logViewerSrc).toMatch(/function LogViewer\(\{[^}]*running[^}]*\}/);
  });

  it('exposes a reusable loadLog function (not just inline fetch in useEffect)', () => {
    expect(logViewerSrc).toMatch(/const loadLog\s*=\s*useCallback/);
  });

  it('starts a setInterval when running is true', () => {
    // The interval setup must be conditional on `running` and use the
    // POLL_INTERVAL_MS constant for the cadence.
    expect(logViewerSrc).toMatch(/POLL_INTERVAL_MS/);
    expect(logViewerSrc).toMatch(/if \(!running\) return;[\s\S]*?setInterval\(/);
  });

  it('clears the interval on cleanup so polling stops when running flips false or component unmounts', () => {
    expect(logViewerSrc).toMatch(/return\s*\(\)\s*=>\s*clearInterval\(/);
  });
});
