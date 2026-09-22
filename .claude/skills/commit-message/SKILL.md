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
git log --no-merges -n 50 --format=%b | awk 'length($0)>0 {print length($0)}' | sort -n | tail -3
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
python -c "import io,sys,textwrap; src,dst,w=sys.argv[1],sys.argv[2],int(sys.argv[3]); \
s=io.open(src,encoding='utf-8').read(); \
io.open(dst,'w',encoding='utf-8',newline='\n').write('\n\n'.join(textwrap.fill( \
' '.join(p.split()),width=w,break_long_words=False,break_on_hyphens=False) \
for p in s.split('\n\n'))+'\n')" <body-in> <body-out> 74
```

It writes to a file rather than printing, because Python on Windows translates a redirected `print`
to CRLF. Keep the subject and the trailer out of the reflow.

## Scan every draft against this list

The marked entries recur. Knowing a rule does not gate writing prose, which is why this list is
separate from the conventions above.

- **Body lines over 74 (recurs).** Count them, do not eyeball.
- **Lines broken early (recurs).** A draft can sit entirely under 74 and still be wrong on every
  line. This is the check most often absent while the previous one passes.
- **Missing `Co-Authored-By` trailer (recurs).**
- **Present tense used for the state before the commit (recurs).**
- A body that opens with what changed instead of what surfaced the problem.
- A play-by-play of the diff.
- An email address, or anything traceable to a person.
- **A finding or a TODO in the body.** "Writing this turned up that X is broken" is a defect report,
  not a description of the change. The body covers what this commit does and what surfaced it, never
  what it revealed and left undone.

```bash
awk 'NR>2 && length($0)>74 && $0 !~ /^Co-Authored-By/ {print NR": "length($0)}' <file>

awk 'NR>2 && prev!="" && $0!="" && prev !~ /^Co-Authored-By/ && $0 !~ /^Co-Authored-By/ {
  split($0,w," "); if (length(prev)+1+length(w[1])<=74)
    printf "%d: %d cols, \"%s\" would have fitted\n", NR-1, length(prev), w[1] } { prev=$0 }' <file>

grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" <file> | grep -v "noreply@anthropic"
```

All three should print nothing.

## Working practice in this repo

**The maintainer reads the staged diff before every commit.** Make the edits, stage them, and hand
the work over — do not commit unless asked. That rhythm is what the review depends on, and they
cannot vouch in an interview for code they have not read.

When handing a message over rather than committing it, put it in a fenced code block in the reply so
it copies as plain text. Write the draft to a scratch file, run the mechanical checks against it,
then paste the result. The file is a working copy, never the thing handed over.

## Splitting a dirty tree into several commits

See `git-workflow`, which carries the recipe and the verification this repo's pre-commit hook does
not provide.

## Why

A log that reads well in the Git CLI, and — for this repository specifically — a history that is
itself an explanation of the decisions, since that is what the project is for.
