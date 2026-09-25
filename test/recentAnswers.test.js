const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecentAnswerContext } = require('../src/utils/recentAnswers');

test('recent answer context merges text and screenshots, keeps latest three, and stays within a UTF-8 budget', () => {
    const voice = [
        { timestamp: 1, transcription: 'old question', ai_response: 'old answer' },
        { timestamp: 3, transcription: 'new question', ai_response: 'русский ответ '.repeat(100) },
        { timestamp: 4, transcription: 'latest question', ai_response: 'latest answer' },
    ];
    const screenshots = [{ timestamp: 2, prompt: 'screenshot question', response: 'screenshot answer' }];
    const context = buildRecentAnswerContext(voice, screenshots, 700);
    assert.ok(!context.includes('old question'));
    assert.ok(context.indexOf('screenshot question') < context.indexOf('new question'));
    assert.ok(context.indexOf('new question') < context.indexOf('latest question'));
    assert.ok(Buffer.byteLength(context, 'utf8') <= 700);
    assert.ok(!context.includes('�'));
});

test('recent answer context excludes unfinished turns and can be disabled with an empty session', () => {
    assert.equal(buildRecentAnswerContext([{ transcription: 'question', ai_response: '' }]), '');
    assert.equal(buildRecentAnswerContext([], []), '');
});
