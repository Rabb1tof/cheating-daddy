const test = require('node:test');
const assert = require('node:assert/strict');
const { packagerConfig } = require('../forge.config');

test('ad hoc macOS signing keeps hardened runtime disabled for the app and nested code', () => {
    const signing = packagerConfig.osxSign;
    assert.equal(signing.identity, '-');
    assert.equal(signing.continueOnError, false);

    const app = '/Applications/Cheating Daddy.app';
    const bundledCode = [
        app,
        `${app}/Contents/MacOS/Cheating Daddy`,
        `${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
        `${app}/Contents/Frameworks/Cheating Daddy Helper.app`,
        `${app}/Contents/Frameworks/Cheating Daddy Helper (Renderer).app`,
        `${app}/Contents/Frameworks/Cheating Daddy Helper (GPU).app`,
        `${app}/Contents/Frameworks/Cheating Daddy Helper (Plugin).app`,
        `${app}/Contents/Resources/SystemAudioDump`,
    ];

    for (const file of bundledCode) {
        const options = signing.optionsForFile(file);
        // osx-sign enables hardened runtime by default; ad hoc signatures have no Team ID for library validation.
        assert.equal(options.hardenedRuntime, false, file);
        assert.equal(options.timestamp, 'none', file);
        const signatureFlags = Array.isArray(options.signatureFlags) ? options.signatureFlags : (options.signatureFlags || '').split(',');
        assert.equal(
            signatureFlags.some(flag => ['runtime', 'library'].includes(flag.trim())),
            false,
            file
        );
    }
});
