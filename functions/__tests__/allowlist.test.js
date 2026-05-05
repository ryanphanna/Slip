const { isAllowed } = require('../lib/allowlist');

describe('isAllowed', () => {
  const originalAllowedPhones = process.env.ALLOWED_PHONES;

  afterEach(() => {
    if (originalAllowedPhones === undefined) {
      delete process.env.ALLOWED_PHONES;
      return;
    }
    process.env.ALLOWED_PHONES = originalAllowedPhones;
  });

  it('fails closed when ALLOWED_PHONES is missing', () => {
    delete process.env.ALLOWED_PHONES;
    expect(isAllowed('+14165551234')).toBe(false);
  });

  it('allows only exact listed phones', () => {
    process.env.ALLOWED_PHONES = '+14165551234,+14165559876';
    expect(isAllowed('+14165551234')).toBe(true);
    expect(isAllowed('+14165550000')).toBe(false);
  });
});
