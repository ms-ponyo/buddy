import { isAuthorized, parseCommaSeparated, type AuthConfig } from '../../src/authorization.js';

const noRestrictions: AuthConfig = {
  adminUserIds: [],
  allowedUserIds: [],
  allowedChannelIds: [],
};

describe('isAuthorized', () => {
  it('allows any user when no restrictions', () => {
    expect(isAuthorized('U1', 'C1', 'channel', noRestrictions)).toBe(true);
  });

  it('allows admin regardless of other restrictions', () => {
    const config: AuthConfig = { adminUserIds: ['UADMIN'], allowedUserIds: ['UOTHER'], allowedChannelIds: ['C99'] };
    expect(isAuthorized('UADMIN', 'C1', 'channel', config)).toBe(true);
  });

  it('rejects user not in allowedUserIds', () => {
    const config: AuthConfig = { ...noRestrictions, allowedUserIds: ['U1', 'U2'] };
    expect(isAuthorized('U3', 'C1', 'channel', config)).toBe(false);
  });

  it('allows user in allowedUserIds', () => {
    const config: AuthConfig = { ...noRestrictions, allowedUserIds: ['U1', 'U2'] };
    expect(isAuthorized('U1', 'C1', 'channel', config)).toBe(true);
  });

  it('allows DM even with channel restrictions', () => {
    const config: AuthConfig = { ...noRestrictions, allowedChannelIds: ['C99'] };
    expect(isAuthorized('U1', 'C1', 'im', config)).toBe(true);
  });

  it('rejects channel not in allowedChannelIds', () => {
    const config: AuthConfig = { ...noRestrictions, allowedChannelIds: ['C99'] };
    expect(isAuthorized('U1', 'C1', 'channel', config)).toBe(false);
  });

  it('allows channel in allowedChannelIds', () => {
    const config: AuthConfig = { ...noRestrictions, allowedChannelIds: ['C1', 'C2'] };
    expect(isAuthorized('U1', 'C1', 'channel', config)).toBe(true);
  });

  it('handles combined user + channel restrictions', () => {
    const config: AuthConfig = { ...noRestrictions, allowedUserIds: ['U1'], allowedChannelIds: ['C1'] };
    expect(isAuthorized('U1', 'C1', 'channel', config)).toBe(true);
    expect(isAuthorized('U1', 'C2', 'channel', config)).toBe(false);
    expect(isAuthorized('U2', 'C1', 'channel', config)).toBe(false);
  });

  it('treats undefined channelType as non-DM', () => {
    const config: AuthConfig = { ...noRestrictions, allowedChannelIds: ['C99'] };
    expect(isAuthorized('U1', 'C1', undefined, config)).toBe(false);
  });
});

describe('parseCommaSeparated', () => {
  it('returns empty array for undefined', () => {
    expect(parseCommaSeparated(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseCommaSeparated('')).toEqual([]);
  });

  it('splits and trims values', () => {
    expect(parseCommaSeparated('U1, U2 , U3')).toEqual(['U1', 'U2', 'U3']);
  });

  it('filters out empty segments', () => {
    expect(parseCommaSeparated('U1,,U2,')).toEqual(['U1', 'U2']);
  });
});
