// tests/mocks/mock-logger.ts — In-memory mock for Logger.

import { jest } from '@jest/globals';

export interface MockLogEntry {
  msg: string;
  data?: Record<string, unknown>;
}

export interface MockLoggerCalls {
  debug: MockLogEntry[];
  info: MockLogEntry[];
  warn: MockLogEntry[];
  error: MockLogEntry[];
}

export interface MockLogger {
  calls: MockLoggerCalls;
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  child: jest.Mock;
}

export function mockLogger(inheritedContext: Record<string, unknown> = {}): MockLogger {
  const calls: MockLoggerCalls = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };

  const makeLogFn = (level: keyof MockLoggerCalls): jest.Mock => {
    return jest.fn((msg: string, data?: Record<string, unknown>) => {
      calls[level].push({ msg, data });
    });
  };

  const logger: MockLogger = {
    calls,
    debug: makeLogFn('debug'),
    info: makeLogFn('info'),
    warn: makeLogFn('warn'),
    error: makeLogFn('error'),
    child: jest.fn((fields: Record<string, unknown>) => mockLogger({ ...inheritedContext, ...fields })),
  };

  return logger;
}
