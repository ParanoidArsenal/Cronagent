---
name: standup
description: "Daily standup report: cross-referenced Jira tasks, GitLab MRs, git activity, and merged work"
trigger: cron
timeout: 300
model: sonnet
sandbox: false
schedule: "0 9 * * 1-5"
mcp:
  - jira
  - gitlab
  - mattermost
notify:
  telegram: true
maxRetries: 2
retryDelayMs: 10000
maxTurns: 100
preCollect: bash /app/scripts/collect-standup-data.sh
systemPrompt: |
  Available MCP tools (do NOT use ToolSearch to discover them, call them directly):
  - mcp__jira__jira_search — JQL search
  - mcp__gitlab__list_my_merge_requests — list MRs by state
  - mcp__mattermost__send_message — post to a channel

  Large tool responses may be truncated. Work with whatever visible data you get; do NOT try to Read or re-fetch truncated tool results via Bash/Read workarounds.
---

# Ежедневный стендап-отчёт

Собрать вчерашнюю работу из Jira и GitLab, объединить с предварительно собранными git-данными (см. секцию "Pre-collected data" в конце этого промпта) и сформировать стендап-отчёт на русском языке.

**ВАЖНО**: Git-данные, диапазон дат и JQL уже собраны и находятся в секции "Pre-collected data" в конце. Не вызывай Bash для сбора git/даты/конфига — используй готовые данные.

---

## Step 1-3: Pre-collected (see bottom of prompt)

Данные уже собраны:
- `date_range` — диапазон дат
- `since_date` — начальная дата для JQL/API
- `jql` — готовый JQL для Jira
- `is_monday` — флаг понедельника (для заголовка "Сделано (пт-вс)")
- Git commits — список коммитов по репозиториям

Извлеки эти значения из секции "Pre-collected data" и используй их напрямую.

## Step 4: Collect Jira + GitLab (parallel)

**Make these 3 tool calls in a SINGLE turn (parallel)** to save round-trips:

1. `mcp__jira__jira_search` with the pre-computed `jql` from "Pre-collected data". Pass only `{ "jql": "<jql string>" }` — do **not** pass a `fields` parameter (the default response already includes summary, status, type, priority, and assignee). If you do pass `fields`, it must be a JSON array of strings, never a comma-separated string, or Jira will return 400.
2. `mcp__gitlab__list_my_merge_requests` with `{ "state": "merged", "per_page": 20 }`.
3. `mcp__gitlab__list_my_merge_requests` with `{ "state": "opened", "per_page": 10 }`.

For each issue returned, extract:
- Issue key (e.g., CAILA-1234)
- Summary
- Status name (Done, In Progress, Blocked, In Review, etc.)

Group issues by status name:
- **Done**: status is "Done", "Closed", "Resolved", "Released"
- **In Progress**: status is "In Progress", "In Review", "In Development", "Code Review"
- **Blocked**: status is "Blocked", "On Hold", "Waiting", "Impediment"
- **Unknown statuses**: default to **In Progress** (Doing today) — do not drop them

If Jira MCP is unavailable or the `jira_search` tool call fails, add "(Jira недоступна)" note in the output and continue with other sources.

## Step 5: Collect GitLab MR activity

Use `list_my_merge_requests` to collect MR data. If unavailable, add "(GitLab недоступен)" and continue.

**IMPORTANT**: The MR responses can be very large. Do NOT attempt to re-read or re-fetch truncated tool responses via Read, Bash, or any workaround. Work only with the data returned directly by the tool call. If truncated, use whatever MRs are visible.

### 5a. Fetch merged MRs

Call `list_my_merge_requests` with `{ "state": "merged", "per_page": 20 }`. Filter to MRs where `merged_at` is within the date range from Step 2.

For each MR extract: `iid`, `title`, `source_branch`, `references`, `web_url`, `merged_at`. Extract project name from `references` (part before `!`).

### 5b. Fetch open MRs (optional, skip if short on time)

