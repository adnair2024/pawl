# Security

pawl runs inside developers' Claude Code sessions and reads their source, so reports matter.

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on the
repository's Security tab rather than in a public issue. Include what you did, what you expected,
and what happened. Reports about a way to make pawl silently disengage, accept a change without the
user, or run code from a repository being checked are especially welcome.

pawl makes no network calls while checking code and sends no telemetry. The only network use is the
one-time `npm install` of its dependencies when the plugin is first installed.
