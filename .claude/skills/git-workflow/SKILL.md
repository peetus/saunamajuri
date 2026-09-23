---
name: git-workflow
description: Use when splitting staged work into several commits, folding a correction into an earlier commit, rewriting a commit message, rebasing or autosquashing, or deleting a merged branch. The mechanics and the traps for work that rewrites history.
---

# Git workflow mechanics

The _how_, for once the decision is made. Throughout, `<base>` is whatever the branch was cut from.

**A pushed branch is fine to rewrite while it is work in progress.** The condition is _not the
integration branch_ and _not yet reviewed_, not "unpushed". Force-push with `--force-with-lease`.

## Splitting staged work into several commits

The constraint here is that **`main` stays functional**: every commit must pass `npm run check` on
its own, not merely at the end.

### The pre-commit hook does not check this

`.githooks/pre-commit` runs `npm run check` against the **working tree**. While you commit subsets
of a fully-changed tree, the working tree holds the final state, so the hook passes every time and
proves nothing about any individual commit. **Verification is a separate step and it is not
optional.**

**This loop destroys uncommitted work.** `git checkout --force` discards changes
to tracked files, so the guard is not optional - it has already cost one
evening's work here, on the third run of a loop that had been safe twice because
the tree happened to be clean.

```bash
[ -z "$(git status --porcelain)" ] || { echo "dirty tree, refusing"; exit 1; }

for sha in <sha1> <sha2> ...; do
  git checkout -q --force --detach "$sha"
  npx tsc --noEmit >/dev/null 2>&1; build=$?
  npx eslint . >/dev/null 2>&1; lint=$?
  npx prettier --check . >/dev/null 2>&1; fmt=$?
  vout=$(npx vitest run 2>&1); test=$?
  printf "%s build=%s lint=%s fmt=%s test=%s\n" "$sha" "$build" "$lint" "$fmt" "$test"
  git checkout -q --force -- .
done
git checkout -q main
```

Run it in the main clone. It needs `node_modules`, and the alternatives are worse — see the trap
below.

### Ordering, which is the hard part

Dependency order is not enough. Two constraints beat it here:

- **A commit that changes bundled source moves the Lambda asset hash.** The snapshot test only
  tolerates that once `test/saunamajuri-stack.test.ts` normalises the hash, so **the infrastructure
  commit goes first**, before any source commit. Ordered the natural way — domain, adapters, wiring,
  infrastructure — the middle commits fail their own snapshot.
- **Repo hygiene goes in the first commit.** A `.gitignore` entry added late means the commits
  before it run `prettier --check` over files that should never have been checked.

Infrastructure-first also keeps every commit deployable, because a Lambda that ignores an extra
environment variable is fine while one reading an absent variable is not. The cost is granting a
permission one commit before anything calls it. Say so in the message rather than letting it look
accidental.

### Mechanics

`git add -p` is unavailable non-interactively. With everything already staged, the reliable shape is
`git reset` to unstage, then `git add <paths>` and commit per group. To redo a sequence, `git reset
--soft <base>` keeps every change and lets the groups be rebuilt.

When one file belongs to two commits, either write the hunks into a patch and `git apply --cached`
it, or stage an intermediate version built from `git show HEAD:<file>` plus this commit's hunk and
restore the full version afterwards.

## Folding a correction into the commit that introduced it

On an unreviewed branch, a "fix the line I wrote four commits ago" commit is noise.

- **Yes:** pure corrections to lines the branch itself introduced — a wrong tag, a stale comment, a
  missing guard the commit should have had.
- **Yes, different target:** a comment that was correct when written and that a later commit made
  stale folds into the commit that invalidated it.
- **No:** changes that add behaviour. Their bodies carry reasoning worth keeping.

`git rebase -i` is unavailable non-interactively, but **git 2.53+ runs `git rebase --autosquash
<base>` without `-i`**. Below that, `--autosquash` is **silently ignored**: the rebase reports
"Successfully rebased" and the `fixup!` commits are still there afterwards. Check `git --version`
before relying on it, and verify rather than assume: the success message is the same either way, so
make a throwaway `fixup!` commit, rebase, and see whether `git log` still shows it.

1. `git reset`, then `git add <files>` + `git commit --fixup=<sha>` per target. Check with
   `git blame` first; it is usually file-granular.
