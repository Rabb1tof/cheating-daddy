const test = require('node:test');
const assert = require('node:assert/strict');
const { getSystemPrompt, getCompactSystemPrompt, getScreenshotSystemPrompt } = require('../src/utils/prompts');

test('concise remains the default for full and compact prompts', () => {
    const context = 'Resume: backend engineer. Vacancy: API platform.';
    const full = getSystemPrompt('interview', context, false, 'ru-RU');
    const compact = getCompactSystemPrompt('interview', context, 'ru-RU');

    assert.equal(full, getSystemPrompt('interview', context, false, 'ru-RU', 'concise'));
    assert.equal(compact, getCompactSystemPrompt('interview', context, 'ru-RU', 'concise'));
    assert.match(full, /1-3 sentences max/);
    assert.match(compact, /1-3 sentences max/);
    assert.match(full, /Resume: backend engineer\. Vacancy: API platform\./);
    assert.match(full, /Russian \(ru-RU\)/);
    assert.doesNotMatch(full, /SEARCH TOOL USAGE/);
});

test('detailed interview prompt uses resume and vacancy without invented credentials or terse constraints', () => {
    const context = 'Resume: built payment APIs in Go. Vacancy: backend engineer for payment services.';
    const prompt = getSystemPrompt('interview', context, false, 'en-US', 'detailed');

    assert.match(prompt, /4-6 meaningful sentences/);
    assert.match(prompt, /simple question may need only a brief answer/);
    assert.match(prompt, /real achievements.*resume.*requirements.*vacancy/);
    assert.match(prompt, /Never invent employers, years of experience, achievements, numbers/);
    assert.match(prompt, /Resume: built payment APIs in Go\. Vacancy: backend engineer for payment services\./);
    assert.doesNotMatch(prompt, /SHORT and CONCISE|1-3 sentences max|short and impactful/i);
    assert.doesNotMatch(prompt, /software engineer with 5 years/);
});

test('detailed search guidance remains conditional and response language is validated', () => {
    const withSearch = getSystemPrompt('interview', '', true, 'ru-RU', 'detailed');
    const withoutSearch = getSystemPrompt('interview', '', false, 'ru-RU', 'detailed');
    const invalidLanguage = getSystemPrompt('interview', '', false, 'ru', 'detailed');

    assert.match(withSearch, /SEARCH TOOL USAGE/);
    assert.doesNotMatch(withoutSearch, /SEARCH TOOL USAGE/);
    assert.match(withoutSearch, /Russian \(ru-RU\)/);
    assert.match(invalidLanguage, /English \(en-US\)/);
});

test('detailed compact prompt includes up to 4000 context characters and signals truncation', () => {
    const context = `${'R'.repeat(4000)}TAIL-ONLY-AFTER-LIMIT`;
    const prompt = getCompactSystemPrompt('interview', context, 'de-DE', 'detailed');

    assert.match(prompt, /4-6 meaningful sentences/);
    assert.match(prompt, /User context:\nR{4000}\n\[User context truncated after 4000 characters/);
    assert.doesNotMatch(prompt, /TAIL-ONLY-AFTER-LIMIT/);
    assert.match(prompt, /German \(de-DE\)/);
    assert.doesNotMatch(prompt, /SHORT and CONCISE|1-3 sentences max|short and impactful/i);
    assert.doesNotMatch(getCompactSystemPrompt('interview', 'Short context', 'en-US', 'detailed'), /truncated/);
});

test('compact concise context budget stays at 1800 characters', () => {
    const prompt = getCompactSystemPrompt('interview', `${'C'.repeat(1800)}TAIL`, 'en-US');

    assert.match(prompt, /User context:\nC{1800}/);
    assert.doesNotMatch(prompt, /TAIL|truncated/);
});

test('compact detailed context also respects a UTF-8 byte budget', () => {
    const prompt = getCompactSystemPrompt('interview', '職'.repeat(4000), 'ja-JP', 'detailed');
    const context = prompt.match(/User context:\n([\s\S]*?)\n\[User context truncated/)[1];
    assert.ok(Buffer.byteLength(context, 'utf8') <= 6000);
    assert.match(prompt, /Japanese \(ja-JP\)/);
});

test('detailed mode for exam drops minimum-explanation instructions', () => {
    const prompt = getSystemPrompt('exam', '', false, 'en-US', 'detailed');

    assert.match(prompt, /explain the reasoning/);
    assert.doesNotMatch(prompt, /minimal explanation|1-2 sentences max|brief justification/);
});

test('screenshot prompt follows code and multiple-choice requests without spoken-answer constraints', () => {
    const context = 'Resume: built payment APIs. Vacancy: backend engineer.';
    const prompt = getScreenshotSystemPrompt('interview', context, 'ru-RU', 'detailed');

    assert.match(prompt, /complete requested code without placeholders/);
    assert.match(prompt, /identify the correct option and reproduce its label and text exactly as displayed/);
    assert.match(prompt, /factual resume achievements and vacancy requirements/);
    assert.match(prompt, /Resume: built payment APIs\. Vacancy: backend engineer\./);
    assert.match(prompt, /Russian \(ru-RU\)/);
    assert.doesNotMatch(prompt, /words the user can say|1-3 sentences max|4-6 meaningful sentences/);
});

test('screenshot context limits depend on style and report truncation', () => {
    const context = `${'A'.repeat(4000)}TAIL`;
    const concise = getScreenshotSystemPrompt('interview', context, 'en-US');
    const detailed = getScreenshotSystemPrompt('interview', context, 'en-US', 'detailed');

    assert.match(concise, /User-provided context:\nA{1800}\n\[Context truncated/);
    assert.match(detailed, /User-provided context:\nA{4000}\n\[Context truncated/);
    assert.doesNotMatch(concise, /TAIL/);
    assert.doesNotMatch(detailed, /TAIL/);
});

test('screenshot byte cap preserves Unicode boundaries', () => {
    const prompt = getScreenshotSystemPrompt('interview', 'A💻B', 'en-US', 'detailed', 5);

    assert.match(prompt, /User-provided context:\nA💻\n\[Context truncated/);
    assert.doesNotMatch(prompt, /A💻B|�/);
    assert.match(getScreenshotSystemPrompt('interview', 'A', 'en-US', 'detailed', 0), /context was omitted to fit the request budget/);
});
