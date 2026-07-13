const {
  detectCountryFromNumber,
  detectSendCorridorFromNumber,
  isSupportedWhatsAppNumber,
  parseCorridorPickerChoice,
  defaultCountryForCurrency,
  countriesForCurrency,
  getSendCorridors,
  getRegisterableCorridors,
} = require('../lib/yellowcard');

describe('country corridors (YC Addendum 1)', () => {
  it('detects registerable dial codes', () => {
    expect(detectCountryFromNumber('+26771234567')).toEqual({ country: 'BW', currency: 'BWP' });
    expect(detectCountryFromNumber('+2348012345678')).toEqual({ country: 'NG', currency: 'NGN' });
    expect(detectCountryFromNumber('+22670123456')).toEqual({ country: 'BF', currency: 'XOF' });
    expect(detectCountryFromNumber('+23566123456')).toEqual({ country: 'TD', currency: 'XAF' });
  });

  it('detects send-only momo corridors', () => {
    const { detectSendCorridorFromNumber } = require('../lib/yellowcard');
    expect(detectSendCorridorFromNumber('+243812345678')).toEqual({ country: 'CD', currency: 'CDF' });
    expect(detectCountryFromNumber('+243812345678')).toBeNull();
  });

  it('rejects unsupported dial codes', () => {
    expect(detectCountryFromNumber('+441234567890')).toBeNull();
    expect(isSupportedWhatsAppNumber('+263771234567')).toBe(false);
  });

  it('handles shared currencies (XOF)', () => {
    expect(countriesForCurrency('XOF').sort()).toEqual(['BF', 'BJ', 'CI', 'ML', 'SN', 'TG'].sort());
    expect(defaultCountryForCurrency('XOF')).toBeNull();
    expect(defaultCountryForCurrency('KES')).toBe('KE');
  });

  it('includes LATAM send-only bank corridors', () => {
    const codes = getSendCorridors().map((c) => c.country);
    expect(codes).toEqual(expect.arrayContaining(['AR', 'BR', 'CO', 'MX']));
    expect(detectCountryFromNumber('+5511999999999')).toBeNull();
    expect(defaultCountryForCurrency('BRL')).toBe('BR');
    expect(getSendCorridors().length).toBe(25);
  });

  it('parses numbered corridor picker', () => {
    const corridors = getSendCorridors();
    expect(parseCorridorPickerChoice('1')).toEqual(corridors[0]);
    expect(parseCorridorPickerChoice('99')).toBeNull();
    expect(getRegisterableCorridors().length).toBe(19);
  });

  it('filters corridor picker by currency', () => {
    const xof = parseCorridorPickerChoice('1', { currency: 'XOF' });
    expect(xof.currency).toBe('XOF');
  });
});
