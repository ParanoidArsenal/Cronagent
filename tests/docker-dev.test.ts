/**
 * Tests for dev container setup — verifies the Dockerfile dev stage
 * and docker-compose web-dev service are configured correctly so that
 * automations can run the claude CLI as a non-root user.
 *
 * These are structural tests (parse config files and assert invariants).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

let dockerfile: string;
let compose: string;
let entrypoint: string;

beforeAll(async () => {
  dockerfile = await readFile(resolve(__dirname, '../Dockerfile'), 'utf-8');
  compose = await readFile(resolve(__dirname, '../docker-compose.yml'), 'utf-8');
  entrypoint = await readFile(resolve(__dirname, '../entrypoint.sh'), 'utf-8');
});

// ── Dockerfile dev stage ──────────────────────────────────────────────────────

describe('Dockerfile dev stage', () => {
  it('defines a dev stage', () => {
    expect(dockerfile).toMatch(/^FROM\s+\S+\s+AS\s+dev$/m);
  });

  it('installs gosu (required by entrypoint.sh)', () => {
    // gosu must appear before the dev stage ends (before next FROM)
    const devSection = getDockerStage(dockerfile, 'dev');
    expect(devSection).toContain('gosu');
  });

  it('installs Docker CLI', () => {
    const devSection = getDockerStage(dockerfile, 'dev');
    expect(devSection).toMatch(/docker.*\.tgz/);
  });

  it('installs Claude CLI via npm', () => {
    const devSection = getDockerStage(dockerfile, 'dev');
    expect(devSection).toContain('@anthropic-ai/claude-code');
  });

  it('creates non-root claude user', () => {
    const devSection = getDockerStage(dockerfile, 'dev');
    expect(devSection).toMatch(/user(add|mod).*claude/);
  });

  it('creates /home/claude/.claude directory', () => {
    const devSection = getDockerStage(dockerfile, 'dev');
    expect(devSection).toContain('/home/claude/.claude');
  });

  it('sets HOME=/home/claude', () => {
    const devSection = getDockerStage(dockerfile, 'dev');
    expect(devSection).toContain('HOME=/home/claude');
  });

  it('installs git', () => {
    const devSection = getDockerStage(dockerfile, 'dev');
    expect(devSection).toMatch(/apt-get install[\s\S]*?\bgit\b/);
  });

  it('dev stage tools match runner stage', () => {
    const devSection = getDockerStage(dockerfile, 'dev');
    const runnerSection = getDockerStage(dockerfile, 'runner');
    // Both must have docker CLI
    expect(devSection).toMatch(/docker.*\.tgz/);
    expect(runnerSection).toMatch(/docker.*\.tgz/);
    // Both must have claude CLI
    expect(devSection).toContain('@anthropic-ai/claude-code');
    expect(runnerSection).toContain('@anthropic-ai/claude-code');
    // Both must have gosu
    expect(devSection).toContain('gosu');
    expect(runnerSection).toContain('gosu');
    // Both must create claude user (dev renames node→claude, runner creates new)
    expect(devSection).toMatch(/user(add|mod).*claude/);
    expect(runnerSection).toMatch(/user(add|mod).*claude/);
    // Both must have git
    expect(devSection).toMatch(/apt-get install[\s\S]*?\bgit\b/);
    expect(runnerSection).toMatch(/apt-get install[\s\S]*?\bgit\b/);
  });
});

// ── Dockerfile runner stage — git ───────────────────────────────────────────

describe('Dockerfile runner stage — git', () => {
  it('installs git in the runner (production) stage', () => {
    const runnerSection = getDockerStage(dockerfile, 'runner');
    expect(runnerSection).toMatch(/apt-get install[\s\S]*?\bgit\b/);
  });
});

// ── docker-compose.yml: profile separation ──────────────────────────────────

describe('docker-compose profile separation', () => {
  it('web service has prod profile', () => {
    const webService = getComposeService(compose, 'web');
    expect(webService).toMatch(/profiles:.*\bprod\b/);
  });

  it('web-dev service has dev profile', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).toMatch(/profiles:.*\bdev\b/);
  });

  it('web and web-dev are in different profiles (no port conflict)', () => {
    const webService = getComposeService(compose, 'web');
    const webDevService = getComposeService(compose, 'web-dev');
    // web must NOT be in dev profile
    expect(webService).not.toMatch(/profiles:.*\bdev\b/);
    // web-dev must NOT be in prod profile
    expect(webDevService).not.toMatch(/profiles:.*\bprod\b/);
  });

  it('both web services expose port 3000', () => {
    const webService = getComposeService(compose, 'web');
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webService).toMatch(/3000:3000/);
    expect(webDevService).toMatch(/3000:3000/);
  });

  it('daemon has no profile restriction (always runs)', () => {
    const daemonService = getComposeService(compose, 'daemon');
    expect(daemonService).not.toMatch(/^\s+profiles:/m);
  });
});

// ── docker-compose.yml: web-dev service ─────────────────────────────────────

describe('docker-compose web-dev service', () => {
  it('builds from Dockerfile dev target', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).toContain('target: dev');
  });

  it('uses entrypoint.sh (for gosu user drop)', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).toMatch(/entrypoint.*entrypoint\.sh/);
  });

  it('mounts Docker socket', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).toContain('/var/run/docker.sock');
  });

  it('does not mount ~/.claude (credentials via env var)', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).not.toMatch(/\.claude:\/home\/claude\/\.claude/);
    expect(webDevService).not.toMatch(/\.claude:\/root/);
  });

  it('sets HOME=/home/claude', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).toContain('HOME=/home/claude');
  });

  it('uses env_file for credentials (CLAUDE_CODE_OAUTH_TOKEN)', () => {
    const webService = getComposeService(compose, 'web');
    const webDevService = getComposeService(compose, 'web-dev');
    // Both should use env_file (which contains CLAUDE_CODE_OAUTH_TOKEN)
    expect(webService).toContain('env_file');
    expect(webDevService).toContain('env_file');
  });

  it('depends on db', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).toContain('db:');
  });

  it('mounts project source for hot reload', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).toMatch(/- \.?:\/app/);
  });
});

// ── docker-compose.yml: SSH keys for git push ────────────────────────────────

describe('docker-compose SSH key mounts', () => {
  it('web service mounts SSH keys', () => {
    const webService = getComposeService(compose, 'web');
    expect(webService).toMatch(/\.ssh:\/home\/claude\/\.ssh:ro/);
  });

  it('daemon service mounts SSH keys', () => {
    const daemonService = getComposeService(compose, 'daemon');
    expect(daemonService).toMatch(/\.ssh:\/home\/claude\/\.ssh:ro/);
  });

  it('web-dev service mounts SSH keys', () => {
    const webDevService = getComposeService(compose, 'web-dev');
    expect(webDevService).toMatch(/\.ssh:\/home\/claude\/\.ssh:ro/);
  });
});

// ── entrypoint.sh: git safe.directory ───────────────────────────────────────

describe('entrypoint.sh — git safe.directory', () => {
  it('configures git safe.directory wildcard', () => {
    expect(entrypoint).toMatch(/git config --global.*safe\.directory/);
    expect(entrypoint).toContain("'*'");
  });

  it('runs safe.directory config before dropping to claude user', () => {
    const safeIdx = entrypoint.indexOf('safe.directory');
    const execIdx = entrypoint.indexOf('exec gosu claude');
    expect(safeIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(safeIdx);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract content of a Dockerfile stage (from its FROM line to the next FROM or EOF). */
function getDockerStage(content: string, stageName: string): string {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) =>
    new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${stageName}\\s*$`).test(l),
  );
  if (startIdx === -1) throw new Error(`Stage "${stageName}" not found in Dockerfile`);

  // Find the next FROM line after startIdx
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^FROM\s/.test(l));
  return (endIdx === -1 ? lines.slice(startIdx) : lines.slice(startIdx, endIdx)).join('\n');
}

/** Extract a compose service block by name (from service key to next top-level key). */
function getComposeService(content: string, serviceName: string): string {
  const lines = content.split('\n');
  // Find the service definition line (2-space indent, service name followed by colon)
  const startIdx = lines.findIndex((l) =>
    new RegExp(`^  ${serviceName}:`).test(l),
  );
  if (startIdx === -1)
    throw new Error(`Service "${serviceName}" not found in docker-compose.yml`);

  // Collect lines until the next service (2-space indent + name:) or top-level key
  const serviceLines = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop at next service definition or top-level key (no indent)
    if (/^  \S+:/.test(line) || /^\S+:/.test(line)) break;
    serviceLines.push(line);
  }
  return serviceLines.join('\n');
}
