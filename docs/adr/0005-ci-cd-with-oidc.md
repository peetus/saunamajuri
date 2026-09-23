Deployment moved off a laptop and into GitHub Actions: every push to `main` runs the full check and
then `cdk deploy`. The reason is not convenience. A deploy that only one machine can perform is a
deploy whose preconditions nobody has written down, and the first time it is attempted from anywhere
else the missing steps surface one at a time. Putting it in a workflow forces the preconditions into
a file, and the file is executable, so it cannot drift from the truth the way a README section can.

The workflow repeats `npm run check` even though a pre-commit hook already ran it. The hook is local
and `--no-verify` skips it, so CI cannot treat it as evidence. It is the same command, deliberately:
two different definitions of "passing" is worse than running it twice.

## No stored credential

Actions authenticates with OIDC rather than an access key held as a repository secret. GitHub mints
a token scoped to the workflow run, AWS validates it against the deploy role's trust policy, and STS
returns credentials that expire within the hour. An access key would be long-lived, would sit in a
secret store indefinitely, and would stay valid after a leak until somebody noticed and rotated it.
The OIDC credential expires whether anyone notices or not, which is the property worth having.

The trust policy is the entire security boundary, and it carries two conditions. The audience is
pinned to `sts.amazonaws.com`, because a token minted for a different audience was minted for
somebody else. The subject is pinned to one branch of one repository. Without the subject condition
the role would accept a token from any repository on GitHub; scoped only as far as the repository it
would accept one from any ref within it, so pushing any side branch would deploy.

What the branch scoping buys depends on `main` being protected, which is a GitHub setting and is not
established anywhere in this repository. It is worth stating rather than assuming: on its own, the
condition means a side branch cannot deploy. It does not mean a review happened.

## The subject is read, not constructed

The first deploy from CI was refused with `Not authorized to perform sts:AssumeRoleWithWebIdentity`
while every visible input was correct — the role existed, the provider existed, the audience
matched, and the policy named the right repository and branch. CloudTrail records the subject that
was actually presented, and it was `repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:refs/heads/main`.

GitHub issues **immutable subject claims**: the identifier carries the numeric owner and repository
ids rather than their names, so a repository that is renamed or deleted leaves no name behind for
someone else to register and reuse. The policy had been written against the name form,
`StringEquals` is literal, and it denied. That is the correct behaviour and the reason the
condition is written with `StringEquals` rather than a pattern: the failure mode of a mismatch is a
denial, never an accidental grant.

The fix was to stop assembling the subject from a repository name and start reading it from the
repository itself, through
`gh api repos/<owner>/<repo>/actions/oidc/customization/sub`. Which form is in force is a property
of the repository, not something the stack can derive, and guessing produces an assume-role denial
with nothing pointing at the cause. The workflow supplies the same value from the numeric ids in its
own context, so the policy always names the repository that is actually deploying. A test asserts
the subject carries ids on both sides of the slash, so a silent return to the name form fails in the
suite rather than on a deploy nobody is watching.

## The token is kept away from the dependency surface

`id-token: write` is granted to the deploy job only. The check job — which runs `npm ci`, eslint,
tsc and the test suite, and therefore executes a large amount of third-party code — holds
`contents: read` and nothing else.

The reasoning is that a job permission is not a step permission. Any step in a job that may mint an
OIDC token can request one and call `AssumeRoleWithWebIdentity` directly, so ordering the AWS step
last would not have contained anything. Splitting the jobs is what removes the capability from the
larger and more frequently churned surface. The deploy job still runs `npm ci` and `cdk deploy`, so
this narrows the exposure rather than eliminating it.

For the same reason the three actions are pinned to commit SHAs rather than version tags. A tag is a
mutable pointer, and moving one is a published attack against Actions users; here it would reach a
role that can assume the CDK bootstrap roles. The version in the trailing comment is the only thing
naming a release and nothing verifies it against the SHA beside it, so it is checked against the
GitHub API rather than trusted.

## What this does not close

The deploy role holds `sts:AssumeRole` on the `cdk-*` bootstrap roles. Bootstrapping was run with no
arguments, so the CloudFormation execution role it created carries `AdministratorAccess`. The grant
is therefore the right to become the deployer, not a narrow slice of it, and the honest summary is
that the trust policy is the control that matters — not the resource scope. Re-bootstrapping with
`--cloudformation-execution-policies` and `--custom-permissions-boundary` is the fix, and it is not
done.

This role also deploys the stack that defines it, so whoever can merge to `main` can widen the trust
policy on the next push. That adds persistence rather than new power, since the same actor could
already reach `iam:UpdateAssumeRolePolicy` through the bootstrap roles, but it is the kind of change
nobody rereads once it is merged.

Finally, `cdk deploy` prints the stack outputs into the workflow log, and a repository's run logs
become readable by everyone when the repository is made public — including runs recorded while it
was private. The account id is masked through the action's `mask-aws-account-id` input, which is off
by default and which no change to the outputs would substitute for, since the id also appears inside
the stack and topic ARNs. The API URL is not masked. Deleting the historical runs, or closing the
unauthenticated write route described in ADR 0004, has to happen before the repository's visibility
changes.
