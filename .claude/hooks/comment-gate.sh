#!/bin/sh
# Stop hook. Refuses to let the turn end while the working tree holds comments
# that have not been through the comment-check skill.
#
# The skill's own trigger - "before handing work back" - is a state only the
# agent observes, at the moment it is most loaded, so it does not fire. This
# moves the trigger to the harness.
#
# Exit 0 lets the turn end. Exit 2 feeds stderr back to the agent.

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
gitdir=$(git rev-parse --git-dir 2>/dev/null) || exit 0

# Comments added to tracked files, plus every comment in new untracked ones.
# Shell as well as TypeScript: a script's comments are code comments too.
tracked=$(git diff HEAD -- '*.ts' '*.sh' 2>/dev/null | grep -E '^\+[[:space:]]*(//|\*|/\*|#)' | grep -v '^+#!')
untracked=""
for f in $(git ls-files --others --exclude-standard -- '*.ts' '*.sh' 2>/dev/null); do
  untracked="$untracked
$(grep -hE '^[[:space:]]*(//|\*|/\*|#)' "$f" 2>/dev/null | grep -v '^#!')"
done

# Approval is per line of comment text rather than per set. A set re-arms every
# time a commit takes approved comments out of the diff, and a gate that cries
# wolf gets waved through, which is the failure it exists to prevent.
current="$gitdir/comment-check-current"
approved="$gitdir/comment-check-approved"

printf '%s\n%s\n' "$tracked" "$untracked" |
  sed -E 's/^\+//' |
  sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' |
  grep -v '^$' |
  sort -u >"$current"

[ -s "$current" ] || exit 0
[ -f "$approved" ] || : >"$approved"

unread=$(comm -23 "$current" "$approved")
[ -z "$unread" ] && exit 0

# The mechanical subset only. Reading catches narrated history and the same fact
# stated in two files, so a clean scan here is not a clean diff.
mechanical=$(printf '%s\n' "$unread" | grep -E '—|;|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z][A-Za-z]+' | grep -v 'noreply@anthropic')

{
  echo "comment-gate: $(printf '%s\n' "$unread" | wc -l | tr -d ' ') comment line(s) not yet read against the rules."
  echo
  printf '%s\n' "$unread" | sed 's/^/  /'
  echo
  if [ -n "$mechanical" ]; then
    echo "Mechanical hits (em-dash, semicolon, address):"
    printf '%s\n' "$mechanical" | sed 's/^/  /'
    echo
  fi
  echo "Read them in place, not as the list above, since several rules are about"
  echo "a comment's relationship to its surroundings. Then record the pass:"
  echo
  echo "  cat \"$current\" >>\"$approved\" && sort -u -o \"$approved\" \"$approved\""
} >&2

exit 2