Call `list_my_merge_requests` with `{ "state": "opened", "per_page": 10 }`.

Only process the first 10 MRs returned. For each: if `updated_at` is >2 days ago, mark as **stale** (Attention). Otherwise skip — open MRs are lower priority for the standup.

### 5c. Error handling

If either call fails or response is truncated, add "(GitLab недоступен)" and continue.

## Step 6: Cross-reference and deduplicate

Merge the three data sources into deduplicated standup lines. Use three tracking sets — `claimed_commits`, `claimed_jira_keys`, `claimed_mr_ids` — all initially empty. An item added to a tracking set must not appear as a separate entry again.

This is a two-pass process. Pass 1 (steps 6a) builds associations. Pass 2 (step 6b) assigns sections and emits lines. This avoids forward-reference issues between steps.

### 6a. Pass 1 — Build associations

Scan all data to build a map of related items. For each association found, record it but do not assign sections yet.

**Commit → Jira**: For each commit, scan its message for Jira issue keys using the regex `[A-Z]+-\d+`. Take the **first** key found. If that key matches a Jira issue collected in Step 4, associate the commit with that Jira ticket. Add the commit to `claimed_commits` and the Jira key to `claimed_jira_keys`. If multiple commits match the same Jira key, they all associate with the same ticket (one output line).

**Commit → MR**: For each commit (claimed or unclaimed), compare its `repo_name` to the project name extracted from each MR's `references.full` (the last path component before `!`). If a match is found, associate the commit with that MR and add the MR to `claimed_mr_ids`.

**MR → Jira via source_branch**: For each unclaimed MR (not in `claimed_mr_ids`), scan its `source_branch` for Jira issue keys using the regex `[A-Z]+-\d+`. If a key matches an unclaimed Jira issue from Step 4, associate them. Add the Jira key to `claimed_jira_keys` and the MR to `claimed_mr_ids`.

### 6b. Pass 2 — Assign sections and build output lines

Using the associations from 6a, build the final output lines. For each group of associated items, determine the section and format.

**Link rules (apply to all lines below)**:
- Render Jira ticket IDs as Markdown links: `[TICKET-ID](JIRA_BASE_URL/browse/TICKET-ID)`. Use `JIRA_BASE_URL=https://your-org.atlassian.net` unless overridden in `standup.conf`.
- Render MR references as Markdown links using the MR's `web_url`: `[MR !N](web_url)`.
- Keep the surrounding text (summary, project name, status) as plain text.

**Items with a Jira ticket association** (from commit→Jira or MR→Jira matches):
- **Section assignment — override rule**: if the Jira ticket has an associated merged MR (from any match path), assign to **Done** regardless of Jira status. Otherwise, use the Jira status (Done/Doing/Blocked per Step 4 rules). The merged MR is ground truth — if the Jira status is "In Progress" but a merged MR exists, promote to **Done**.
- **Format with both Jira and merged MR**: `[TICKET-ID](jira-url) Jira summary (repo_name) — [MR !N](mr-url) merged`
- **Format with Jira and open MR**: `[TICKET-ID](jira-url) Jira summary — [MR !N](mr-url) in review`
- **Format with Jira only** (no MR match): `[TICKET-ID](jira-url) Jira summary (repo_name)`
- Use the Jira summary (not the commit message) as the description

**Unclaimed commits** (not in `claimed_commits`): group by `repo_name`. For each group, use the **summaries** from Step 3b (which are always populated — either diff-based or commit-message fallback):
- Emit one line per summary item: `repo_name: summary text`
- If multiple summary items exist for the repo, emit multiple lines
- Assign to **Done**

**Unclaimed Jira issues** (not in `claimed_jira_keys`): emit each with its status-based section:
- `[TICKET-ID](jira-url) Jira summary (status)` → section per Step 4 classification (Done/Doing/Blocked)

