# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities through [GitHub Security Advisories](https://github.com/ms-ponyo/buddy/security/advisories/new).

Do not open a public GitHub issue for a security vulnerability. Private advisories allow us to coordinate a fix before any public disclosure.

## Security Considerations

Buddy runs Claude with access to a shell and the filesystem via the Interactive Bash and file tools. This means a compromised or misconfigured deployment can execute arbitrary commands on the host machine.

### Recommended Hardening

- **`ALLOWED_USER_IDS`** — Restrict which Slack users can interact with the bot. Leave empty only on private, trusted workspaces.
- **`ALLOWED_CHANNEL_IDS`** — Limit the bot to specific channels to reduce the attack surface.
- **`ADMIN_USER_IDS`** — Grant elevated permissions only to trusted users who need them.
- **`PERMISSION_MODE`** — Use `default` in sensitive environments so Claude must request approval for tool use. `bypassPermissions` is convenient but removes the human-in-the-loop check.
- **`PREVIEW_MODE`** — Set to `moderate` or `destructive` to require confirmation before file writes and other destructive operations.
- **Never commit `.env`** — Your `.env` file contains Slack tokens and your Anthropic API key. Add it to `.gitignore` and use a secrets manager in production.

### Network Exposure

Buddy communicates with Slack over an outbound WebSocket (Socket Mode) — no inbound ports need to be opened. If you deploy on a shared host, ensure other processes cannot read the environment variables or log files.
