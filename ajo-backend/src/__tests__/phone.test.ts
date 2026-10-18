import { normalizePhone } from '../lib/phone';

describe('phone numbers typed behind a visible country code', () => {
  it('accepts the number with no 0 and no code, with a 0, or in full', () => {
    expect(normalizePhone('803 123 4567', 'NG')).toBe('+2348031234567');
    expect(normalizePhone('0803 123 4567', 'NG')).toBe('+2348031234567');
    expect(normalizePhone('+234 803 123 4567', 'NG')).toBe('+2348031234567');
    expect(normalizePhone('24 123 4567', 'GH')).toBe('+233241234567');
    expect(normalizePhone('712 345 678', 'KE')).toBe('+254712345678');
  });
  it('still rejects numbers that are not real', () => {
    expect(normalizePhone('12345', 'NG')).toBeNull();
    expect(normalizePhone('603 123 4567', 'NG')).toBeNull();
    expect(normalizePhone('803 123 456', 'NG')).toBeNull();
    expect(normalizePhone('abc', 'NG')).toBeNull();
  });
});