**Unclaimed MRs** (not in `claimed_mr_ids`): emit based on state (always link `MR !N` to `web_url`):
- Merged → **Done**: `[MR !N](web_url) merged — Title (project-name)`
- Open, not stale → **Doing**: `[MR !N](web_url) — waiting for review (project-name)`
- Open, stale → **Attention**: `[MR !N](web_url) — without review for N days (project-name)`

### 6c. Cross-section dedup check

After assembling all sections, verify: no Jira ticket key appears in more than one section. If a duplicate is found, keep the entry in the higher-priority section (Done > Doing > Blocked) and suppress it from the lower-priority section.

Note: MR references **may** appear in multiple sections when they serve different roles. For example, MR !457 may appear in Done (as context for merged work: `[CAILA-1235] Fixed i18n sync — MR !457 in review`) and also in Doing (as an action item: `MR !457 — address review comments`). This is intentional — the Done entry describes completed work, the Doing entry describes a next action.

## Step 7: Format the standup

Use today's date formatted as DD.MM.YYYY.

```markdown
## Стендап — DD.MM.YYYY

### Сделано вчера
- [[TICKET-ID](jira-url)] Описание (repo) — [MR !N](mr-url) влит
- repo-name: Краткое описание сделанной работы на основе диффов

### Планы на сегодня
- [[TICKET-ID](jira-url)] Описание (В работе)
- [MR !N](mr-url) — ожидает ревью / доработка по замечаниям

### Заблокировано
- [[TICKET-ID](jira-url)] Описание (Заблокировано — причина, если известна)

### Внимание
- [MR !N](mr-url) — без ревью N дней
```

Note: the "Сделано вчера" items for unclaimed commits use **diff-based summaries** from Step 3b, not raw commit messages. Each summary describes what was actually done based on the code changes.

Rules:
- If a section is empty, omit it entirely (не выводить пустые секции)
- If ALL sections are empty, output: "Вчера активности не было"
- Keep each line concise — one line per item
- Include ticket IDs and MR numbers where available
- For Monday standups, header says "Сделано (пт–вс)" instead of "Сделано вчера"
- All output text must be in Russian

## Step 8: Deliver the standup

### 8a. Always print to stdout

Output the full formatted standup (from Step 7) to the conversation. This happens unconditionally — even if Mattermost posting succeeds, the standup is always visible in the conversation.

### 8b. Post to Mattermost (if configured)

Check whether `STANDUP_CHANNEL_ID` was read from `standup.conf` in Step 1 and is **non-empty** (not blank, not missing).

**If `STANDUP_CHANNEL_ID` is empty or was not set**: skip Mattermost posting entirely. Output:
> Mattermost не настроен — стендап выведен только в консоль

**If `STANDUP_CHANNEL_ID` is non-empty**: attempt to post using the `mcp__mattermost__send_message` tool:

- **Tool**: `mcp__mattermost__send_message`
- **Parameters**:
  - `channel_id`: the value of `STANDUP_CHANNEL_ID` from config
  - `message`: the full formatted standup markdown from Step 7 (the entire output including headers and bullet points)

**If the `send_message` tool call succeeds**: output:
> Отправлено в Mattermost

**If the `send_message` tool call fails** (tool not available, network error, invalid channel, authentication failure, or any other error): do NOT fail the standup. Output:
> Не удалось отправить в Mattermost — стендап выведен только в консоль

This follows the same graceful degradation pattern as Jira and GitLab: delivery failure never prevents the standup from being generated and displayed.

---

## Default repo list (used when standup.conf is missing)

```
~/projects/my-app
~/projects/frontend
~/projects/e2e-tests
~/projects/cypress-tests
~/projects/monorepo
```

## Error handling

- Repo doesn't exist → skip silently
- Git command fails → skip repo, continue
- Jira unavailable → add note "(Jira недоступна)", continue
- GitLab unavailable → add note "(GitLab недоступен)", continue
- Mattermost unavailable → print to stdout only
- No activity at all → output "Вчера активности не было"
