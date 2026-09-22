Rules moved out of the collector's source and into the table, so changing a price ceiling is a
request rather than a deploy. The cost is one Query per collector run, which is negligible against
the write of 192 price slots that precedes it, and one new failure mode that is not negligible: a
deploy leaves the rule partition empty, and a run with no rules stores prices, alerts nothing and
looks exactly like a night when nothing was cheap enough. An empty set therefore logs a line of its
own. The alternative, seeding defaults when the table is empty, was rejected because it would leave
the operator believing rules were in force that nobody had written.

The API is a plain handler matching on method and path, with no web framework. API Gateway has
already routed the request by the time the Lambda runs, so a router would be re-deciding something
already decided, and Express would have to cold-start on every container to serve three routes. The
handler is split from its composition root for the same reason as the collector: importing the entry
file in a test runs `requireEnv` at module scope and throws.

A rule id is validated to printable ASCII within 64 characters, which is stricter than the domain
needs and exactly what its two sinks need. The id reaches an SNS subject, which rejects newlines and
caps at 100 characters, and a DynamoDB sort key, which caps at 1024 bytes. Neither constraint is
visible from the rule type, so the check lives at the edge where untrusted input arrives rather than
in the domain that has no opinion about it.

The API Lambda gets `Query` and `PutItem` and not `BatchWriteItem`, and the stack test asserts the
set per role rather than across the template, because an aggregate assertion passes while one role
holds the other's permissions. Removing `Query` and deploying was tried deliberately. `GET /rules`
returned 500 while `PUT /rules` still returned 200, and the log named the assumed role, the action
and the table ARN, and said the failure was a missing allow rather than an explicit deny.
CloudFormation deployed that policy without complaint, because nothing in AWS checks that a role
matches what the code calls. That is the argument for the assertion: a least-privilege policy fails
one action at a time, so a wrong permission presents as one broken feature rather than an outage,
and is correspondingly easy to miss.

CORS is configured permissively, and it is worth being precise about what that does and does not
mean. CORS constrains what a page running in someone's browser may do with a response; it is a
protection for the visitor, not for the API, and it is enforced by their browser rather than by us.
With no credentials in play and no cookies, it is not a control here at all. It is open because a
page served from another origin will need to read this, and closing it would protect nothing.

`PUT /rules` has no authorizer, so anyone holding the URL can store rules that decide what is
emailed, and can store as many as they like. That is accepted for now on the grounds that the URL is
unpublished and the account is a personal sandbox, which is a weak defence and is recorded as such
rather than dressed up. It also bounds what may be built on top: no public page can link to this API
until the question is settled, because publishing the page publishes the URL. The options are an API
key on the write route, a Lambda authorizer, or making the deployed surface read-only and keeping
writes to the CLI. Whichever is taken, it is the first thing to settle before anything here is
public.

Two consequences of that make the cost higher than an unwanted email or a wasted credit, and both
end with the service quietly not working. Overwriting is the first: `putRule` is keyed by rule id,
so a write with an existing id replaces that rule rather than adding one, and a ceiling nobody can
meet stops the alerts without changing anything an operator would look at. The second is that
`getRules` does not paginate, and a Query returns at most a megabyte. Sort keys are `RULE#<id>`
ordered lexicographically, so enough rules whose ids sort earlier push the real ones onto a second
page the collector never reads. Neither shows up as an error, and for a service whose only job is
to tell somebody something, being silently switched off is worse than being expensive.

The account's Lambda concurrency limit of 10 is shared by both functions, so load on the API is not
isolated from collection. Enough concurrent requests starve the collector of the concurrency it
needs to run at all, which turns a request flood into a stoppage rather than a bill. A rule-count
limit, pagination, and stage throttling each bound one of these, and all three are cheaper than the
authorizer they do not replace.
