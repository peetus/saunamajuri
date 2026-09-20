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

## Conventions

- **UTC everywhere.** Store and reason in UTC; convert to `Europe/Helsinki` only
  when formatting text for a human.
- **Structured logs.** `console.log(JSON.stringify({ msg, ...fields }))`.
  CloudWatch Logs Insights can query JSON fields and cannot usefully query prose.
- **Idempotent handlers.** The collector re-fetches an overlapping window every
  hour, so re-running must always be safe.
- **Anti-corruption at the edge.** One function owns each external payload shape,
  so an upstream change touches one place.
- **No web framework.** API Gateway routes to a Lambda handler directly. Adding
  Express or Nest would mean bundling and cold-starting a router to serve a
  handful of routes.

## Checks

```bash
npm run check   # build, lint, format:check, test
```

| Command                | Enforces                                   |
| ---------------------- | ------------------------------------------ |
| `npm run build`        | Types (`tsc --noEmit`)                     |
| `npm run lint`         | Layering, injected clock, type-aware rules |
| `npm run format:check` | Prettier                                   |
| `npm test`             | Unit tests (vitest)                        |
