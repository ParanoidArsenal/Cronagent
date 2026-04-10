#!/bin/bash
# collect-standup-data.sh — Pre-collect git data for standup automation
# Outputs structured text that gets appended to the Claude prompt.
set -uo pipefail

AUTHOR_EMAIL="user@example.com"
REPOS=(
  ~/projects/my-app
  ~/projects/frontend
  ~/projects/e2e-tests
  ~/projects/cypress-tests
  ~/projects/monorepo
)

# Try to load standup.conf
for conf in ./standup.conf /app/standup.conf /app/standup.conf; do
  if [ -f "$conf" ]; then
    _email=$(grep -E '^AUTHOR_EMAIL=' "$conf" 2>/dev/null | head -1 | cut -d= -f2-)
    [ -n "$_email" ] && AUTHOR_EMAIL="$_email"
    # Parse REPOS array
    _in=false; _repos=()
    while IFS= read -r _line; do
      _t="${_line#"${_line%%[![:space:]]*}"}"
      _t="${_t%%#*}"
      _t="${_t%"${_t##*[![:space:]]}"}"
      [[ "$_t" == "REPOS=(" ]] && _in=true && continue
      $_in && [[ "$_t" == ")" ]] && break
      $_in && [ -n "$_t" ] && _repos+=("$_t")
    done < "$conf"
    [ ${#_repos[@]} -gt 0 ] && REPOS=("${_repos[@]}")
    break
  fi
done

# Date range
DOW=$(date +%u)
if [ "$DOW" -eq 1 ]; then
  SINCE=$(date -d 'last friday' '+%Y-%m-%d' 2>/dev/null || echo "$(date -d '3 days ago' '+%Y-%m-%d')")
  echo "date_range: Пт-Вс ($SINCE — сегодня)"
  echo "is_monday: true"
else
  SINCE=$(date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || echo "$(date -d '1 day ago' '+%Y-%m-%d')")
  echo "date_range: Вчера ($SINCE — сегодня)"
  echo "is_monday: false"
fi
echo "since_date: $SINCE"
echo "jql: assignee = currentUser() AND updated >= \"$SINCE\" ORDER BY updated DESC"
echo ""

# Git activity
echo "### Git commits"
found_any=false
for repo in "${REPOS[@]}"; do
  repo="${repo/#\~/$HOME}"
  [ -d "$repo/.git" ] || continue
  name=$(basename "$repo")
  # -c safe.directory='*' bypasses Git's dubious-ownership check when running
  # inside a container where repo files are owned by a different host UID.
  commits=$(git -c safe.directory='*' -C "$repo" log --author="$AUTHOR_EMAIL" --since="$SINCE 00:00" --until="now" --oneline --no-merges 2>/dev/null)
  [ -z "$commits" ] && continue
  found_any=true
  echo "#### $name"
  echo "$commits"
  echo ""
done
$found_any || echo "(no git commits found)"
