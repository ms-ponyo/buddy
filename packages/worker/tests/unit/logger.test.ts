// tests/unit/logger.test.ts
import { jest } from '@jest/globals';
import { Logger } from '../../src/logger';

describe('Logger', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('logs at info level by default', () => {
    const logger = new Logger({ module: 'test' });
    logger.info('hello');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(stderrSpy.mock.calls[0][0].replace('\n', ''));
    expect(output.level).toBe('info');
    expect(output.msg).toBe('hello');
    expect(output.module).toBe('test');
  });

  it('suppresses debug when level is info', () => {
    const logger = new Logger({ level: 'info', module: 'test' });
    logger.debug('hidden');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('creates child with inherited context', () => {
    const parent = new Logger({ module: 'parent' });
    const child = parent.child({ channel: 'C123', module: 'child' });
    child.info('from child');
    const output = JSON.parse(stderrSpy.mock.calls[0][0].replace('\n', ''));
    expect(output.module).toBe('child');
    expect(output.channel).toBe('C123');
  });
});
