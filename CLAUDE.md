# Buddy

Claude Code untethered from the terminal. A Slack bot powered by the Claude Agent SDK with multi-process architecture.

- **Node**: >=24.14.0
- **Module system**: ESM (`"type": "module"`)
- **Language**: TypeScript only
- **License**: MIT (open source)

## Architecture

Multi-process system communicating via JSON-RPC 2.0 over Unix domain sockets:

```
Slack → GATEWAY → WORKER (main/lite) → PERSISTENCE (SQLite)
```

### Packages

| Package | Role |
|---------|------|
| `packages/shared/` | RPC infrastructure, shared types, constants |
| `packages/gateway/` | Slack Bolt event routing, session registry, worker lifecycle, stream routing, health monitoring |
| `packages/worker/` | Claude SDK execution, command system, MCP servers, tool hooks, UI blocks |
| `packages/persistence/` | SQLite message queue, session storage, process registry, delivery loop |

### Two-Worker Model

- **Main Worker**: Full Claude SDK session. Tool execution, MCP servers, streaming responses. 30-min idle timeout.
- **Lite Worker**: Fast. Handles `!commands`, permission approvals, dispatch actions. 5-min idle timeout.
- Commands route through lite first; returns `handled`, `forward` (to main), or `dispatch`.

### Key Subsystems (worker)

- `commands/` - Modular command system with `defineCommand()` and metadata-driven routing
- `services/` - Claude session wrapper, permission manager, bot command router, MCP registry
- `orchestration/` - Worker loop, message handler, callback builder
- `hooks/` - `can-use-tool` and `pre-tool-use` permission hooks
- `ui/` - Slack Block Kit builders (reactions, permissions, plans, questions)
- `mcp-servers/` - Slack tools, interactive bash, VS Code tunnel, dispatch control
- `adapters/` - Slack API and persistence abstractions

## Build & Run

```bash
npm run build          # Build all packages (shared first)
npm run dev            # Build all + start gateway
npm start              # Start gateway (production)
npm run restart        # Kill processes, clean sockets, rebuild, start
npm run clean          # Remove all dist/ directories
```

Build individual packages:
```bash
npm run build:shared
npm run build:gateway
npm run build:worker
npm run build:persistence
```

**After making code changes, always restart the bot.** Changes won't take effect until the process is restarted.

## Testing

```bash
npm test               # Run all tests (unit + integration + e2e)
npm run test:unit      # Unit tests only
npm run test:integration
npm run test:e2e       # 30s timeout
npm run test:watch     # Watch mode
```

- Framework: Jest 30 with `--experimental-vm-modules` for ESM
- Tests: `tests/unit/`, `tests/integration/`, `tests/e2e/`
- Additional tests in `tests/` root for config, diff formatter, MCP servers

## Environment Variables

Required:
- `SLACK_BOT_TOKEN` - xoxb-... (Slack OAuth)
- `SLACK_APP_TOKEN` - xapp-... (Socket Mode)
- `PROJECT_DIR` - Absolute path for Claude to work in

Key optional:
- `CLAUDE_MODEL` - Main worker model (default: `claude-opus-4-6`)
- `DISPATCH_MODEL` - Lite worker model (default: `claude-haiku-4-5-20251001`)
- `PERMISSION_MODE` - default, acceptEdits, bypassPermissions, dontAsk
- `ALLOWED_USER_IDS`, `ALLOWED_CHANNEL_IDS` - Access control

Full list in `.env.example`.

## Process Management

Processes set identifiable titles:
- `buddy-gateway` / `buddy-worker` / `buddy-persistence`

Sockets: `/tmp/buddy/*.sock`
Logs: `logs/gateway/`, `logs/workers/`, `logs/persistence/`, `logs/sessions/`

## Debugging

When debugging issues, **trace the full data flow**:

```
Slack message → gateway (slack-router) → session-registry → worker-manager
→ worker (message-handler → worker-loop → claude-session) → SDK
→ response → stream-router → stream-buffer → Slack
```

With persistence:
```
Inbound message → persistence queue → delivery-loop → worker
Worker response → persistence → gateway → Slack
```

- Don't assume where the problem is. Read logs from all processes.
- Check both in-memory state AND SQLite persistence. Fixes must survive restarts.
- Lite workers can go stale; check if a lite worker is handling what should go to main.
