jest.mock('undici', () => ({
  fetch: jest.fn(),
  ProxyAgent: jest.fn().mockImplementation(() => ({ type: 'proxy-agent' })),
}));

const { fetch: undiciFetch } = require('undici');

describe('outbound-proxy', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.FIXIE_URL;
    delete process.env.QUOTAGUARDSTATIC_URL;
    delete process.env.HTTPS_PROXY;
    global.fetch = jest.fn();
    undiciFetch.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses direct fetch when no proxy is configured', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ ip: '1.2.3.4' }) });
    const { getOutboundIp, isProxyConfigured } = require('../lib/outbound-proxy');
    expect(isProxyConfigured()).toBe(false);
    const result = await getOutboundIp();
    expect(result.ip).toBe('1.2.3.4');
    expect(global.fetch).toHaveBeenCalled();
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it('routes through undici ProxyAgent when FIXIE_URL is set', async () => {
    process.env.FIXIE_URL = 'http://fixie:secret@proxy.example:80';
    jest.resetModules();
    const undici = require('undici');
    undici.fetch.mockResolvedValue({ ok: true, json: async () => ({ ip: '203.0.113.50' }) });
    const { getOutboundIp, getProxyProviderLabel } = require('../lib/outbound-proxy');
    const result = await getOutboundIp();
    expect(result.ip).toBe('203.0.113.50');
    expect(result.proxyConfigured).toBe(true);
    expect(getProxyProviderLabel()).toBe('fixie');
    expect(undici.fetch).toHaveBeenCalledWith(
      expect.stringContaining('ipify.org'),
      expect.objectContaining({ dispatcher: expect.any(Object) })
    );
  });

  it('requires proxy for production YC when allow flag is set', () => {
    process.env.YELLOWCARD_ALLOW_PRODUCTION = 'true';
    const { assertProductionProxyIfRequired } = require('../lib/outbound-proxy');
    expect(() => assertProductionProxyIfRequired(true)).toThrow(/static outbound proxy/i);
  });
});
