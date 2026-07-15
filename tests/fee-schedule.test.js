const { buildFeeSchedulePdf } = require('../lib/pdf');
const { buildFeeScheduleUrl, formatKycApprovalMessage } = require('../lib/fee-schedule');

describe('fee schedule', () => {
  it('buildFeeSchedulePdf returns a PDF buffer', async () => {
    const buf = await buildFeeSchedulePdf({ walletCurrency: 'BWP' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('formatKycApprovalMessage mentions fee schedule and menu', () => {
    const msg = formatKycApprovalMessage({ walletCurrency: 'BWP' });
    expect(msg).toMatch(/verified/i);
    expect(msg).toMatch(/Fee Schedule/i);
    expect(msg).toMatch(/BWP/);
    expect(msg).toMatch(/menu/i);
    expect(msg).not.toMatch(/Yellow Card|YC/i);
  });

  it('buildFeeScheduleUrl points at fee-schedule API', () => {
    process.env.PUBLIC_APP_URL = 'https://paylink.example.com';
    expect(buildFeeScheduleUrl()).toBe('https://paylink.example.com/api/fee-schedule');
    delete process.env.PUBLIC_APP_URL;
  });
});
