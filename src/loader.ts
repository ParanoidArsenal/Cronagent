import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { logger } from './logger.js';
import { AutomationFrontmatterSchema, ShellAutomationSchema, ComposedAutomationSchema } from './types.js';
import type { Automation } from './types.js';

/**
 * Scan the automations directory and load all definitions.
 * - .md files → Claude-mode automations (frontmatter + instructions)
 * - .yaml/.yml files → Shell-mode or composed automations
 */
export async function loadAutomations(automationsDir: string): Promise<Automation[]> {
  let entries;
  try {
    entries = await readdir(automationsDir, { withFileTypes: true });
  } catch {
    logger.warn({ automationsDir }, 'Automations directory not found');
    return [];
  }

  const automations: Automation[] = [];
  const names = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const ext = extname(entry.name);
    const filePath = join(automationsDir, entry.name);

    try {
      if (ext === '.md') {
        const automation = await loadMarkdownAutomation(filePath);
        if (names.has(automation.name)) {
          logger.warn({ name: automation.name, filePath }, 'Duplicate automation name, skipping');
          continue;
        }
        names.add(automation.name);
        automations.push(automation);
      } else if (ext === '.yaml' || ext === '.yml') {
        const automation = await loadYamlAutomation(filePath);
        if (names.has(automation.name)) {
          logger.warn({ name: automation.name, filePath }, 'Duplicate automation name, skipping');
          continue;
        }
        names.add(automation.name);
        automations.push(automation);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ filePath, error: message }, 'Failed to load automation');
    }
  }

  logger.info({ count: automations.length, dir: automationsDir }, 'Automations loaded');
  return automations;
}

async function loadMarkdownAutomation(filePath: string): Promise<Automation> {
  const raw = await readFile(filePath, 'utf-8');
  const { data, content } = matter(raw);

  const frontmatter = AutomationFrontmatterSchema.parse(data);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    trigger: frontmatter.trigger,
    schedule: frontmatter.schedule ?? null,
    timeout: frontmatter.timeout,
    mcp: frontmatter.mcp,
    model: frontmatter.model,
    instructions: content.trim(),
    filePath,
    mode: frontmatter.mode,
    sandbox: frontmatter.sandbox,
    notify: frontmatter.notify,
    maxRetries: frontmatter.maxRetries,
    retryDelayMs: frontmatter.retryDelayMs,
    conversation: frontmatter.conversation,
    maxTurns: frontmatter.maxTurns,
    preCollect: frontmatter.preCollect,
    systemPrompt: frontmatter.systemPrompt,
  };
}

async function loadYamlAutomation(filePath: string): Promise<Automation> {
  const raw = await readFile(filePath, 'utf-8');
  const data = yaml.load(raw) as Record<string, unknown>;

  // Check if it's a composed automation
  if ('compose' in data) {
    const composed = ComposedAutomationSchema.parse(data);
    return {
      name: composed.name,
      description: composed.description,
      trigger: composed.trigger,
      schedule: composed.schedule ?? null,
      timeout: 600,
      mcp: [],
      model: 'sonnet',
      instructions: JSON.stringify({ compose: composed.compose, on_complete: composed.on_complete }),
      filePath,
      mode: 'shell', // composed uses shell runner internally
      sandbox: false,
      notify: composed.notify,
      maxRetries: composed.maxRetries,
      retryDelayMs: composed.retryDelayMs,
      conversation: false,
    };
  }

  // Shell automation
  const shell = ShellAutomationSchema.parse(data);
  const stepsText = shell.steps
    .map((s) => {
      if ('shell' in s) return `$ ${s.shell}`;
      if ('http' in s) return `http: ${JSON.stringify(s.http)}`;
      return `on_failure: ${JSON.stringify(s.on_failure)}`;
    })
    .join('\n');

  return {
    name: shell.name,
    description: shell.description,
    trigger: shell.trigger,
    schedule: shell.schedule ?? null,
    timeout: shell.timeout,
    mcp: [],
    model: 'sonnet',
    instructions: stepsText,
    filePath,
    mode: 'shell',
    sandbox: shell.sandbox,
    notify: shell.notify,
    maxRetries: shell.maxRetries,
    retryDelayMs: shell.retryDelayMs,
    conversation: false,
  };
}
