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

A rule id is validated to lowercase slug characters within 32, which is stricter than anything its
sinks require. The sinks set the outer bound: the id reaches an SNS subject, which rejects newlines
and caps at 100 characters, and a DynamoDB sort key, which caps at 1024 bytes. Neither constraint is
visible from the rule type, so the check lives at the edge where untrusted input arrives rather than
in the domain that has no opinion about it.

The charset is narrower than those sinks need, and the reason is the open write route. The id is
rendered verbatim into the subject and body of a mail that arrives from Amazon with valid DKIM, at
an address whose owner confirmed it. Printable ASCII within 64 characters is room for a sentence and
a URL, so it would hand an unauthenticated caller a way to put chosen text into a trusted mailbox -
a phishing primitive rather than the unwanted email the rest of this section prices. Slug characters
leave no room for one, and the ids this serves are `sauna` and `dishwasher`.

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
emailed. That is accepted for now on the grounds that the URL is unpublished and the account is a
personal sandbox, which is a weak defence and is recorded as such rather than dressed up. It also
bounds what may be built on top: no public page can link to this API until the question is settled,
because publishing the page publishes the URL. The options are an API key on the write route, a
Lambda authorizer, or making the deployed surface read-only and keeping writes to the CLI. Whichever
is taken, it is the first thing to settle before anything here is public.

Two consequences of that make the cost higher than an unwanted email or a wasted credit, and both
end with the service quietly not working. Overwriting is the first: `putRule` is keyed by rule id,
so a write with an existing id replaces that rule rather than adding one, and a ceiling nobody can
meet stops the alerts without changing anything an operator would look at. This one still stands,
and only an authorizer closes it. The second was that `getRules` read a single page, and a Query
returns at most a megabyte: sort keys are `RULE#<id>` ordered lexicographically, so enough rules
whose ids sorted earlier would push the real ones onto a page the collector never read. Neither
shows up as an error, and for a service whose only job is to tell somebody something, being
silently switched off is worse than being expensive.

The account's Lambda concurrency limit of 10 is shared by both functions, so load on the API is not
isolated from collection. Enough concurrent requests starve the collector of the concurrency it
needs to run at all, which turns a request flood into a stoppage rather than a bill.

A rule-count limit, pagination and stage throttling each bound one of these, and all three are
cheaper than the authorizer they do not replace. All three have since been taken: `putRule` refuses
a new id past ten rules, both queries follow `LastEvaluatedKey` to exhaustion, and the stage caps at
10 requests a second with a burst of 20.

The rule count is a read followed by a write rather than a condition expression, because a condition
expression cannot count. Two writes racing can therefore both pass the check, so the limit bounds
growth rather than holding exactly. That is the residual gap, and it is smaller than the one an
authorizer would close.

## The write route, closed

`PUT /rules` now uses API Gateway's IAM authorization. A write must be SigV4-signed by a principal
in this account that holds `execute-api:Invoke`, and API Gateway rejects anything else with a 403
before the Lambda is invoked. The three options above were weighed again against what the service
is: single-user, and operated from a terminal that already holds AWS credentials.

An API key was rejected because it identifies a client rather than authorizing one, and HTTP APIs
do not offer them. A Lambda authorizer would mean writing and testing token validation for one
caller. Making the deployed surface read-only would have moved writes onto the CLI and around the
validation in `parseRule`, which exists because the id reaches an email. IAM needed no new code, no
secret and no cost. It keeps the edge validation, and its signing tool is already installed, since
curl has done SigV4 natively since 7.75.

The route was split rather than the catch-all authorized: `GET /{proxy+}` stays open and `PUT
/rules` is its own route. Reads carry public data, and a browser page has to read them without
credentials. The stack test therefore asserts over every route rather than the named one. A
catch-all that still accepted `PUT` would route a write around the authorizer while `PUT /rules`
looked correct.

This closes the overwrite that "only an authorizer closes". The bounds stay, because they still
apply to whoever holds the credentials and cost nothing. So does the slug charset, because a leaked
access key should not also put chosen text into a trusted mailbox. It does not close two things. The
open reads still cost requests, and the throttle limits their rate, not their total. And IAM
identifies the operator, not a user: per-user rules would need Cognito's JWT authorizer, which
replaces this rather than building on it.
