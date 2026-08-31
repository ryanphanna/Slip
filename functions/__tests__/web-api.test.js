const { cleanPatch, requireAuth, EDITABLE_FIELDS, VISIBLE_FAILURE_STATUSES } = require('../lib/web-api');

describe('web API helpers', () => {
  it('keeps only editable receipt fields', () => {
    expect(cleanPatch({ merchant: 'Costco', total: 12.5, from: '+1', createdAt: 'bad', items: [] }))
      .toEqual({ merchant: 'Costco', total: 12.5, items: [] });
    expect(EDITABLE_FIELDS.has('imagePaths')).toBe(false);
  });

  it('requires a signed-in phone identity', () => {
    expect(() => requireAuth({ auth: null })).toThrow('Authentication required');
    expect(requireAuth({ auth: { uid: 'user-1', token: { phone_number: '+14165551234' } } }))
      .toEqual({ uid: 'user-1', phone: '+14165551234' });
  });

  it('keeps retryable and previously reviewed processing records available', () => {
    expect(VISIBLE_FAILURE_STATUSES.has('failed')).toBe(true);
    expect(VISIBLE_FAILURE_STATUSES.has('pending')).toBe(true);
    expect(VISIBLE_FAILURE_STATUSES.has('resolved')).toBe(true);
    expect(VISIBLE_FAILURE_STATUSES.has('duplicate')).toBe(true);
    expect(VISIBLE_FAILURE_STATUSES.has('recovered')).toBe(false);
  });
});
