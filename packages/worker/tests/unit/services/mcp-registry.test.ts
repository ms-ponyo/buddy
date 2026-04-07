// tests/unit/services/mcp-registry.test.ts
import { describe, it, expect, beforeEach } from '@jest/globals';
import { McpRegistry } from '../../../src/services/mcp-registry';

describe('McpRegistry', () => {
  let registry: McpRegistry;

  beforeEach(() => {
    registry = new McpRegistry();
  });

  // ── registerFactory ───────────────────────────────────────────────

  describe('registerFactory()', () => {
    it('registers a factory by name', () => {
      registry.registerFactory('test-server', () => ({ type: 'test' }));
      expect(registry.getServerNames()).toContain('test-server');
    });

    it('overwrites an existing factory with the same name', () => {
      registry.registerFactory('srv', () => ({ v: 1 }));
      registry.registerFactory('srv', () => ({ v: 2 }));
      expect(registry.getServerNames()).toEqual(['srv']);
      const servers = registry.createServers({});
      expect(servers['srv']).toEqual({ v: 2 });
    });
  });

  // ── getServerNames ────────────────────────────────────────────────

  describe('getServerNames()', () => {
    it('returns empty array when no factories registered', () => {
      expect(registry.getServerNames()).toEqual([]);
    });

    it('returns registered factory names', () => {
      registry.registerFactory('alpha', () => ({}));
      registry.registerFactory('beta', () => ({}));
      expect(registry.getServerNames()).toEqual(['alpha', 'beta']);
    });
  });

  // ── createServers ─────────────────────────────────────────────────

  describe('createServers()', () => {
    it('returns empty object when no factories registered', () => {
      expect(registry.createServers({})).toEqual({});
    });

    it('invokes each factory with env and returns results', () => {
      const env = { TOKEN: 'abc' };
      registry.registerFactory('srv-a', (e) => ({ token: (e as any).TOKEN }));
      registry.registerFactory('srv-b', () => ({ static: true }));

      const servers = registry.createServers(env);
      expect(servers).toEqual({
        'srv-a': { token: 'abc' },
        'srv-b': { static: true },
      });
    });

    it('passes the env object to each factory', () => {
      const env = { HOST: 'localhost', PORT: '8080' };
      let receivedEnv: unknown;
      registry.registerFactory('capture', (e) => {
        receivedEnv = e;
        return {};
      });

      registry.createServers(env);
      expect(receivedEnv).toBe(env);
    });

    it('excludes factories that return null or undefined', () => {
      registry.registerFactory('ok', () => ({ good: true }));
      registry.registerFactory('skip-null', () => null);
      registry.registerFactory('skip-undef', () => undefined);

      const servers = registry.createServers({});
      expect(servers).toEqual({ 'ok': { good: true } });
    });
  });

  // ── filtering via enabled list ────────────────────────────────────

  describe('createServers() with enabled filter', () => {
    it('only creates servers in the enabled list', () => {
      registry.registerFactory('a', () => ({ a: true }));
      registry.registerFactory('b', () => ({ b: true }));
      registry.registerFactory('c', () => ({ c: true }));

      const servers = registry.createServers({}, ['a', 'c']);
      expect(Object.keys(servers)).toEqual(['a', 'c']);
      expect(servers['b']).toBeUndefined();
    });

    it('skips enabled names that have no registered factory', () => {
      registry.registerFactory('a', () => ({ a: true }));

      const servers = registry.createServers({}, ['a', 'nonexistent']);
      expect(Object.keys(servers)).toEqual(['a']);
    });
  });
});
