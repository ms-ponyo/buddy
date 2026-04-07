import { loadConfig, parseThreadKey } from '../../src/config';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.PROJECT_DIR = '/tmp/test-project';
    process.env.WORKER_THREAD_KEY = 'C123:1234567890.123456';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('loads defaults from env', () => {
      const config = loadConfig();
      expect(config.projectDir).toBe('/tmp/test-project');
      expect(config.claudeModel).toBe('claude-opus-4-6');
      expect(config.logLevel).toBe('info');
    });

    it('throws if PROJECT_DIR is missing', () => {
      delete process.env.PROJECT_DIR;
      expect(() => loadConfig()).toThrow('PROJECT_DIR');
    });

    it('reads CLAUDE_MODEL override', () => {
      process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
      const config = loadConfig();
      expect(config.claudeModel).toBe('claude-sonnet-4-6');
    });
  });

  describe('parseThreadKey', () => {
    it('splits channel:threadTs', () => {
      const result = parseThreadKey('C123:1234567890.123456');
      expect(result).toEqual({ channel: 'C123', threadTs: '1234567890.123456' });
    });

    it('throws on invalid format', () => {
      expect(() => parseThreadKey('invalid')).toThrow();
    });
  });
});
