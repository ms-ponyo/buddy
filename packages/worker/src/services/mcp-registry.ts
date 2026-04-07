// src/services/mcp-registry.ts — Registry for MCP server factories.
// Replaces the inline createMcpServers() from worker.ts.
// Factories are registered by name; createServers() invokes them with
// the runtime env, optionally filtering by an "enabled" list.

export type McpServerFactory = (env: Record<string, unknown>) => unknown;

export class McpRegistry {
  private readonly factories = new Map<string, McpServerFactory>();

  /**
   * Register (or replace) an MCP server factory by name.
   */
  registerFactory(name: string, factory: McpServerFactory): void {
    this.factories.set(name, factory);
  }

  /**
   * Return the names of all registered factories, in insertion order.
   */
  getServerNames(): string[] {
    return [...this.factories.keys()];
  }

  /**
   * Invoke registered factories with `env` and return a name→server map.
   * If `enabledNames` is provided, only those names are created.
   * Factories that return null/undefined are excluded from the result.
   */
  createServers(
    env: Record<string, unknown>,
    enabledNames?: string[],
  ): Record<string, unknown> {
    const servers: Record<string, unknown> = {};
    const names = enabledNames ?? [...this.factories.keys()];

    for (const name of names) {
      const factory = this.factories.get(name);
      if (!factory) continue;

      const server = factory(env);
      if (server != null) {
        servers[name] = server;
      }
    }

    return servers;
  }
}
