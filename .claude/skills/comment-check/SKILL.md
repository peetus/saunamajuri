---
name: comment-check
description: Use whenever finishing code edits, before staging or handing work back, and after applying review fixes. Reads every comment added or changed in the diff against this repo's comment conventions. Also use when asked to "check the comments" or told that comments have drifted.
---

# Comment check

A reading pass over the comments in a diff. Nothing here is automatable — the findings come from
reading, not from a tool.

**The rules live in `CODING_STANDARDS.md`, not here.** This skill is the procedure and the scan
list. Stating the rules twice is the failure they warn about, so read the Code style section there
first and treat it as the authority.

## Get the diff first

Look at the comments as they will land, not as you remember writing them:

```bash
git diff --cached -- <paths> | grep -E "^\+\s*(//|\*|/\*)"
```

Use `git diff` when the work is unstaged. Read each one **in place**: several rules below are about
a comment's relationship to its surroundings rather than to itself.

## Scan for these

The marked entries recur. They mark where to look hardest.

- **A comment that drifted when the code moved (recurs).** The commonest defect in this repo by a
  wide margin. After any fix, reread the comments on every line the fix touched, and the doc comment
  on the function that contains them. A comment describing the behaviour the code had an hour ago
  reads as authoritative.
- **A claim that is simply false (recurs).** "This is never the same as the UTC date" shipped here
  about a value that is the same for twenty-one hours a day. Check absolutes: never, always, every,
  only.
- **Our own history narrated (recurs).** "This ran twice at the same instant before." State the
  standing reason instead. History belongs in the commit body, and this repo has `docs/adr/` for
  decisions.
- **The same supporting fact in a second file (recurs).** The Helsinki-day rationale reached four
  copies once. A rule that holds project-wide belongs in `CODING_STANDARDS.md`; the call site keeps
  only what is true of that call site.
- **A consequence clause appended for drama**, the "or else X".
- A sentence restating what the code plainly shows.
- **A cross-reference standing in for the fact.** Pointing at another file makes the reader go and
  look. State the one clause that matters here. Pointing at an ADR is fine when the ADR holds a
  decision, not when it holds the sentence this line needed.
- A date or other volatile provenance.
- Future work as prose. Substitute `// TODO <do the thing>`.
- **Personally identifiable information.** In this repo that is concretely the maintainer's email
  address, which nearly reached tracked source once as an `ALERT_EMAIL` fallback. Illustrate a
  format with an invented sentinel such as `you@example.com`.
- `;` semicolon in a code comment. Two live in this repo already and are not worth rewriting
  history over, but do not add more.

## Punctuation, by file kind

Em-dashes and semicolons are fine in prose documents — `CODING_STANDARDS.md`, `README.md` and
`docs/adr/` all use them, and this file does. In **code comments**, prefer a comma, a period or a
hyphen. The distinction is that a code comment is read in a fixed-width editor beside code, where
typographic punctuation reads as noise.

## What a good comment looks like

`CODING_STANDARDS.md` covers this. Two points it leaves implicit:

- **Hedge honestly where knowledge is incomplete**, and scope a claim to what was actually checked.
  "The feed has shown -0.009 c/kWh" rather than "prices go negative".
- **Match weight to how non-obvious the code is.** A trivial helper gets a terse line, not a
  rationale.

## Where this fails

Knowing the rules does not gate writing prose. In this repo the violations have clustered in the
**long comments written during the hard parts** — the sliding-window dedupe, the Helsinki day —
while the short ones came out clean.

**Re-check hardest where the content was hardest.** Negatives are weak at generation time and
reliable at check time, which is why the scan list is kept separate from the rules.

## Why

A comment that restates the code goes stale and costs reading time without adding information. The
rationale or constraint behind a decision is what a future reader cannot recover — and for this
repository, being able to explain a decision out loud is the actual deliverable.
