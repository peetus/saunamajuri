---
name: commit-message
description: Use when drafting, amending or rewording any git commit message in this repo, including a message being redrafted after review. Carries this repo's commit conventions, measured from its own log, and the checklist every draft is scanned against.
---

# Commit message

**Read this for every draft, including the second draft in the same session.** Drafting against the
previous draft rather than against the rules is how the same defect survives a rewrite.

## This repo's conventions, measured from its log

Re-measure if the log grows much past its current length. Where the log and this skill disagree,
the log wins.

```bash
git log --no-merges -n 30 --format='%h%n%s%n%b%n---'
git log --no-merges -n 50 --format=%b | awk 'length()>0 {print length()}' | sort -n | tail -3
```

- **Body wrap: 74 columns.** Measured across the whole log, consistently.
- **Subjects: imperative, capitalized, no trailing period, no `:`.** "Add the rule engine and the
  Finnish day it reasons in", "Persist collected prices to DynamoDB".
- **Colons and semicolons are used inside bodies here**, from the first commit onward, and reading
  naturally. Do not strip them. This is a deliberate departure from the general convention, on the
  log's authority.
- **Bodies are the norm, not the exception**, because this repository exists to be explained. Even
  so, do not manufacture one for a mechanical change.
- **Trailer, verbatim:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Bodies

- The body explains **why, and how the change came about**, not a play-by-play of the diff.
- **Tense splits on the commit boundary.** Past for the state before, present for what the commit
  does. "Slots **were** partitioned by the UTC date. The key now **comes from** the instant rendered
  in Europe/Helsinki."
- **Open with what surfaced the problem**, where something did. A hook, a review, a failing gate, a
  deliberate probe. "typeof NaN is "number", so a NaN price passed the existing check" is a better
  opening than "adds validation".
- **The trigger earns a line only when it is a fact about the project, not about the session.** A
  standing decision that paid off is worth recording. The agent narrating its own route is filler.
  Test: would this still matter to someone reading the log in a year who does not know the session
  happened?

### No personally identifiable information

A pushed message cannot be corrected, and this repository is destined for a public remote. Concretely
here: never the maintainer's email address, and never a real address as an example — `ALERT_EMAIL`
examples use `you@example.com`. Attribute work to a review, a gate or a role, not to a person. The
author and committer fields carry the only identity Git needs.

### Body wrap

**Do not wrap by eye.** Write the body as continuous paragraphs and reflow it mechanically. Judging
a column by hand fails in both directions, and a hand-wrapped body routinely needs a repass of every
line. Filled to 74, not merely under it: any word that still fits stays.

```bash
python -c "import io,sys; L=io.open(sys.argv[1],encoding='utf-8').read().splitlines(); \
[print('long', i+1, len(l)) for i,l in enumerate(L) if i>1 and len(l)>74 and not l.startswith('Co-Authored-By')]; \
[print('early', i, len(L[i-1]), L[i].split()[0]) for i in range(2,len(L)) \
 if L[i-1] and L[i] and not L[i-1].startswith('Co-Authored-By') and not L[i].startswith('Co-Authored-By') \
 and len(L[i-1])+1+len(L[i].split()[0])<=74]" <file>

grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" <file> | grep -v "noreply@anthropic"
```

Both should print nothing. Prove that they can fail before trusting them: run them against a message
with an 80-column line and a short line followed by a word that would have fitted.

## Working practice in this repo

**The maintainer reads the staged diff before every commit, and commits it themselves.** Make the
edits, stage them, and hand the work over. Do not commit until asked, and treat the permission as
covering that commit only: agreement to commit one piece of work is not agreement to commit what
comes after it. Never push, under any circumstances - hand over the command instead.

**The message is handed over with the diff, not after it.** Put it in a fenced code block in the
reply so it copies as plain text, for anything larger than a one-line change. The point is that it
can be read, edited and argued with before it becomes history; a message written at commit time has
already missed the review it exists for. Write the draft to a scratch file, run the mechanical
checks against it, then paste the result. The file is a working copy, never the thing handed over.

## Splitting a dirty tree into several commits

See `git-workflow`, which carries the recipe and the verification this repo's pre-commit hook does
not provide.

## Why

A log that reads well in the Git CLI, and — for this repository specifically — a history that is
itself an explanation of the decisions, since that is what the project is for.
