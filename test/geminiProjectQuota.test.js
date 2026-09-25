const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createGeminiProjectQuotaClient,
    normalizeQuotaInfos,
    normalizeMonitoring,
} = require('../src/utils/geminiProjectQuota');

test('normalizes effective per-model quotas without inventing missing values', () => {
    const quotas = normalizeQuotaInfos([
        {
            quotaId: 'GenerateRequestsPerMinute',
            metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaDisplayName: 'Generate requests per minute',
            metricUnit: '1',
            refreshInterval: 'minute',
            isPrecise: true,
            dimensionsInfos: [
                { dimensions: { model: 'gemini-test' }, details: { value: '15' }, applicableLocations: ['global'] },
                { dimensions: {}, details: {}, applicableLocations: ['global'] },
            ],
        },
        { metric: 'other.googleapis.com/requests', dimensionsInfos: [{ details: { value: '100' } }] },
    ]);
    assert.equal(quotas.length, 2);
    assert.deepEqual(quotas[0], {
        quotaId: 'GenerateRequestsPerMinute',
        metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
        displayName: 'Generate requests per minute',
        model: 'gemini-test',
        dimensions: { model: 'gemini-test' },
        applicableLocations: ['global'],
        limit: 15,
        unit: '1',
        refreshInterval: 'minute',
        kind: 'rpm',
        isPrecise: true,
    });
    assert.equal(quotas[1].limit, null);
    assert.equal(quotas[1].model, null);
});

