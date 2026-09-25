const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function createApp() {
    const ipcRenderer = new EventEmitter();
    const cheatingDaddy = {
        storage: {
            getPreferences: async () => ({ providerMode: 'byok' }),
            getConfig: async () => ({ transcriptionProvider: 'groq' }),
            getGroqApiKey: async () => 'test-key',
        },
        initializeGroq: async () => true,
        startCapture: async () => {},
    };
    const source = fs
        .readFileSync(path.join(__dirname, '../src/components/app/CheatingDaddyApp.js'), 'utf8')
        .replace(/^import .*;\r?$/gm, '')
        .replace('export class CheatingDaddyApp', 'class CheatingDaddyApp');
    const module = { exports: {} };
    vm.runInNewContext(`${source}\nmodule.exports = CheatingDaddyApp;`, {
        module,
        LitElement: class {
            connectedCallback() {}
            requestUpdate() {}
        },
        css: () => '',
        html: () => '',
        customElements: { define: () => {} },
        window: { require: () => ({ ipcRenderer }) },
        cheatingDaddy,
        console,
    });
    const app = Object.create(module.exports.prototype);
    app.responses = [];
    app._responseIds = [];
    app.currentResponseIndex = -1;
    app.selectedProfile = 'interview';
    app.selectedLanguage = 'en-US';
    app.selectedScreenshotInterval = '5';
    app.selectedImageQuality = 'medium';
    app._startTimer = () => {};
    app.connectedCallback();
    return { app, ipcRenderer };
}

test('interleaved streams update their own response and keep manual navigation', () => {
    const { app, ipcRenderer } = createApp();
    const emit = (channel, data) => ipcRenderer.emit(channel, {}, data);

    emit('new-response', { id: 'A', text: 'A first' });
    emit('update-response', { id: 'A', text: 'A partial' });
    emit('new-response', { id: 'B', text: 'B first' });
    emit('update-response', { id: 'B', text: 'B final' });
    emit('update-response', { id: 'A', text: 'A final' });

    assert.deepEqual(Array.from(app.responses), ['A final', 'B final']);
    assert.equal(app.currentResponseIndex, 1);
    app.handleResponseIndexChanged({ detail: { index: 0 } });
    emit('update-response', { id: 'B', text: 'B revised' });
    emit('new-response', { id: 'C', text: 'C first' });
    emit('new-response', { id: 'A', text: 'A revised' });

    assert.deepEqual(Array.from(app.responses), ['A revised', 'B revised', 'C first']);
    assert.equal(app.currentResponseIndex, 0);
});

test('legacy strings retain last-response updates and old IDs are ignored after session reset', async () => {
    const { app, ipcRenderer } = createApp();
    const emit = (channel, data) => ipcRenderer.emit(channel, {}, data);

    emit('new-response', 'Legacy first');
    emit('update-response', 'Legacy final');
    emit('new-response', { id: 'old', text: 'Old stream' });
    assert.deepEqual(Array.from(app.responses), ['Legacy final', 'Old stream']);

    await app.handleStart();
    assert.deepEqual(Array.from(app.responses), []);
    assert.deepEqual(Array.from(app._responseIds), []);
    assert.equal(app.currentResponseIndex, -1);

    emit('update-response', { id: 'old', text: 'Stale update' });
    assert.deepEqual(Array.from(app.responses), []);
    emit('new-response', { id: 'new', text: 'New stream' });
    emit('update-response', { id: 'new', text: 'New final' });
    assert.deepEqual(Array.from(app.responses), ['New final']);
});
