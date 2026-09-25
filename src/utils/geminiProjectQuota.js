const SERVICE = 'generativelanguage.googleapis.com';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MONITORING_METRICS = [
    'generate_content_free_tier_requests',
    'generate_content_free_tier_input_token_count',
];
const CACHE_MS = 5 * 60 * 1000;
const MAX_PAGES = 5;

function numericValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function quotaPeriod(refreshInterval) {
    const interval = String(refreshInterval || '').toLowerCase();
    if (/\b(day|24 hours|86400s)\b/.test(interval)) return 'day';
    if (/\b(minute|60 seconds|60s)\b/.test(interval)) return 'minute';
    return null;
}

function quotaKind(metric, displayName, period) {
    const name = `${metric} ${displayName}`.toLowerCase();
    if (!period) return null;
    const unit = /token/.test(name) ? 'tokens' : /request/.test(name) ? 'requests' : null;
    if (unit === 'tokens') return period === 'minute' ? 'tpm' : 'tpd';
    if (unit === 'requests') return period === 'minute' ? 'rpm' : 'rpd';
    return null;
}

function normalizeQuotaInfos(infos) {
    return infos.flatMap(info => {
        if (!info || typeof info.metric !== 'string' || !info.metric.startsWith(`${SERVICE}/`)) return [];
        const period = quotaPeriod(info.refreshInterval);
        const displayName = info.quotaDisplayName || info.metricDisplayName || info.quotaId || info.metric;
        const dimensionInfos = Array.isArray(info.dimensionsInfos) ? info.dimensionsInfos : [];
        return dimensionInfos.map(item => {
            const dimensions = item?.dimensions && typeof item.dimensions === 'object' ? { ...item.dimensions } : {};
            return {
                quotaId: info.quotaId || null,
                metric: info.metric,
                displayName,
                model: String(dimensions.model || dimensions.model_id || '').replace(/^models\//, '') || null,
                dimensions,
                applicableLocations: Array.isArray(item?.applicableLocations) ? [...item.applicableLocations] : [],
                limit: numericValue(item?.details?.value),
                unit: info.metricUnit || null,
                refreshInterval: info.refreshInterval || null,
                kind: quotaKind(info.metric, displayName, period),
                isPrecise: info.isPrecise === true,
            };
        });
    });
}

function latestPoint(points) {
    if (!Array.isArray(points)) return null;
    return points
        .filter(point => numericValue(point?.value?.int64Value) !== null && Number.isFinite(Date.parse(point?.interval?.endTime)))
        .sort((left, right) => Date.parse(right.interval.endTime) - Date.parse(left.interval.endTime))[0] || null;
}

function normalizeMonitoring(metricName, limitSeries, usageSeries) {
    const groups = new Map();
    function groupFor(series) {
        const labels = series?.metric?.labels || {};
        const model = labels.model || null;
        const limitName = labels.limit_name || null;
        const location = series?.resource?.labels?.location || null;
        const key = JSON.stringify([metricName, model, limitName, location]);
        if (!groups.has(key)) {
            groups.set(key, {
                metric: `${SERVICE}/${metricName}`,
                model,
                limitName,
                location,
                kind: null,
                limit: null,
                usage: null,
            });
        }
        const group = groups.get(key);
        const period = /per.?day|daily|rpd/i.test(limitName || '') ? 'day' : /per.?minute|rpm|tpm/i.test(limitName || '') ? 'minute' : null;
        group.kind = quotaKind(metricName, limitName || '', period);
        return group;
    }
    for (const series of limitSeries) {
        const point = latestPoint(series.points);
        if (!point) continue;
        const group = groupFor(series);
        const observedAt = point.interval.endTime;
        const value = numericValue(point.value.int64Value);
        if (!group.limit || Date.parse(observedAt) > Date.parse(group.limit.observedAt)) {
            group.limit = { value, observedAt };
        }
    }
    const usageBuckets = new Map();
    for (const series of usageSeries) {
        const validPoints = (Array.isArray(series.points) ? series.points : []).filter(point => {
            return numericValue(point?.value?.int64Value) !== null && Number.isFinite(Date.parse(point?.interval?.endTime));
        });
        if (validPoints.length === 0) continue;
        const group = groupFor(series);
        if (!usageBuckets.has(group)) usageBuckets.set(group, new Map());
        const buckets = usageBuckets.get(group);
        for (const point of validPoints) {
            const value = numericValue(point?.value?.int64Value);
            const intervalStart = point?.interval?.startTime || null;
            const intervalEnd = point?.interval?.endTime;
            const key = JSON.stringify([intervalStart, intervalEnd]);
            if (!buckets.has(key)) buckets.set(key, { value: 0, intervalStart, intervalEnd });
            buckets.get(key).value += value;
        }
    }
    for (const [group, buckets] of usageBuckets) {
        // DELTA series can be split by method. Sum only samples for the same
        // interval; choosing one series would underreport project usage.
        const latest = [...buckets.values()]
            .filter(bucket => Number.isSafeInteger(bucket.value))
            .sort((left, right) => Date.parse(right.intervalEnd) - Date.parse(left.intervalEnd))[0];
        if (latest) group.usage = latest;
    }
    return [...groups.values()].sort((left, right) => {
        return `${left.model || ''}:${left.limitName || ''}`.localeCompare(`${right.model || ''}:${right.limitName || ''}`);
    });
}

function readableFailure(error, api, projectId, serviceName) {
    const status = Number(error?.response?.status || error?.status || error?.code);
    if (status === 401) return `${api}: Google Cloud sign-in has expired. Run gcloud auth application-default login.`;
    if (status === 403) {
        const details = error?.response?.data?.error?.details || error?.response?.data?.details;
        const billingReason = Array.isArray(details) && details.some(detail =>
            detail?.reason === 'BILLING_REQUIRED' || detail?.reason === 'BILLING_DISABLED'
        );
        const message = error?.response?.data?.error?.message || error?.response?.data?.message || error?.message;
        if (serviceName === 'monitoring.googleapis.com' &&
            (billingReason || /this api method requires billing to be enabled/i.test(String(message || '')))) {
            return 'Cloud Monitoring usage requires a billing-enabled Google Cloud project. This app does not enable billing.';
        }
        if (Array.isArray(details) && details.some(detail => detail?.reason === 'SERVICE_DISABLED')) {
            const enableUrl = `https://console.cloud.google.com/apis/library/${serviceName}?project=${encodeURIComponent(projectId)}`;
            return `${api}: ${serviceName} is disabled for this project. Enable it at ${enableUrl}`;
        }
        return `${api}: access denied. Check that the API is enabled and your Google account has read-only quota/monitoring access.`;
    }
    if (status === 404) return `${api}: project or API was not found. Check the Google Cloud project ID.`;
    if (Number.isInteger(status) && status >= 400) return `${api}: Google Cloud returned HTTP ${status}.`;
    return `${api}: could not read Google Cloud credentials or reach the API. Run gcloud auth application-default login and retry.`;
}

function validProjectId(projectId) {
    return typeof projectId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.:-]{1,63}$/.test(projectId);
}

