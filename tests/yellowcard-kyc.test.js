const yc = require('../lib/yellowcard');

describe('Yellow Card retail KYC helpers', () => {
  it('formatDobForYc accepts dd/mm/yyyy and outputs mm/dd/yyyy', () => {
    expect(yc.formatDobForYc('15/03/1990')).toBe('03/15/1990');
  });

  it('formatDobForYc rejects future years', () => {
    expect(yc.formatDobForYc('19/09/2098')).toBeNull();
  });

  it('normalizeIdTypeForYc maps common labels', () => {
    expect(yc.normalizeIdTypeForYc('National ID')).toBe('national_id');
    expect(yc.normalizeIdTypeForYc('ID')).toBe('national_id');
    expect(yc.normalizeIdTypeForYc('Passport A123')).toBe('passport');
  });

  it('buildRetailKycFromUser strict mode requires valid dob', () => {
    const user = {
      kyc_name: 'Hamza',
      kyc_address: 'Gaborone',
      kyc_dob: '19/09/2098',
      kyc_email: 'hamza@hotmail.com',
      kyc_id_number: '109984',
      kyc_id_type: 'ID',
    };
    expect(yc.buildRetailKycFromUser(user, '+26774672123', 'BW', { strict: true })).toBeNull();
    expect(yc.describeMissingKycFields(user)).toContain(
      'date of birth (dd/mm/yyyy, must be in the past — e.g. 15/03/1990)'
    );
  });

  it('buildRetailKycFromUser normalizes valid profile for YC', () => {
    const user = {
      kyc_name: 'Hamza',
      kyc_address: 'Gaborone',
      kyc_dob: '19/09/1990',
      kyc_email: 'hamza@hotmail.com',
      kyc_id_number: '109984',
      kyc_id_type: 'National ID',
    };
    const kyc = yc.buildRetailKycFromUser(user, '+26774672123', 'BW', { strict: true });
    expect(kyc.dob).toBe('09/19/1990');
    expect(kyc.idType).toBe('national_id');
    expect(kyc.phone).toBe('+26774672123');
  });
});
