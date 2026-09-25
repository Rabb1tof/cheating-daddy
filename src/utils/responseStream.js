const { randomUUID } = require('crypto');

function createResponseStream(sendToRenderer) {
    const id = randomUUID();
    let started = false;

    return {
        id,
        update(text) {
            sendToRenderer(started ? 'update-response' : 'new-response', { id, text });
            started = true;
        },
    };
}

module.exports = { createResponseStream };