function createGeminiProjectQuotaClient({ request, createAuthClient, now = Date.now, cacheTtlMs = CACHE_MS } = {}) {
    const cache = new Map();
    let authClientPromise;
    async function googleRequest(url) {
        if (request) return request(url);
        if (!authClientPromise) {
            authClientPromise = (async () => {
                if (createAuthClient) return createAuthClient();
                const { GoogleAuth } = require('google-auth-library');
                return new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] }).getClient();
            })().catch(error => {
                authClientPromise = null;
                throw error;
            });
        }
        const client = await authClientPromise;
        const response = await client.request({ url, method: 'GET', timeout: 10000 });
        return response.data;
    }
    async function listPages(baseUrl, arrayKey, maxPages = MAX_PAGES) {
        const entries = [];
        let pageToken = '';
        for (let page = 0; page < maxPages; page += 1) {
            const url = new URL(baseUrl);
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            const result = await googleRequest(url.toString());
            entries.push(...(Array.isArray(result?.[arrayKey]) ? result[arrayKey] : []));
            pageToken = result?.nextPageToken || '';
            if (!pageToken) return { entries, truncated: false };
        }
        return { entries, truncated: Boolean(pageToken) };
    }
    async function load(projectId) {
        const warnings = [];
        const encodedProject = encodeURIComponent(projectId);
        const fetchedAt = new Date(now()).toISOString();
        let quotas = [];
        try {
            const quotaUrl = `https://cloudquotas.googleapis.com/v1/projects/${encodedProject}/locations/global/services/${SERVICE}/quotaInfos?pageSize=100`;
            const result = await listPages(quotaUrl, 'quotaInfos');
            quotas = normalizeQuotaInfos(result.entries);
            if (result.truncated) warnings.push('Cloud Quotas: results were truncated after five pages.');
        } catch (error) {
            warnings.push(readableFailure(error, 'Cloud Quotas', projectId, 'cloudquotas.googleapis.com'));
        }
        const monitoring = [];
        const metricResults = await Promise.all(MONITORING_METRICS.map(async metricName => {
            const query = async (suffix, minutes) => {
                const url = new URL(`https://monitoring.googleapis.com/v3/projects/${encodedProject}/timeSeries`);
                url.searchParams.set('filter', `metric.type="${SERVICE}/quota/${metricName}/${suffix}"`);
                url.searchParams.set('interval.startTime', new Date(now() - minutes * 60 * 1000).toISOString());
                url.searchParams.set('interval.endTime', new Date(now()).toISOString());
                url.searchParams.set('view', 'FULL');
                url.searchParams.set('pageSize', '1000');
                return listPages(url.toString(), 'timeSeries', 2);
            };
            try {
                const [limits, usage] = await Promise.all([query('limit', 15), query('usage', 15)]);
                if (limits.truncated || usage.truncated) warnings.push(`Cloud Monitoring: ${metricName} samples were truncated.`);
                return normalizeMonitoring(metricName, limits.entries, usage.entries);
            } catch (error) {
                warnings.push(readableFailure(error, `Cloud Monitoring ${metricName}`, projectId, 'monitoring.googleapis.com'));
                return [];
            }
        }));
        monitoring.push(...metricResults.flat());
        if (quotas.length === 0 && monitoring.length === 0 && warnings.length === 0) {
            warnings.push('Google Cloud returned no Gemini quota data for this project. Check the project linked to your Gemini API key.');
        }
        const distinctWarnings = [...new Set(warnings)];
        return {
            projectId,
            fetchedAt,
            quotas,
            monitoring,
            warnings: distinctWarnings,
            status: distinctWarnings.length ? (quotas.length || monitoring.length ? 'partial' : 'unavailable') : 'ok',
        };
    }
    return {
        async getProjectQuota(projectId, { forceRefresh = false } = {}) {
            if (!validProjectId(projectId)) throw new Error('Enter a valid Google Cloud project ID or project number.');
            const existing = cache.get(projectId);
            if (!forceRefresh && existing && now() - existing.at < cacheTtlMs) return existing.result;
            if (existing?.pending) return existing.pending;
            if (forceRefresh) authClientPromise = null;
            const pending = load(projectId);
            cache.set(projectId, { at: now(), pending });
            try {
                const result = await pending;
                cache.set(projectId, { at: now(), result });
                return result;
            } catch (error) {
                cache.delete(projectId);
                throw error;
            }
        },
    };
}

const defaultClient = createGeminiProjectQuotaClient();

module.exports = {
    getGeminiProjectQuota: defaultClient.getProjectQuota,
    createGeminiProjectQuotaClient,
    normalizeQuotaInfos,
    normalizeMonitoring,
};
