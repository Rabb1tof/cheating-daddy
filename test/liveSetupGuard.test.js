const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleGenAI } = require('@google/genai');
const { trackLiveTransport, connectWithSetupGuard } = require('../src/utils/liveSetupGuard');

test('Gemini Live setup guard keeps a successful session open', async () => {
    let closeCalls = 0;
    let control;
    const session = { close: () => closeCalls++ };
    const result = await connectWithSetupGuard(
        guard => {
            control = guard;
            assert.equal(guard.isWaiting(), true);
            return Promise.resolve(session);
        },
        () => closeCalls++,
        100
    );
    assert.equal(result, session);
    assert.equal(control.isWaiting(), false);
    assert.equal(control.isAbandoned(), false);
    assert.equal(closeCalls, 0);
});

test('Gemini Live setup guard rejects an early close instead of waiting forever', async () => {
    let transportClosed = 0;
    let control;
    await assert.rejects(
        connectWithSetupGuard(
            guard => {
                control = guard;
                queueMicrotask(() => guard.fail(new Error('selected model does not support Live')));
                return new Promise(() => {});
            },
            () => transportClosed++,
            100
        ),
        /does not support Live/
    );
    assert.equal(control.isAbandoned(), true);
    assert.equal(transportClosed, 1);
});

test('Gemini Live setup guard times out, closes the transport, and closes a late session', async () => {
    let finishConnect;
    let transportClosed = 0;
    let lateSessionClosed = 0;
    await assert.rejects(
        connectWithSetupGuard(
            () =>
                new Promise(resolve => {
                    finishConnect = resolve;
                }),
            () => transportClosed++,
            5
        ),
        /Timed out waiting for Gemini Live setup/
    );
    assert.equal(transportClosed, 1);
    finishConnect({ close: () => lateSessionClosed++ });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateSessionClosed, 1);
});

test('transport tracking preserves the pinned Google SDK factory and closes a connecting socket', () => {
    const client = new GoogleGenAI({ apiKey: 'test-only' });
    const stop = trackLiveTransport(client);
    const sdkTransport = client.live.webSocketFactory.create('wss://example.invalid', {}, {});
    assert.equal(typeof sdkTransport.connect, 'function');
    assert.equal(typeof sdkTransport.send, 'function');
    assert.equal(typeof sdkTransport.close, 'function');
    stop();

    let terminated = 0;
    const fakeClient = {
        live: {
            webSocketFactory: {
                create: () => ({ ws: { readyState: 0, terminate: () => terminated++ } }),
            },
        },
    };
    const stopFake = trackLiveTransport(fakeClient);
    fakeClient.live.webSocketFactory.create();
    stopFake();
    assert.equal(terminated, 1);

    fakeClient.live.webSocketFactory = {
        create: () => ({ ws: { readyState: 1, terminate: () => terminated++ } }),
    };
    const stopOpen = trackLiveTransport(fakeClient);
    fakeClient.live.webSocketFactory.create();
    stopOpen();
    assert.equal(terminated, 2);
});
