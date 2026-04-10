/**
 * Structural tests for the log_file feature in run_history.
 *
 * These tests read source files directly and assert on their content,
 * following the pattern established in tests/entrypoint.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let historySource: string;
let runDetailPage: string;
let logRoute: string;

beforeAll(async () => {
  historySource = await readFile(resolve(__dirname, '../src/history.ts'), 'utf-8');
  runDetailPage = await readFile(
    resolve(__dirname, '../web/app/runs/[id]/page.tsx'),
    'utf-8',
  );
  logRoute = await readFile(
    resolve(__dirname, '../web/app/api/runs/[id]/log/route.ts'),
    'utf-8',
  );
});

describe('history.ts — log_file in INSERT query', () => {
  it('includes log_file column in the INSERT column list', () => {
    expect(historySource).toContain('log_file');
  });

  it('includes $16 placeholder for log_file in the INSERT VALUES list', () => {
    expect(historySource).toContain('$16');
  });

  it('passes result.logFile as the 16th parameter', () => {
    expect(historySource).toContain('result.logFile ?? null');
  });

  it('adds log_file column via ALTER TABLE in the schema', () => {
    expect(historySource).toContain('ADD COLUMN IF NOT EXISTS log_file TEXT');
  });
});

describe('history.ts — RunRecord interface has log_file field', () => {
  it('declares log_file as string | null on RunRecord', () => {
    expect(historySource).toMatch(/log_file\s*:\s*string\s*\|\s*null/);
  });
});

describe('web/app/runs/[id]/page.tsx — references record.log_file', () => {
  it('conditionally renders log section when record.log_file is set', () => {
    expect(runDetailPage).toContain('record.log_file');
  });

  it('links to the log API route using record.id', () => {
    expect(runDetailPage).toMatch(/\/api\/runs\/.*record\.id.*\/log/);
  });

  it('renders the LogViewer component for the log file', () => {
    expect(runDetailPage).toContain('<LogViewer');
  });
});

describe('web/app/api/runs/[id]/log/route.ts — log API route exists and serves file', () => {
  it('exports a GET handler', () => {
    expect(logRoute).toContain('export async function GET');
  });

  it('reads record.log_file from the database', () => {
    expect(logRoute).toContain('record.log_file');
  });

  it('returns 404 when run is not found', () => {
    expect(logRoute).toContain("'Run not found'");
  });

  it('returns 404 when run has no log file', () => {
    expect(logRoute).toContain('No log file for this run');
  });

  it('serves log content as plain text', () => {
    expect(logRoute).toContain('text/plain');
  });

  it('tolerates a missing log file by returning empty body (live streaming race)', () => {
    // For in-flight runs, the runner persists the log file path BEFORE the
    // first stream-json line is appended, so a polling client can race the
    // file's existence. The route handles ENOENT by returning an empty 200
    // instead of 404, so the LogViewer can render an empty timeline and keep
    // polling rather than showing an error toast.
    expect(logRoute).toMatch(/code === 'ENOENT'/);
    expect(logRoute).toContain("new Response('', { headers: PLAIN_TEXT_HEADERS })");
  });
});
