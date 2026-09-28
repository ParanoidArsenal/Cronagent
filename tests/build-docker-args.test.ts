/**
 * Snapshot tests for buildDockerArgs.
 *
 * Pins the exact docker arg array so any change to sandbox isolation flags
 * (read-only rootfs, resource caps, nosuid, no-new-privileges) shows up
 * as a diff in code review.
 */

import { describe, it, expect } from 'vitest';
import { buildDockerArgs } from '../src/runner.ts';

describe('buildDockerArgs', () => {
  it('minimum case — only required fields', () => {
    expect(
      buildDockerArgs({
        image: 'cronagent-sandbox',
        timeout: 60,
        cmd: 'echo hello',
      }),
    ).toMatchInlineSnapshot(`
      [
        "run",
        "--rm",
        "--network",
        "bridge",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,size=256m",
        "--tmpfs",
        "/workspace:rw,nosuid,size=128m",
        "--tmpfs",
        "/home/sandbox/.claude:rw,nosuid,size=16m,uid=1001,gid=1001",
        "--security-opt",
        "no-new-privileges",
        "--stop-timeout",
        "60",
        "cronagent-sandbox",
        "echo hello",
      ]
    `);
  });

  it('with envVars', () => {
    expect(
      buildDockerArgs({
        image: 'cronagent-sandbox',
        timeout: 120,
        cmd: 'cat /tmp/prompt.txt | claude --print',
        envVars: {
          CLAUDE_CODE_OAUTH_TOKEN: 'tok_abc',
          _PROMPT: 'do stuff',
        },
      }),
    ).toMatchInlineSnapshot(`
      [
        "run",
        "--rm",
        "--network",
        "bridge",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,size=256m",
        "--tmpfs",
        "/workspace:rw,nosuid,size=128m",
        "--tmpfs",
        "/home/sandbox/.claude:rw,nosuid,size=16m,uid=1001,gid=1001",
        "--security-opt",
        "no-new-privileges",
        "--stop-timeout",
        "120",
        "-e",
        "CLAUDE_CODE_OAUTH_TOKEN=tok_abc",
        "-e",
        "_PROMPT=do stuff",
        "cronagent-sandbox",
        "cat /tmp/prompt.txt | claude --print",
      ]
    `);
  });

  it('with mounts — ro and rw', () => {
    expect(
      buildDockerArgs({
        image: 'cronagent-sandbox',
        timeout: 30,
        cmd: 'ls /workspace',
        mounts: [
          { src: '/host/data', dst: '/workspace/data', ro: true },
          { src: '/host/out', dst: '/workspace/out' },
        ],
      }),
    ).toMatchInlineSnapshot(`
      [
        "run",
        "--rm",
        "--network",
        "bridge",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,size=256m",
        "--tmpfs",
        "/workspace:rw,nosuid,size=128m",
        "--tmpfs",
        "/home/sandbox/.claude:rw,nosuid,size=16m,uid=1001,gid=1001",
        "--security-opt",
        "no-new-privileges",
        "--stop-timeout",
        "30",
        "-v",
        "/host/data:/workspace/data:ro",
        "-v",
        "/host/out:/workspace/out:rw",
        "cronagent-sandbox",
        "ls /workspace",
      ]
    `);
  });

  it('with stdin', () => {
    expect(
      buildDockerArgs({
        image: 'cronagent-sandbox',
        timeout: 30,
        cmd: 'cat',
        stdin: true,
      }),
    ).toMatchInlineSnapshot(`
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "bridge",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,size=256m",
        "--tmpfs",
        "/workspace:rw,nosuid,size=128m",
        "--tmpfs",
        "/home/sandbox/.claude:rw,nosuid,size=16m,uid=1001,gid=1001",
        "--security-opt",
        "no-new-privileges",
        "--stop-timeout",
        "30",
        "cronagent-sandbox",
        "cat",
      ]
    `);
  });
});
