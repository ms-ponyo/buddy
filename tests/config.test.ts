import { loadConfig } from '../packages/worker/src/config';

describe('loadConfig', () => {
  it('should default permissionDestination to projectSettings', () => {
    delete process.env.PERMISSION_DESTINATION;
    const config = loadConfig();
    expect(config.permissionDestination).toBe('projectSettings');
  });

  it('should use PERMISSION_DESTINATION env var when provided', () => {
    process.env.PERMISSION_DESTINATION = 'session';
    const config = loadConfig();
    expect(config.permissionDestination).toBe('session');
  });
});