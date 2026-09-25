const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createStorage(savedConfig, groqKey = '') {
    const files = new Map();
    const directories = new Set();
    const winPath = path.win32;
    const home = 'F:\\storage-test';
    const configDir = winPath.join(home, 'AppData', 'Roaming', 'cheating-daddy-config');
    const configPath = winPath.join(configDir, 'config.json');
    const credentialsPath = winPath.join(configDir, 'credentials.json');
    if (savedConfig) files.set(configPath, JSON.stringify(savedConfig));
    files.set(credentialsPath, JSON.stringify({ apiKey: '', groqApiKey: groqKey }));

    const fakeFs = {
        existsSync: filePath => files.has(filePath) || directories.has(filePath),
        readFileSync: filePath => files.get(filePath),
        writeFileSync: (filePath, data) => files.set(filePath, data),
        mkdirSync: dirPath => directories.add(dirPath),
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/storage.js'), 'utf8'), {
        module,
        exports: module.exports,
        require: name => {
            if (name === 'fs') return fakeFs;
            if (name === 'path') return winPath;
            if (name === 'os') return { platform: () => 'win32', homedir: () => home };
            throw new Error(`Unexpected dependency: ${name}`);
        },
        console: { warn: () => {}, error: () => {}, log: () => {} },
    });
    return { storage: module.exports, readSaved: () => JSON.parse(files.get(configPath)) };
}

test('legacy Gemini speech and saved Groq key preserve hybrid responses once', () => {
    const { storage, readSaved } = createStorage({ configVersion: 1, transcriptionProvider: 'gemini', groqModel: 'chosen-model' }, 'saved-key');
    assert.equal(storage.getConfig().responseProvider, 'groq');
    assert.equal(readSaved().responseProvider, 'groq');
    assert.equal(readSaved().groqModel, 'chosen-model');
    assert.equal(readSaved().configVersion, 1);

    storage.setGroqApiKey('');
    assert.equal(storage.getConfig().responseProvider, 'groq');
});

test('new Groq key for screenshots does not switch previously migrated Gemini responses', () => {
    const { storage, readSaved } = createStorage({ configVersion: 1, transcriptionProvider: 'gemini' });
    assert.equal(storage.getConfig().responseProvider, 'auto');
    storage.setGroqApiKey('new-key');
    assert.equal(storage.getConfig().responseProvider, 'auto');
    assert.equal(readSaved().responseProvider, 'auto');
});

test('legacy migration uses effective default speech provider and respects an explicit response choice', () => {
    const omittedSpeech = createStorage({ configVersion: 1 }, 'saved-key');
    assert.equal(omittedSpeech.storage.getConfig().responseProvider, 'groq');

    const explicitGemini = createStorage({ configVersion: 1, responseProvider: 'gemini' }, 'saved-key');
    assert.equal(explicitGemini.storage.getConfig().responseProvider, 'gemini');
    assert.equal(explicitGemini.readSaved().responseProvider, 'gemini');
});
