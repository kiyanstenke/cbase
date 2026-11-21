# Security policy

## Supported versions

Only the latest state of the `main` branch receives security fixes. There are no release branches.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the **Security** tab of this repository and choose
**Report a vulnerability** (GitHub private vulnerability reporting).

Include what you found, the steps or a minimal example that reproduces it, the affected component (gateway, backend, web, desktop client,
iOS app) and the commit you tested. Never include real credentials, tokens or personal data in a report.

You can expect an acknowledgement of your report, a decision on whether it is a vulnerability, and a notice when a fix lands on `main`.
This is a volunteer project, so there is no fixed response time.

## Scope

cbase runs coding agents with shell access inside one container per user. Reports about escaping that container, reaching another user's
container or data, bypassing the gateway's login, or leaking credentials are in scope. Findings that need an operator to deliberately
weaken their own deployment are not.
