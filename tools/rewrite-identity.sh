#!/usr/bin/env bash
#
# Take the author's personal name and email out of the git history.
#
#   ./tools/rewrite-identity.sh          # show what would change, change nothing
#   ./tools/rewrite-identity.sh --apply  # rewrite, then print the push command
#
# WHAT IT DOES
# Every commit authored by the OLD address is re-authored as "Tvara
# <tvara.exten@gmail.com>". Commit messages, dates, parents and file contents
# are untouched. Any commit by anyone ELSE is left exactly as it is: this repo
# has real commits from a second contributor, and rewriting those would be
# taking credit for someone else's work.
#
# WHAT IT COSTS
# Every commit hash changes, so the remote has to be force-pushed and anyone
# holding a clone has to re-clone. That is fine before launch and painful after.
#
# A full backup is written first. To undo:
#     git fetch ~/tvara-backup-before-rewrite.bundle '*:*'
set -euo pipefail

OLD_EMAIL="tharuntejandhe@gmail.com"
NEW_NAME="Tvara"
NEW_EMAIL="tvara.exten@gmail.com"
BACKUP="$HOME/tvara-backup-before-rewrite.bundle"

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✋ Working tree is not clean. Commit or stash first."
  git status --short
  exit 1
fi

echo
echo "Identities in the history right now:"
git log --format='%an <%ae>' --all | sort | uniq -c | sort -rn | sed 's/^/   /'
echo
MINE="$(git log --all --format='%ae' | grep -c "^${OLD_EMAIL}$" || true)"
OTHERS="$(git log --all --format='%ae' | grep -vc "^${OLD_EMAIL}$" || true)"
echo "   → ${MINE} commit(s) would be re-authored as ${NEW_NAME} <${NEW_EMAIL}>"
echo "   → ${OTHERS} commit(s) by other people would be left untouched"
echo

if [[ "${1:-}" != "--apply" ]]; then
  echo "Dry run. Nothing changed. Re-run with --apply to do it."
  exit 0
fi

if [[ ! -f "$BACKUP" ]]; then
  echo "→ backing up every ref to $BACKUP"
  git bundle create "$BACKUP" --all >/dev/null
fi
echo "  ✓ backup at $BACKUP"

echo "→ rewriting…"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter "
if [ \"\$GIT_AUTHOR_EMAIL\" = '${OLD_EMAIL}' ]; then
  export GIT_AUTHOR_NAME='${NEW_NAME}'
  export GIT_AUTHOR_EMAIL='${NEW_EMAIL}'
fi
if [ \"\$GIT_COMMITTER_EMAIL\" = '${OLD_EMAIL}' ]; then
  export GIT_COMMITTER_NAME='${NEW_NAME}'
  export GIT_COMMITTER_EMAIL='${NEW_EMAIL}'
fi
" --tag-name-filter cat -- --all >/dev/null 2>&1

# So the next commit made here does not put the old address straight back.
git config user.name "$NEW_NAME"
git config user.email "$NEW_EMAIL"

echo
echo "Identities now:"
git log --format='%an <%ae>' --all | sort | uniq -c | sort -rn | sed 's/^/   /'
echo
if git log --format='%ae' --all | grep -q "^${OLD_EMAIL}$"; then
  echo "✋ The old address is STILL present. Do not push; tell Claude."
  exit 1
fi
echo "  ✓ the old address is gone from every commit"
echo "  ✓ this repo will now commit as ${NEW_NAME} <${NEW_EMAIL}>"
echo
echo "Nothing has been pushed. When you are ready:"
echo
echo "    git push --force-with-lease origin main"
echo
echo "Anyone holding a clone (including Anirudh) must re-clone afterwards."
