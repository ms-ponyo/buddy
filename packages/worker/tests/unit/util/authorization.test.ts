import { isAuthorized } from '../../../src/util/authorization';

const baseConfig = {
  adminUserIds: [] as string[],
  allowedUserIds: [] as string[],
  allowedChannelIds: [] as string[],
};

describe('isAuthorized', () => {
  it('allows any user when no restrictions', () => {
    expect(isAuthorized('U1', 'C1', 'channel', baseConfig)).toBe(true);
  });

  it('allows admin regardless of other restrictions', () => {
    const config = { ...baseConfig, adminUserIds: ['UADMIN'], allowedUserIds: ['UOTHER'] };
    expect(isAuthorized('UADMIN', 'C1', 'channel', config)).toBe(true);
  });

  it('rejects user not in allowedUserIds', () => {
    const config = { ...baseConfig, allowedUserIds: ['U1', 'U2'] };
    expect(isAuthorized('U3', 'C1', 'channel', config)).toBe(false);
  });

  it('allows user in allowedUserIds', () => {
    const config = { ...baseConfig, allowedUserIds: ['U1', 'U2'] };
    expect(isAuthorized('U1', 'C1', 'channel', config)).toBe(true);
  });

  it('allows DM even with channel restrictions', () => {
    const config = { ...baseConfig, allowedChannelIds: ['C99'] };
    expect(isAuthorized('U1', 'C1', 'im', config)).toBe(true);
  });

  it('rejects channel not in allowedChannelIds', () => {
    const config = { ...baseConfig, allowedChannelIds: ['C99'] };
    expect(isAuthorized('U1', 'C1', 'channel', config)).toBe(false);
  });

  it('allows channel in allowedChannelIds', () => {
    const config = { ...baseConfig, allowedChannelIds: ['C1', 'C2'] };
    expect(isAuthorized('U1', 'C1', 'channel', config)).toBe(true);
  });

  it('handles combined user + channel restrictions', () => {
    const config = { ...baseConfig, allowedUserIds: ['U1'], allowedChannelIds: ['C1'] };
    expect(isAuthorized('U1', 'C1', 'channel', config)).toBe(true);
    expect(isAuthorized('U1', 'C2', 'channel', config)).toBe(false);
    expect(isAuthorized('U2', 'C1', 'channel', config)).toBe(false);
  });
});
