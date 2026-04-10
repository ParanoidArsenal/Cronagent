import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from './logger.js';

export interface SeedResult {
  created: string[];
  skipped: string[];
}

interface DemoFile {
  filename: string;
  content: string;
}

const DEMOS: DemoFile[] = [
  {
    filename: 'demo-summarize-readme.md',
    content: `---
name: demo-summarize-readme
description: Summarize the README.md in the current directory
trigger: manual
timeout: 60
mcp: []
model: sonnet
sandbox: false
---

# Summarize README

Read the README.md file in the current working directory and produce a concise summary.

## Steps

1. Read the contents of README.md
2. Identify the project name, purpose, and key features
3. Output a 3-5 sentence summary covering:
   - What the project does
   - Who it is for
   - How to get started
`,
  },
  {
    filename: 'demo-code-review.md',
    content: `---
name: demo-code-review
description: Review staged git changes and suggest improvements
trigger: manual
timeout: 120
mcp: []
model: sonnet
sandbox: false
---

# Code Review

Review the currently staged git changes and provide actionable feedback.

## Steps

1. Run \`git diff --cached\` to see staged changes
2. For each changed file, analyze:
   - Correctness: logic errors, edge cases, off-by-one mistakes
   - Style: naming, formatting, consistency with surrounding code
   - Security: injection risks, credential exposure, input validation
3. Output a structured review with:
   - A one-line verdict (approve / request changes)
   - List of findings sorted by severity (critical → minor)
   - Suggested fixes as code snippets where applicable
`,
  },
  {
    filename: 'demo-daily-digest.md',
    content: `---
name: demo-daily-digest
description: Summarize yesterday's git activity
trigger: cron
schedule: "0 9 * * 1-5"
timeout: 60
mcp: []
model: sonnet
sandbox: false
---

# Daily Git Digest

Produce a summary of git activity from the last 24 hours.

## Steps

1. Run \`git log --since="24 hours ago" --oneline --all\` to get recent commits
2. Group commits by author
3. For each author, summarize what they worked on in 1-2 sentences
4. Highlight any merge commits or branch activity
5. Output a digest formatted as a brief daily standup report
`,
  },
  {
    filename: 'demo-disk-usage.yaml',
    content: `name: demo-disk-usage
description: Report disk usage for the current directory
trigger: manual
timeout: 30
sandbox: false
steps:
  - shell: echo "=== Disk Usage Report ==="
  - shell: du -sh . 2>/dev/null || echo "Unable to calculate total size"
  - shell: echo "--- Top 10 largest items ---"
  - shell: du -sh ./* 2>/dev/null | sort -rh | head -10 || echo "No items found"
  - shell: echo "--- File type breakdown ---"
  - shell: find . -maxdepth 3 -type f 2>/dev/null | sed 's/.*\\.//' | sort | uniq -c | sort -rn | head -10 || echo "No files found"
`,
  },
  {
    filename: 'demo-git-cleanup.yaml',
    content: `name: demo-git-cleanup
description: List merged branches that can be safely deleted
trigger: manual
timeout: 30
sandbox: false
steps:
  - shell: echo "=== Merged Branches (safe to delete) ==="
  - shell: git branch --merged main 2>/dev/null | grep -v '\\*\\|main\\|master' || echo "No merged branches found"
  - shell: echo "--- Stale remote-tracking branches ---"
  - shell: git remote prune origin --dry-run 2>/dev/null || echo "No stale remote branches"
`,
  },
  {
    filename: 'demo-full-review.yaml',
    content: `name: demo-full-review
description: Composed workflow — summarize README then review staged code
trigger: manual
compose:
  - demo-summarize-readme
  - demo-code-review
`,
  },
];

export async function seedDemos(dir: string, force: boolean): Promise<SeedResult> {
  const resolvedDir = resolve(dir);
  await mkdir(resolvedDir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  for (const demo of DEMOS) {
    const filePath = resolve(resolvedDir, demo.filename);
    if (!filePath.startsWith(resolvedDir + '/')) {
      throw new Error(`Refusing to write outside target directory: ${demo.filename}`);
    }

    if (!force) {
      try {
        await writeFile(filePath, demo.content, { encoding: 'utf-8', flag: 'wx' });
        created.push(demo.filename);
        logger.debug({ file: demo.filename }, 'Created demo automation');
        continue;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          skipped.push(demo.filename);
          logger.debug({ file: demo.filename }, 'Skipped (already exists)');
          continue;
        }
        throw err;
      }
    }

    await writeFile(filePath, demo.content, 'utf-8');
    created.push(demo.filename);
    logger.debug({ file: demo.filename }, 'Created demo automation');
  }

  return { created, skipped };
}

export { DEMOS };
