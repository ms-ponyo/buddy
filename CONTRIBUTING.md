# Contributing to Buddy

## Development Setup

```bash
git clone https://github.com/ms-ponyo/buddy.git
cd buddy
npm install
npm run build
```

Run tests:

```bash
# Run all tests
npm test

# Run tests for a specific package
npm test --workspace=packages/worker
npm test --workspace=packages/gateway
npm test --workspace=packages/persistence
npm test --workspace=packages/shared
```

## Project Structure

```
buddy/
├── packages/
│   ├── gateway/          # Slack Socket Mode process
│   │   └── src/
│   ├── worker/           # Claude agent loop + MCP servers
│   │   └── src/
│   │       ├── mcp-servers/   # Built-in MCP server implementations
│   │       ├── services/      # Permission manager, session, routing
│   │       ├── orchestration/ # Worker loop and message handler
│   │       ├── adapters/      # Slack and persistence RPC adapters
│   │       ├── handlers/      # Event and interaction handlers
│   │       └── ui/            # Slack Block Kit UI helpers
│   ├── persistence/      # Conversation and permission storage
│   │   └── src/
│   └── shared/           # Shared types and RPC protocol
│       └── src/
├── tests/                # Integration tests
├── scripts/              # Build and utility scripts
├── docs/                 # Documentation
├── package.json          # Workspace root
└── tsconfig.json
```

## Adding an MCP Server

See the [Adding Your Own MCP Server](README.md#adding-your-own-mcp-server) section in the README for a complete walkthrough.

## Pull Requests

1. Fork the repository and create a feature branch from `main`.
2. Add or update tests for your changes.
3. Ensure the build and test suite pass: `npm run build && npm test`.
4. Keep PRs focused — one logical change per PR makes review easier.
5. Open the pull request against `main` and describe what the change does and why.
