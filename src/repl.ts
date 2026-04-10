import * as readline from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';
import { Runner } from './runner.js';
import { History } from './history.js';
import { Composer, isComposedAutomation } from './composer.js';
import { Scheduler } from './scheduler.js';
import { SkipList } from './skip-list.js';
import { loadAutomations } from './loader.js';
import type { Automation } from './types.js';

export class Repl {
  private runner: Runner;
  private history: History;
  private composer: Composer;
  private scheduler: Scheduler;
  private skipList?: SkipList;
  private automations: Automation[];
  private automationsDir: string;

  constructor(
    runner: Runner,
    history: History,
    scheduler: Scheduler,
    automations: Automation[],
    automationsDir: string,
    skipList?: SkipList,
  ) {
    this.runner = runner;
    this.history = history;
    this.composer = new Composer(runner, automations);
    this.scheduler = scheduler;
    this.skipList = skipList;
    this.automations = automations;
    this.automationsDir = automationsDir;
  }

  async start(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'auto> ',
    });

    console.log(`\n  cronagent v0.1.0`);
    console.log(`  ${this.automations.length} automations loaded`);
    console.log(`  Type "help" for commands\n`);

    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }

      try {
        await this.handleCommand(input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Error: ${message}`);
      }

      rl.prompt();
    });

    rl.on('close', () => {
      console.log('\nBye!');
      this.scheduler.stop();
      this.history.close().catch(() => {});
      process.exit(0);
    });
  }

  private async handleCommand(input: string): Promise<void> {
    const [cmd, ...args] = input.split(/\s+/);

    switch (cmd) {
      case 'help':
        this.showHelp();
        break;

      case 'list':
      case 'ls':
        this.listAutomations();
        break;

      case 'run': {
        const name = args[0];
        if (!name) {
          console.log('  Usage: run <automation-name>');
          break;
        }
        await this.runAutomation(name);
        break;
      }

      case 'history': {
        const name = args[0];
        const limit = parseInt(args[1] ?? '10', 10);
        await this.showHistory(name, limit);
        break;
      }

      case 'status':
        this.showScheduleStatus();
        break;

      case 'new': {
        const name = args[0];
        if (!name) {
          console.log('  Usage: new <automation-name>');
          break;
        }
        await this.scaffoldAutomation(name);
        break;
      }

      case 'reload':
        await this.reloadAutomations();
        break;

      case 'cost':
        await this.showCost();
        break;

      case 'skip-list': {
        const sub = args[0];
        if (sub === 'clear' && args[1]) {
          await this.skipList?.remove(args[1]);
          console.log(`  Cleared "${args[1]}" from skip list.`);
        } else if (sub === 'clear-all') {
          await this.skipList?.clear();
          console.log('  Skip list cleared.');
        } else {
          const entries = await this.skipList?.list() ?? [];
          if (entries.length === 0) {
            console.log('  Skip list is empty.');
          } else {
            console.log('');
            for (const e of entries) {
              console.log(`  ${e.automationName.padEnd(20)} ${e.consecutiveFailures} failures  since ${e.addedAt}`);
            }
            console.log('');
          }
        }
        break;
      }

      case 'exit':
      case 'quit':
        process.exit(0);
        break;

      default:
        console.log(`  Unknown command: ${cmd}. Type "help" for available commands.`);
    }
  }

  private showHelp(): void {
    console.log(`
  Commands:
    list                 List all automations
    run <name>           Execute an automation
    history [name] [n]   Show last n runs (default: 10)
    status               Show scheduled cron jobs
    new <name>           Scaffold a new automation
    reload               Reload automations from disk
    cost                 Show total LLM spend
    skip-list            Show skipped automations
    skip-list clear <n>  Remove automation from skip list
    skip-list clear-all  Clear entire skip list
    help                 Show this help
    exit                 Quit
`);
  }

  private listAutomations(): void {
    if (this.automations.length === 0) {
      console.log('  No automations found.');
      return;
    }

    console.log('');
    const maxName = Math.max(...this.automations.map((a) => a.name.length), 4);

    for (const a of this.automations) {
      const trigger = a.trigger === 'cron' ? `cron(${a.schedule})` : a.trigger;
      const mode = a.mode === 'claude' ? 'claude' : 'shell';
      console.log(
        `  ${a.name.padEnd(maxName + 2)} ${mode.padEnd(8)} ${trigger.padEnd(25)} ${a.description}`,
      );
    }
    console.log('');
  }

  private async runAutomation(name: string): Promise<void> {
    const automation = this.automations.find((a) => a.name === name);
    if (!automation) {
      console.log(`  Automation "${name}" not found. Use "list" to see available.`);
      return;
    }

    console.log(`  Running "${name}" (${automation.mode} mode)...`);

    let result;
    // Check if it's a composed automation
    if (isComposedAutomation(automation.instructions)) {
      result = await this.composer.execute(automation);
    } else {
      result = await this.runner.execute(automation);
    }

    await this.history.insert(result);

    if (result.success) {
      console.log(`\n  [OK] Completed in ${result.durationMs}ms`);
      if (result.costUsd) {
        console.log(`  Cost: $${result.costUsd.toFixed(4)}`);
      }
      if (result.output) {
        console.log(`\n${result.output}\n`);
      }
    } else {
      console.log(`\n  [FAIL] ${result.error}`);
      if (result.output) {
        console.log(`\n${result.output}\n`);
      }
    }
  }

  private async showHistory(name?: string, limit = 10): Promise<void> {
    const records = await this.history.getHistory(name, limit);
    if (records.length === 0) {
      console.log('  No execution history found.');
      return;
    }

    console.log('');
    for (const r of records) {
      const status = r.success ? 'OK' : 'FAIL';
      const cost = r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : '-';
      const time = r.started_at.toLocaleString();
      console.log(
        `  ${time}  ${r.automation_name.padEnd(20)} ${status.padEnd(6)} ${String(r.duration_ms).padEnd(8)}ms  ${cost}`,
      );
      if (!r.success && r.error) {
        console.log(`    Error: ${r.error.slice(0, 100)}`);
      }
    }
    console.log('');
  }

  private showScheduleStatus(): void {
    const status = this.scheduler.getStatus();
    if (status.length === 0) {
      console.log('  No scheduled jobs.');
      return;
    }

    console.log('');
    for (const s of status) {
      const running = s.running ? ' [RUNNING]' : '';
      console.log(
        `  ${s.name.padEnd(20)} ${(s.schedule ?? '-').padEnd(20)} next: ${s.nextRun ?? 'never'}${running}`,
      );
    }
    console.log('');
  }

  private async scaffoldAutomation(name: string): Promise<void> {
    const filePath = join(this.automationsDir, `${name}.md`);
    const content = `---
name: ${name}
description: ""
trigger: manual
timeout: 300
mcp: []
model: sonnet
---

# ${name}

Describe what this automation should do.

## Steps

1. First step
2. Second step
`;

    await writeFile(filePath, content, 'utf-8');
    console.log(`  Created: ${filePath}`);
    console.log(`  Edit the file, then run "reload" to pick up changes.`);
  }

  private async reloadAutomations(): Promise<void> {
    this.automations = await loadAutomations(this.automationsDir);
    this.composer = new Composer(this.runner, this.automations);
    console.log(`  Reloaded: ${this.automations.length} automations`);
  }

  private async showCost(): Promise<void> {
    const total = await this.history.getTotalCost();
    console.log(`  Total LLM spend: $${total.toFixed(4)}`);
  }
}
