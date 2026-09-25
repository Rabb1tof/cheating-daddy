const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createStorage(savedPreferences = {}) {
    const files = new Map();
    const directories = new Set();
    const winPath = path.win32;
    const home = 'F:\\storage-response-preferences-test';
    const preferencesPath = winPath.join(home, 'AppData', 'Roaming', 'cheating-daddy-config', 'preferences.json');
    files.set(preferencesPath, JSON.stringify(savedPreferences));

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
    return { storage: module.exports, readSaved: () => JSON.parse(files.get(preferencesPath)) };
}

test('new response preferences have defaults for an existing profile', () => {
    const { storage } = createStorage({ selectedLanguage: 'ru-RU' });
    const preferences = storage.getPreferences();
    assert.equal(preferences.interruptOnNewRequest, false);
    assert.equal(preferences.rememberRecentAnswers, true);
    assert.equal(preferences.selectedLanguage, 'ru-RU');
});

test('response checkboxes persist without changing other preferences', () => {
    const { storage, readSaved } = createStorage({ selectedLanguage: 'ru-RU' });
    assert.equal(storage.updatePreference('interruptOnNewRequest', true), true);
    assert.equal(storage.updatePreference('rememberRecentAnswers', false), true);
    assert.equal(storage.getPreferences().interruptOnNewRequest, true);
    assert.equal(storage.getPreferences().rememberRecentAnswers, false);
    assert.equal(readSaved().selectedLanguage, 'ru-RU');
});
