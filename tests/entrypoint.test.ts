/**
 * Tests for entrypoint.sh — verifies Docker socket GID detection,
 * group creation, user switching, and volume ownership fixes.
 *
 * These tests parse the shell script and validate its logic structurally.
 * Integration tests (actually running in Docker) are covered by e2e.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let script: string;

beforeAll(async () => {
  script = await readFile(resolve(__dirname, '../entrypoint.sh'), 'utf-8');
});

describe('entrypoint.sh', () => {
  // ── Structure ────────────────────────────────────────────────────────────

  it('starts with shebang', () => {
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });

  it('uses set -e for fail-fast', () => {
    expect(script).toContain('set -e');
  });

  // ── Docker socket GID detection ──────────────────────────────────────────

  it('checks if docker socket exists with -S', () => {
    expect(script).toContain('[ -S /var/run/docker.sock ]');
  });

  it('reads docker socket GID via stat', () => {
    expect(script).toMatch(/stat -c '%g' \/var\/run\/docker\.sock/);
  });

  it('creates a group if GID does not exist', () => {
    expect(script).toContain('getent group "$DOCKER_GID"');
    expect(script).toContain('groupadd -g "$DOCKER_GID"');
  });

  it('adds claude user to the docker group', () => {
    expect(script).toMatch(/usermod -aG "\$DOCKER_GID" claude/);
  });

  it('does not fail if docker socket is absent (conditional block)', () => {
    // The docker block is wrapped in if [ -S ... ] ... fi
    const lines = script.split('\n');
    const ifLine = lines.findIndex((l) => l.includes('[ -S /var/run/docker.sock ]'));
    expect(ifLine).toBeGreaterThan(-1);
    // Find the outermost fi that closes this block (last fi before chown)
    const chownLine = lines.findIndex((l) => l.includes('chown'));
    const fiLines = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => i > ifLine && i < chownLine && /^\s*fi\s*$/.test(l));
    const outerFi = fiLines[fiLines.length - 1]!.i;
    // groupadd and usermod are inside the outer if block
    const groupaddLine = lines.findIndex((l) => l.includes('groupadd'));
    const usermodLine = lines.findIndex((l) => l.includes('usermod'));
    expect(groupaddLine).toBeGreaterThan(ifLine);
    expect(groupaddLine).toBeLessThan(outerFi);
    expect(usermodLine).toBeGreaterThan(ifLine);
    expect(usermodLine).toBeLessThanOrEqual(outerFi);
  });

  it('tolerates usermod failure with || true', () => {
    const usermodLine = script.split('\n').find((l) => l.includes('usermod'));
    expect(usermodLine).toContain('|| true');
  });

  // ── Volume ownership ─────────────────────────────────────────────────────

  it('fixes /home/claude ownership for stale volume UIDs', () => {
    expect(script).toMatch(/chown -R claude:claude \/home\/claude/);
  });

  it('fixes /app/logs ownership', () => {
    expect(script).toMatch(/chown -R claude:claude \/app\/logs/);
  });

  it('tolerates chown failure with || true', () => {
    const chownLines = script.split('\n').filter((l) => l.includes('chown'));
    for (const line of chownLines) {
      expect(line).toContain('|| true');
    }
  });

  // ── User drop ────────────────────────────────────────────────────────────

  it('drops to claude user via exec gosu', () => {
    expect(script).toMatch(/exec gosu claude "\$@"/);
  });

  it('passes all arguments through via $@', () => {
    expect(script).toContain('"$@"');
  });

  it('exec replaces PID 1 (no zombie processes)', () => {
    // exec must be on the gosu line — ensures PID 1 handoff
    const gosuLine = script.split('\n').find((l) => l.includes('exec gosu claude'));
    expect(gosuLine).toMatch(/^exec gosu claude/);
  });

  // ── Ordering ─────────────────────────────────────────────────────────────

  it('docker socket setup happens before user drop', () => {
    const dockerIdx = script.indexOf('docker.sock');
    const gosuIdx = script.indexOf('exec gosu');
    expect(dockerIdx).toBeLessThan(gosuIdx);
  });

  it('chown happens before user drop', () => {
    const chownIdx = script.indexOf('chown -R claude:claude /home/claude');
    const gosuIdx = script.indexOf('exec gosu');
    expect(chownIdx).toBeLessThan(gosuIdx);
  });

  it('docker socket setup happens before chown', () => {
    const dockerIdx = script.indexOf('docker.sock');
    const chownIdx = script.indexOf('chown -R claude:claude /home/claude');
    expect(dockerIdx).toBeLessThan(chownIdx);
  });
});

describe('Dockerfile consistency', () => {
  let dockerfile: string;

  beforeAll(async () => {
    dockerfile = await readFile(resolve(__dirname, '../Dockerfile'), 'utf-8');
  });

  it('installs gosu (required by entrypoint)', () => {
    expect(dockerfile).toContain('gosu');
  });

  it('creates claude user', () => {
    expect(dockerfile).toMatch(/useradd.*claude/);
  });

  it('creates /home/claude/.claude directory', () => {
    expect(dockerfile).toContain('/home/claude/.claude');
  });

  it('creates /app/logs writable by claude', () => {
    expect(dockerfile).toMatch(/mkdir.*\/app\/logs/);
    expect(dockerfile).toMatch(/chown.*claude.*\/app\/logs/);
  });

  it('copies entrypoint.sh', () => {
    expect(dockerfile).toContain('COPY entrypoint.sh');
  });

  it('sets ENTRYPOINT to entrypoint.sh', () => {
    expect(dockerfile).toMatch(/ENTRYPOINT.*entrypoint\.sh/);
  });

  it('does NOT set USER (entrypoint handles user switching)', () => {
    // After the ENTRYPOINT line, there should be no USER directive
    const lines = dockerfile.split('\n');
    const entrypointIdx = lines.findIndex((l) => l.includes('ENTRYPOINT'));
    const userAfter = lines.slice(entrypointIdx + 1).find((l) => l.match(/^USER /));
    expect(userAfter).toBeUndefined();
  });

  it('sets HOME=/home/claude', () => {
    expect(dockerfile).toContain('HOME=/home/claude');
  });
});