2. Capture `git rev-parse HEAD^{tree}` before rebasing.
3. `git rebase --autosquash <base>`.
4. **Compare the tree sha after.** Identical means the rewrite preserved content exactly. This only
   holds while the base is unchanged.
5. **Re-run the verification loop above at every commit.** Replayed commits do not run the
   pre-commit hook, so even its working-tree guarantee is gone.

### Message-only edits

`git commit --allow-empty --no-verify -F <file>`, where the file's first line is
`amend! <exact subject of the target>`, then a **blank line**, then the complete replacement
message. Without the blank line git reads the directive and the subject as one paragraph, autosquash
matches nothing, and the commit sits unconsumed. The tree sha must be unchanged.

### Traps

- **A fixup can only target a commit whose version of the file the diff applies to.** A conflicting
  rebase means the target is wrong. Abort, re-blame the whole hunk, re-target, redo.
- **A fixup can invalidate the receiving commit's message.** After every autosquash, re-read the
  message of every commit that received one.

## Traps that have cost time in this repo

- **Read an exit code directly, never through a pipe.** `npx vitest run 2>&1 | tr -d '\r'` reports
  `tr`'s status, so every commit read as passing and a broken split nearly went through. Assign
  `cmd; rc=$?` on its own line, or redirect to a file and check `$?`.
- **Never junction `node_modules` into a directory you will later delete recursively.** On Windows
  `git worktree remove --force` follows a junction and deletes the target's contents — it removed
  the main clone's `node_modules`. Verify in the main clone instead, or `npm ci` inside the worktree.
  If a junction must exist, remove it with `cmd //c rmdir <link>` first, which unlinks without
  following.
- **A worktree created before a `.gitattributes` change keeps the old line endings.** Files unchanged
  between checkouts are never rewritten, so `prettier --check` fails on files the commit never
  touched. Recreate the worktree rather than debugging the commits.
- **`git checkout` fails when a test run has written to a tracked file.** Precede each checkout with
  `git checkout --force -- .`.
- **Uniform failure across every commit is an environment fault, not a code fault.** If all of them
  fail the same check, including ones that change nothing relevant, stop bisecting the commits and
  look at the harness.
- **`git add <path>` then `git commit` commits the whole index, not that path.** Anything staged
  earlier rides along. A probe commit on a throwaway branch swallowed a staged hook this way, and
  deleting the branch deleted the only copy of it. Use `git commit -- <path>` to commit one path, or
  check `git diff --cached --stat` before committing.
- **Options placed after `--` are read as pathspecs.** `git commit -- file.ts -m "msg"` fails with
  `pathspec '-m' did not match any file(s)`, having committed nothing, and leaves the file staged so
  the tree looks like the commit worked. Options go before `--`.
- **`git stash` takes staged-but-uncommitted work with it**, including files being added for the
  first time. Before probing on a throwaway branch, copy anything uncommitted outside the repository
  first. Two probes in one session cost work that was only recoverable because a copy existed.

## Stashing around a gate

```bash
git stash push --keep-index --include-untracked -m gate
<run the gate>
git stash pop
```

**Do not modify any file inside the stashed set while the stash is held**, including files the
commit is adding for the first time. Format first, then stash. A conflicting pop loses nothing — the
stash survives until dropped.

## Deleting a merged branch

Prove equivalence before removing anything, several ways rather than one: every commit reachable
from the integration branch (`git merge-base --is-ancestor`), zero commits unique to the branch,
identical tree shas, an empty `git diff <branch> <base>`, and a clean tree. A rebase-merged branch
carries the same commits under new shas, so comparing subjects matters as much as comparing shas.
Print the old tip sha so the reflog entry stays findable.

**`git branch -d` refuses while the branch tracks an upstream whose tip is unmerged**, which happens
after a rebase. Delete the remote branch first, then `-d` succeeds and there is never a reason for
`-D`.

## Handing off finished work

Publishing is the maintainer's own act. **Never run `git push`**, on any branch, for any reason -
not to complete a task, not after an approved commit, not because the remote is obviously where the
work is going. Fast-forward the local integration branch if that helps, then give them the push
command and stop. The same holds for anything else that leaves the machine: creating a remote,
opening a pull request, publishing a package.
