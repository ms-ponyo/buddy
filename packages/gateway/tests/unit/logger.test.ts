import { jest } from '@jest/globals';
import fs from 'fs';

// Spy on fs.createWriteStream to capture writes without touching disk
let writtenLines: string[];
let mockStream: { write: jest.Mock; end: jest.Mock };

beforeEach(() => {
  writtenLines = [];
  mockStream = {
    write: jest.fn((line: string) => { writtenLines.push(line.trim()); }),
    end: jest.fn(),
  };
  jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  jest.spyOn(fs, 'createWriteStream').mockReturnValue(mockStream as any);
  jest.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
  jest.spyOn(fs, 'symlinkSync').mockReturnValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('gateway logger', () => {
  it('writes debug messages when level is debug', async () => {
    const { createLogger } = await import('../../src/logger.js');
    const logger = createLogger('test', 'debug');
    logger.debug('hello debug');
    expect(writtenLines.some((l) => l.includes('"level":"debug"') && l.includes('hello debug'))).toBe(true);
  });

  it('suppresses debug messages when level is info', async () => {
    const { createLogger } = await import('../../src/logger.js');
    const logger = createLogger('test', 'info');
    logger.debug('should not appear');
    logger.info('should appear');
    expect(writtenLines.some((l) => l.includes('should not appear'))).toBe(false);
    expect(writtenLines.some((l) => l.includes('should appear'))).toBe(true);
  });

  it('has debug method on the Logger interface', async () => {
    const { createLogger } = await import('../../src/logger.js');
    const logger = createLogger('test');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });
});
