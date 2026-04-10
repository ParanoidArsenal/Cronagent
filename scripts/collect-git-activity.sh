#!/bin/bash
# collect-git-activity.sh — Collect git commits across configured repos
# Output format: REPO_NAME|COMMIT_HASH|COMMIT_MESSAGE (one per line)
# Consumers must split on the FIRST TWO pipes only — messages may contain |.
# Exit 0 always; empty output means no activity.
#
# Note: -e (errexit) is intentionally omitted. Error handling per repo
# is done via `|| continue` in the collection loop.

set -uo pipefail

# ── Argument parsing ───────────────────────────────────────
MODE="commits"  # default: pipe-delimited commit list
for arg in "$@"; do
  case "$arg" in
    --diffs)  MODE="diffs" ;;
    --stat)   MODE="stat" ;;
    --help|-h)
      echo "Usage: $(basename "$0") [--diffs|--stat]"
      echo "  (default)  Output REPO_NAME|HASH|MESSAGE per commit"
      echo "  --diffs    Output full diffs with stat per repo"
      echo "  --stat     Output diffstat only (no patch) per repo"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONF_FILE="$PROJECT_DIR/standup.conf"

# ── Defaults (used when standup.conf is missing) ────────────
DEFAULT_AUTHOR_EMAIL="user@example.com"
DEFAULT_REPOS=(
  ~/projects/my-app
  ~/projects/frontend
  ~/projects/e2e-tests
  ~/projects/cypress-tests
  ~/projects/monorepo
)

# ── Load config ─────────────────────────────────────────────
# Parse config safely: extract known keys only (no arbitrary code execution).
if [ -f "$CONF_FILE" ]; then
  # Read AUTHOR_EMAIL
  _conf_email=$(grep -E '^AUTHOR_EMAIL=' "$CONF_FILE" | head -1 | cut -d= -f2-)
  if [ -n "$_conf_email" ]; then
    AUTHOR_EMAIL="$_conf_email"
  fi

  # Read REPOS array: lines between REPOS=( and )
  _in_repos=false
  REPOS=()
  while IFS= read -r _line; do
    _line="${_line%%#*}"          # strip comments
    _line="${_line// /}"          # strip spaces for matching
    if [[ "$_line" == "REPOS=(" ]]; then
      _in_repos=true
      continue
    fi
    if $_in_repos; then
      if [[ "$_line" == ")" ]]; then
        _in_repos=false
        continue
      fi
      # Re-read the original line (with spaces) for the path
      :
    fi
  done < "$CONF_FILE"

  # Simpler approach: extract paths between REPOS=( and )
  REPOS=()
  _in_repos=false
  while IFS= read -r _line; do
    # Strip leading/trailing whitespace
    _trimmed="${_line#"${_line%%[![:space:]]*}"}"
    _trimmed="${_trimmed%"${_trimmed##*[![:space:]]}"}"
    # Strip inline comments
    _trimmed="${_trimmed%%#*}"
    _trimmed="${_trimmed%"${_trimmed##*[![:space:]]}"}"

    if [[ "$_trimmed" == "REPOS=(" ]]; then
      _in_repos=true
      continue
    fi
    if $_in_repos; then
      if [[ "$_trimmed" == ")" ]]; then
        break
      fi
      [ -n "$_trimmed" ] && REPOS+=("$_trimmed")
    fi
  done < "$CONF_FILE"

  # Read STANDUP_CHANNEL_ID
  _conf_channel=$(grep -E '^STANDUP_CHANNEL_ID=' "$CONF_FILE" | head -1 | cut -d= -f2-)
  if [ -n "$_conf_channel" ]; then
    export STANDUP_CHANNEL_ID="$_conf_channel"
  fi
fi

AUTHOR_EMAIL="${AUTHOR_EMAIL:-$DEFAULT_AUTHOR_EMAIL}"

# If REPOS wasn't set or is empty, use defaults
if ! declare -p REPOS &>/dev/null || [ ${#REPOS[@]} -eq 0 ]; then
  REPOS=("${DEFAULT_REPOS[@]}")
fi

# ── Compute date range ──────────────────────────────────────
DAY_OF_WEEK=$(date +%u)  # 1=Monday, 7=Sunday

if [ "$DAY_OF_WEEK" -eq 1 ]; then
  SINCE="last friday 00:00"
  RANGE_LABEL="Fri–Sun"
else
  SINCE="yesterday 00:00"
  RANGE_LABEL="yesterday"
fi

UNTIL="now"

# Export for callers that need the label
export STANDUP_RANGE_LABEL="$RANGE_LABEL"

# ── Collect git activity ────────────────────────────────────
for REPO in "${REPOS[@]}"; do
  # Expand ~ to home directory
  REPO="${REPO/#\~/$HOME}"

  # Skip if directory doesn't exist
  [ -d "$REPO" ] || continue

  # Extract repo name from path
  REPO_NAME=$(basename "$REPO")

  if [ "$MODE" = "commits" ]; then
    # Default mode: pipe-delimited commit list
    COMMITS=$(git -C "$REPO" log \
      --author="$AUTHOR_EMAIL" \
      --since="$SINCE" \
      --until="$UNTIL" \
      --oneline \
      --no-merges \
      --no-decorate \
      2>/dev/null) || continue

    [ -z "$COMMITS" ] && continue

    while IFS= read -r line; do
      HASH="${line%% *}"
      MSG="${line#* }"
      echo "${REPO_NAME}|${HASH}|${MSG}"
    done <<< "$COMMITS"

  elif [ "$MODE" = "diffs" ]; then
    # Diff mode: full patch with stat per repo
    OUTPUT=$(git -C "$REPO" log \
      --author="$AUTHOR_EMAIL" \
      --since="$SINCE" \
      --until="$UNTIL" \
      --no-merges \
      -p --stat \
      2>/dev/null) || continue

    [ -z "$OUTPUT" ] && continue

    LINE_COUNT=$(printf '%s\n' "$OUTPUT" | wc -l)
    if [ "$LINE_COUNT" -gt 500 ]; then
      # Too large — fall back to stat only
      FALLBACK=$(git -C "$REPO" log \
        --author="$AUTHOR_EMAIL" \
        --since="$SINCE" \
        --until="$UNTIL" \
        --no-merges \
        --stat \
        2>/dev/null) || continue
      OUTPUT="$FALLBACK"
      echo "=== ${REPO_NAME} (stat only, diff was ${LINE_COUNT} lines) ==="
    else
      echo "=== ${REPO_NAME} ==="
    fi
    echo "$OUTPUT"
    echo ""

  elif [ "$MODE" = "stat" ]; then
    # Stat-only mode: file change summaries
    OUTPUT=$(git -C "$REPO" log \
      --author="$AUTHOR_EMAIL" \
      --since="$SINCE" \
      --until="$UNTIL" \
      --no-merges \
      --stat \
      2>/dev/null) || continue

    [ -z "$OUTPUT" ] && continue

    echo "=== ${REPO_NAME} ==="
    echo "$OUTPUT"
    echo ""
  fi
done
