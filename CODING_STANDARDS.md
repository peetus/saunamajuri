# Coding standards

Conventions for this repository. Where tooling can enforce a rule it does, and
the rule says which tool — `npm run check` runs the lot.

## Layering

Dependencies point inward. Enforced by `eslint.config.mjs`; `npm run lint` fails
if a boundary is crossed.

| Layer          | Path                         | May import                                           |
| -------------- | ---------------------------- | ---------------------------------------------------- |
| Domain         | `src/rules/`                 | Nothing but its own types. No AWS, no I/O, no clock. |
| Adapters       | `src/collector/`, `src/api/` | Domain, AWS SDK, Node built-ins                      |
| Infrastructure | `lib/`, `bin/`               | CDK only — never `src/`                              |

`src/rules/` holds the logic worth owning: pure functions over plain data, tested
in milliseconds without mocks. `new Date()` and `Date.now()` are lint errors
there — pass `now: Date` in so tests control time.

Infrastructure references handlers by entry path
(`entry: "src/collector/handler.ts"`), never by import, so `lib/` has no reason
to reach into `src/`.

## Dependency injection

Parameter injection via factory functions. No DI container and no decorators —
Lambda pays for every millisecond of cold start, and a container buys nothing at
this size.

```typescript
// Adapter: takes its dependencies, returns an interface.
export function createDynamoPriceStore(deps: { client: DynamoDBDocumentClient; tableName: string }): PriceStore;

// Composition root: module scope, so it runs once per cold start.
const store = createDynamoPriceStore({ client, tableName: requireEnv("TABLE_NAME") });
export const handler = makeHandler({ store, fetchPrices, now: () => new Date() });
```

- **Depend on the interface, not the implementation.** Handlers take a
  `PriceStore`, never a `DynamoDBDocumentClient`.
- **Compose at module scope**, not inside the handler, so the work is paid for
  once per cold start rather than once per invocation.
- **Inject the clock.** Everything here is time-windowed, so `now` is a
  dependency like any other.
- **Validate configuration once, at cold start, and throw.** A missing
  environment variable should kill the container immediately rather than fail the
  hundredth invocation.

## Code style

Prettier owns formatting: `printWidth` 120, double quotes, trailing commas,
semicolons. Run `npm run format`.

- **Double quotes** for strings. When a string contains a double quote, use a
  backtick template literal rather than escaping or falling back to single
  quotes: `` `he said "moi"` ``, not `"he said \"moi\""`.
- **`//` for explanatory comments**, including multi-line ones — stack `//` lines
  rather than opening a block.
- **`/** */` for JSDoc only**: descriptions of functions, interfaces, types and
  exported members, where an editor surfaces them on hover.
- **`/* */` inline only where genuinely necessary**, such as annotating an
  argument at a call site.
- **Comment the non-obvious only.** A comment earns its place when the code
  would otherwise catch the reader off guard. Do not restate the line, and keep
  it to a line or two — a design decision that needs a paragraph belongs in
  `docs/adr/`.
- **Say it once, where it applies.** A rule that holds project-wide belongs in
  this document; a call site keeps only what is true of that call site. The
  same explanation in three files is two chances to leave a stale copy.

## Conventions

- **UTC everywhere.** Store and reason in UTC; convert to `Europe/Helsinki` only
  when formatting text for a human.
- **Structured logs.** `console.log(JSON.stringify({ msg, ...fields }))`.
  CloudWatch Logs Insights can query JSON fields and cannot usefully query prose.
- **Idempotent handlers.** The collector re-fetches an overlapping window every
  hour, so re-running must always be safe.
- **Anti-corruption at the edge.** One function owns each external payload shape,
  so an upstream change touches one place.
- **Least privilege, always, where feasible.** Grant the actions a component
  actually uses, on the resources it actually touches. Prefer an explicit
  `iam.PolicyStatement` over CDK's `grant*` helpers — `grantReadWriteData` hands
  out twelve DynamoDB actions including `Scan` and `DeleteItem`. Add permissions
  when the code that needs them lands, not in anticipation, and assert the
  resulting action set in `test/saunamajuri-stack.test.ts` so it cannot broaden
  unnoticed.
- **No web framework.** API Gateway routes to a Lambda handler directly. Adding
  Express or Nest would mean bundling and cold-starting a router to serve a
  handful of routes.

## Tests

Tests are written before the implementation, then revisited rather than left as
first drafted. A suite goes through ordered passes — fake tests, completeness,
exhaustiveness, then edge, chaos and adversarial cases — with a fake-test check
at three points along the way. The order matters and is easy to compress away,
so it is written out in the `test-writing` skill rather than summarised here.
What follows is what those passes look for.

A fake test cannot fail for the reason it claims: no meaningful assertion, an
assertion against a mock instead of behaviour, a tautology, or a snapshot that is
regenerated whenever it disagrees. Strengthen it or delete it. A test kept for
the count is worse than no test, because it reads as coverage.

Cover three levels: unit for pure functions and adapters, integration for a
handler wired to its real collaborators with only the AWS edge faked, and at
least one user-story test that asserts the behaviour someone actually asked for.

A test's name is a claim about what varies; the fixture has to actually vary it.
A case named for a later run must advance the clock, one named for a batch must
use more than one item. Holding the variable under test constant produces a
green test that asserts nothing about the case it is named for, and the name is
what future readers will believe.

### Proving the suite can fail

Break the implementation on purpose and confirm the suite notices — restore the
bug a fix removed, flip a comparison, delete a guard. A mutation nothing catches
names a test that was never load-bearing.

**Mutate fixtures as well as implementations.** Breaking the implementation
proves the assertions bite; it says nothing about a test whose setup never
reaches the interesting state, because the mutant and the original both pass a
scenario that does not happen. Freeze a clock, collapse a list to one element,
make two identifiers equal, and see which tests still pass.

## Checks

```bash
npm run check   # build, lint, format:check, test
```

This runs automatically before every commit. `npm install` sets
`core.hooksPath` to `.githooks/` via the `prepare` script, and
`.githooks/pre-commit` aborts the commit if any check fails — no hook manager,
no extra dependency. Bypass deliberately with `git commit --no-verify`.

| Command                | Enforces                                   |
| ---------------------- | ------------------------------------------ |
| `npm run build`        | Types (`tsc --noEmit`)                     |
| `npm run lint`         | Layering, injected clock, type-aware rules |
| `npm run format:check` | Prettier                                   |
| `npm test`             | Unit tests (vitest)                        |
