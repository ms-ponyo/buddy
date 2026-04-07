import { mockSlackAdapter } from '../mocks/mock-slack-adapter.js';
import { mockPersistenceAdapter } from '../mocks/mock-persistence-adapter.js';
import { mockLogger } from '../mocks/mock-logger.js';

describe('mock factories', () => {
  it('mockSlackAdapter tracks posted messages', async () => {
    const slack = mockSlackAdapter();
    await slack.postMessage('C1', 'ts', 'hello', []);
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0].text).toBe('hello');
  });

  it('mockPersistenceAdapter stores sessions in memory', async () => {
    const persistence = mockPersistenceAdapter();
    await persistence.upsertSession('C1:ts', { sessionId: 'sid' });
    const id = await persistence.getSessionId('C1', 'ts');
    expect(id).toBe('sid');
  });

  it('mockPersistenceAdapter tracks cost', async () => {
    const persistence = mockPersistenceAdapter();
    await persistence.addCost('C1', 'ts', 1.5);
    const cost = await persistence.getCost('C1', 'ts');
    expect(cost).toBe(1.5);
  });

  it('mockLogger captures log calls', () => {
    const logger = mockLogger();
    logger.info('test message', { key: 'val' });
    expect(logger.calls.info).toHaveLength(1);
    expect(logger.calls.info[0].msg).toBe('test message');
  });
});
