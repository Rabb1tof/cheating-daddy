function trackLiveTransport(client) {
    // @google/genai 2.24.0 exposes its Node transport factory here. Keep the
    // socket so an abandoned setup can be terminated even if connect() hangs.
    const factory = client.live.webSocketFactory;
    if (!factory?.create) return () => {};
    let transport;
    client.live.webSocketFactory = {
        create(...args) {
            transport = factory.create(...args);
            return transport;
        },
    };
    return () => {
        try {
            if (transport?.ws?.readyState < 2 && typeof transport.ws.terminate === 'function') transport.ws.terminate();
            else if (transport?.ws?.readyState === 1) transport.close();
        } catch (error) {
            console.error('Failed to close abandoned Gemini Live socket:', error.message);
        }
    };
}

async function connectWithSetupGuard(connect, closeTransport, timeoutMs) {
    let phase = 'waiting';
    let rejectEarly;
    let earlyError = null;
    let timeout;
    let connectPromise;
    const earlyFailure = new Promise((_, reject) => {
        rejectEarly = reject;
    });
    const guard = {
        isWaiting: () => phase === 'waiting',
        isAbandoned: () => phase === 'abandoned',
        fail: error => {
            if (phase === 'waiting' && !earlyError) {
                earlyError = error;
                rejectEarly(error);
            }
        },
    };

    try {
        connectPromise = Promise.resolve(connect(guard));
        const timedOut = new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Timed out waiting for Gemini Live setup')), timeoutMs);
        });
        const session = await Promise.race([connectPromise, earlyFailure, timedOut]);
        // A close can arrive after connect() settles but before this continuation.
        if (earlyError) throw earlyError;
        phase = 'connected';
        return session;
    } catch (error) {
        phase = 'abandoned';
        closeTransport();
        // The SDK may resolve after our guard rejected. Close that late session too.
        connectPromise
            ?.then(
                session => session?.close?.(),
                () => {}
            )
            .catch(() => {});
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { trackLiveTransport, connectWithSetupGuard };