test('sums distinct Monitoring method series within the same delayed DELTA interval', () => {
    const labels = { model: 'gemini-test', limit_name: 'RequestsPerMinute' };
    const resource = { labels: { location: 'global' } };
    const rows = normalizeMonitoring('generate_content_free_tier_requests', [
        { metric: { labels }, resource, points: [{ interval: { endTime: '2026-09-25T12:00:00Z' }, value: { int64Value: '15' } }] },
    ], [
        {
            metric: { labels: { ...labels, method: 'GenerateContent' } }, resource,
            points: [
                { interval: { startTime: '2026-09-25T11:57:00Z', endTime: '2026-09-25T11:58:00Z' }, value: { int64Value: '3' } },
                { interval: { startTime: '2026-09-25T11:58:00Z', endTime: '2026-09-25T11:59:00Z' }, value: { int64Value: '4' } },
            ],
        },
        {
            metric: { labels: { ...labels, method: 'BidiGenerateContent' } }, resource,
            points: [
                { interval: { startTime: '2026-09-25T11:57:00Z', endTime: '2026-09-25T11:58:00Z' }, value: { int64Value: '5' } },
                { interval: { startTime: '2026-09-25T11:58:00Z', endTime: '2026-09-25T11:59:00Z' }, value: { int64Value: '2' } },
            ],
        },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'rpm');
    assert.deepEqual(rows[0].limit, { value: 15, observedAt: '2026-09-25T12:00:00Z' });
    assert.deepEqual(rows[0].usage, {
        value: 6,
        intervalStart: '2026-09-25T11:58:00Z',
        intervalEnd: '2026-09-25T11:59:00Z',
    });
    assert.equal(rows[0].remaining, undefined);
});

test('ignores Monitoring series without valid samples', () => {
    assert.deepEqual(normalizeMonitoring('generate_content_free_tier_requests', [], [
        { metric: { labels: { model: 'gemini-test' } }, points: [] },
    ]), []);
});

test('reads Cloud Quotas and Monitoring with a bounded cache and safe error text', async () => {
    let instant = Date.parse('2026-09-25T12:00:00Z');
    const calls = [];
    const request = async url => {
        calls.push(url);
        if (url.includes('cloudquotas.googleapis.com')) {
            return {
                quotaInfos: [{
                    quotaId: 'FreeRequestsPerDay',
                    metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                    quotaDisplayName: 'Free requests per day',
                    refreshInterval: 'day',
                    dimensionsInfos: [{ dimensions: { model: 'gemini-test' }, details: { value: '500' } }],
                }],
            };
        }
        if (new URL(url).searchParams.get('filter')?.includes('/generate_content_free_tier_input_token_count/usage')) {
            throw { response: { status: 403 }, message: 'Bearer very-secret-token' };
        }
        return { timeSeries: [] };
    };
    const client = createGeminiProjectQuotaClient({ request, now: () => instant });
    const first = await client.getProjectQuota('test-project-123');
    assert.equal(first.quotas[0].kind, 'rpd');
    assert.equal(first.quotas[0].limit, 500);
    assert.equal(first.status, 'partial');
    assert.ok(first.warnings.some(message => message.includes('access denied')));
    assert.equal(JSON.stringify(first).includes('very-secret-token'), false);
    assert.equal(calls.length, 5);
    assert.strictEqual(await client.getProjectQuota('test-project-123'), first);
    assert.equal(calls.length, 5);
    instant += 5 * 60 * 1000 + 1;
    await client.getProjectQuota('test-project-123');
    assert.equal(calls.length, 10);
    await assert.rejects(client.getProjectQuota('../bad-project'), /valid Google Cloud project/);
});

test('force refresh reacquires ADC client and coalesces concurrent refreshes', async () => {
    let authClients = 0;
    const requestsByClient = [];
    const client = createGeminiProjectQuotaClient({
        createAuthClient: async () => {
            const clientId = ++authClients;
            return {
                request: async ({ url }) => {
                    requestsByClient.push(clientId);
                    return { data: url.includes('cloudquotas.googleapis.com')
                        ? { quotaInfos: [] }
                        : { timeSeries: [] } };
                },
            };
        },
    });
    await client.getProjectQuota('test-project-123');
    await client.getProjectQuota('test-project-123');
    assert.equal(authClients, 1);
    await Promise.all([
        client.getProjectQuota('test-project-123', { forceRefresh: true }),
        client.getProjectQuota('test-project-123', { forceRefresh: true }),
    ]);
    assert.equal(authClients, 2);
    assert.equal(requestsByClient.filter(id => id === 2).length, 5);
    await client.getProjectQuota('test-project-123', { forceRefresh: true });
    assert.equal(authClients, 3);
});

test('SERVICE_DISABLED warning names the API and links to its enable page without raw error text', async () => {
    const client = createGeminiProjectQuotaClient({
        request: async url => {
            const serviceName = url.includes('cloudquotas.googleapis.com')
                ? 'cloudquotas.googleapis.com'
                : 'monitoring.googleapis.com';
            throw {
                response: {
                    status: 403,
                    data: { error: { details: [{ reason: 'SERVICE_DISABLED', metadata: { service: serviceName } }] } },
                },
                message: 'Bearer very-secret-token',
            };
        },
    });
    const result = await client.getProjectQuota('test-project-123');
    assert.ok(result.warnings.some(message => message.includes(
        'https://console.cloud.google.com/apis/library/cloudquotas.googleapis.com?project=test-project-123'
    )));
    assert.ok(result.warnings.some(message => message.includes(
        'https://console.cloud.google.com/apis/library/monitoring.googleapis.com?project=test-project-123'
    )));
    assert.equal(JSON.stringify(result).includes('very-secret-token'), false);
});

test('Monitoring billing errors explain the requirement without echoing error data', async () => {
    for (const reason of ['BILLING_REQUIRED', 'BILLING_DISABLED', null]) {
        const client = createGeminiProjectQuotaClient({
            request: async url => {
                if (url.includes('cloudquotas.googleapis.com')) return { quotaInfos: [] };
                throw {
                    response: {
                        status: 403,
                        data: { error: {
                            message: 'This API method requires billing to be enabled. Bearer very-secret-token',
                            details: reason ? [{ reason }] : [],
                        } },
                    },
                    message: 'Bearer very-secret-token',
                };
            },
        });
        const result = await client.getProjectQuota('test-project-123');
        assert.ok(result.warnings.some(message => message.includes('Cloud Monitoring usage requires a billing-enabled Google Cloud project')));
        assert.equal(result.warnings.length, 1);
        assert.ok(result.warnings.every(message => !message.includes('very-secret-token')));
    }
});
