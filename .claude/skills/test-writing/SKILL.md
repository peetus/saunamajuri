---
name: test-writing
description: Use when writing tests for any new feature or fix in this repo, and when asked to review or strengthen an existing suite. Carries the ordered passes a suite goes through - fake-test checks, completeness, exhaustiveness, edge/chaos/adversarial - before it counts as done.
---

# Test writing

**The rules live in `CODING_STANDARDS.md` § Tests** — what a fake test is, the three levels, and
why a fixture must vary what its name claims. This skill is the order the passes run in.

The passes are separate reads of the suite, not one. A suite written once alongside the
implementation asserts what the code happens to do rather than what it must do, and the passes exist
to break that symmetry.

## The order

1. **Write the full suite before the implementation.** Not a sketch — the cases you expect to hold.
2. **Check for fake tests.** Before any implementation exists, most tests should fail for the right
   reason. One that passes already is either trivial or fake.
3. **Implement, then review and update the tests against what was built.** The implementation always
   teaches something the tests were written without.
4. **Cover the three levels** — unit, integration, user story. See `CODING_STANDARDS.md`.
5. **Check for fake tests again.** Steps 3 and 4 are where they appear, because a test adjusted to
   match an implementation is a test that has stopped being independent of it.
6. **Check completeness, then exhaustiveness.** Two different questions, in this order:
   - _Completeness_ — is every function, parameter, input, output and return path exercised at all?
     Walk the implementation and tick them off.
   - _Exhaustiveness_ — for each of those, is every **meaningful case** covered, not just one? A
     parameter with a boundary has at least three cases around it. A branch has both sides. An
     optional argument has present and absent.
7. **Add edge cases, chaos tests and adversarial tests.**
   - _Edge_ — boundaries, empty, one element, exactly at the limit.
   - _Chaos_ — malformed and hostile input that should never arrive but might: `NaN`, `Infinity`,
     duplicates, unparseable dates, out-of-order data, holes.
   - _Adversarial_ — assume the implementation is wrong and try to prove it. This pass found the
     `NaN` price that slipped under a rule's ceiling and would have been emailed as a cheap window.
8. **Check for fake tests one final time.** The cases added in step 7 are the likeliest to assert
   nothing, because they are written last and under the least pressure to be right.

## Running a fake-test pass

Reading is not enough. Mutate, and watch the suite:

```bash
# revert the fix, run only the tests that claim to cover it, expect failure
```

Mutate **fixtures** as well as implementations. `CODING_STANDARDS.md` § Proving the suite can fail
says why; what belongs here is that this is the half that gets skipped, because mutating the
implementation feels like the whole job and produces a satisfying row of failures either way.

## Where this repo's suite has failed

Both were invisible from inside the suite — everything green, coverage high:

- **A fixture that held the variable under test constant.** A case named for a later run used a
  frozen clock, so it ran twice at the same instant and could not have failed. The name described a
  case the setup excluded, and the name is what gets believed.
- **A snapshot regenerated whenever it disagreed.** It could not fail, because the Lambda bundle
  hash made it disagree on every edit, so `-u` became reflex. Normalising the hash fixed the test,
  not the discipline.

## Why

Coverage counts lines, not consequences. When a test cannot fail, strengthen it or delete it — one
kept for the count is worse than none, because it reads as coverage.
