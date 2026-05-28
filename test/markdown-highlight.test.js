// Coverage for the syntax-highlighting helper that backs renderMarkdown
// in the conversation view (issue #10). Asserts:
//   * known languages tokenize through Prism,
//   * unknown / missing languages fall through to escaped plaintext,
//   * oversize blocks bypass Prism so the renderer cannot stall,
//   * the highlighter never emits a raw <script> regardless of input,
//   * marked v18's renderer hook produces a language-* class on the
//     <code> element for known fences.

const test = require('node:test');
const assert = require('node:assert/strict');

const Prism = require('prismjs');
// Eager-load the same language set the browser does so the Node-side
// behavior matches what users see in the dashboard.
const PRISM_LANGS = [
  'markup', 'clike',
  'javascript', 'typescript', 'jsx', 'tsx',
  'css',
  'python', 'bash', 'shell-session', 'powershell',
  'json', 'yaml', 'markdown',
  'sql', 'go', 'rust', 'csharp', 'java', 'diff',
];
for (const lang of PRISM_LANGS) {
  require('prismjs/components/prism-' + lang);
}

const {
  highlightCode,
  renderCodeBlock,
  attachMarkedHighlighter,
  escapeHtml,
} = require('../public/markdown-highlight');

test('escapeHtml escapes the five HTML metacharacters', () => {
  assert.equal(
    escapeHtml(`<a href="x">&'</a>`),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'
  );
});

test('known language tokenizes through Prism', () => {
  const out = highlightCode('const a = 1;', 'javascript', { prism: Prism });
  assert.match(out.html, /<span class="token/);
  assert.equal(out.language, 'javascript');
});

test('language aliases resolve (js, ts, py, cs, html, md, yml)', () => {
  for (const [alias, code] of [
    ['js', 'const a = 1;'],
    ['ts', 'let a: number = 1;'],
    ['py', 'x = 1'],
    ['cs', 'int x = 1;'],
    ['html', '<p>hi</p>'],
    ['md', '# hi'],
    ['yml', 'a: 1'],
  ]) {
    const out = highlightCode(code, alias, { prism: Prism });
    assert.equal(out.language, alias, `alias ${alias} should resolve`);
    assert.match(out.html, /<span class="token/, `alias ${alias} should tokenize`);
  }
});

test('unknown language falls through to escaped plaintext', () => {
  const out = highlightCode('const a = 1;', 'klingon', { prism: Prism });
  assert.equal(out.language, null);
  assert.doesNotMatch(out.html, /<span class="token/);
  assert.doesNotMatch(out.html, /class="language-/);
});

test('missing language falls through to escaped plaintext', () => {
  for (const lang of ['', undefined, null]) {
    const out = highlightCode('const a = 1;', lang, { prism: Prism });
    assert.equal(out.language, null);
    assert.doesNotMatch(out.html, /<span class="token/);
  }
});

test('oversize input (>100k chars) bypasses Prism even for known languages', () => {
  const big = 'a'.repeat(100001);
  const out = highlightCode(big, 'javascript', { prism: Prism });
  assert.equal(out.language, null);
  assert.doesNotMatch(out.html, /<span class="token/);
  // Plaintext content is preserved verbatim (escaped, but identical
  // since the input has no HTML metacharacters).
  assert.equal(out.html, big);
});

test('maxChars boundary: exactly 100k chars still highlights', () => {
  const atLimit = 'a'.repeat(100000);
  const out = highlightCode(atLimit, 'javascript', { prism: Prism });
  // 100k chars of "a" is just an identifier to Prism; verify it did not
  // hit the bypass branch.
  assert.equal(out.language, 'javascript');
});

test('XSS payload never produces a raw script tag', () => {
  const payload = '</code><script>alert(1)</script>';
  for (const lang of ['javascript', 'klingon', '', undefined]) {
    const out = highlightCode(payload, lang, { prism: Prism });
    assert.ok(!out.html.includes('<script>'), `lang=${lang} leaked <script>`);
    assert.ok(!out.html.includes('</script>'), `lang=${lang} leaked </script>`);
    assert.ok(out.html.includes('&lt;'), `lang=${lang} did not escape <`);
  }
});

test('renderCodeBlock emits language-* class only for known fences', () => {
  const known = renderCodeBlock('const a = 1;', 'javascript', { prism: Prism });
  assert.match(known, /<pre><code class="language-javascript">/);
  assert.match(known, /<\/code><\/pre>/);

  const unknown = renderCodeBlock('whatever', 'klingon', { prism: Prism });
  assert.match(unknown, /^<pre><code>/);
  assert.doesNotMatch(unknown, /class="language-/);
});

test('attachMarkedHighlighter wires a fenced JS block through Prism', () => {
  // Use a fresh marked instance so the renderer override does not leak
  // across tests.
  const { Marked } = require('marked');
  const marked = new Marked({ breaks: true, gfm: true });
  attachMarkedHighlighter(marked, { prism: Prism });

  const html = marked.parse('```javascript\nconst a = 1;\n```');
  assert.match(html, /<pre><code class="language-javascript">/);
  assert.match(html, /<span class="token/);
});

test('attachMarkedHighlighter routes unknown fences to plaintext', () => {
  const { Marked } = require('marked');
  const marked = new Marked({ breaks: true, gfm: true });
  attachMarkedHighlighter(marked, { prism: Prism });

  const html = marked.parse('```klingon\nqapla\n```');
  assert.match(html, /<pre><code>qapla/);
  assert.doesNotMatch(html, /class="language-/);
});

test('attachMarkedHighlighter leaves prose, tables, and inline code untouched', () => {
  const { Marked } = require('marked');
  const marked = new Marked({ breaks: true, gfm: true });
  attachMarkedHighlighter(marked, { prism: Prism });

  const html = marked.parse([
    '# Heading',
    '',
    'Some `inline code` and a [link](https://example.test).',
    '',
    '| col |',
    '| --- |',
    '| val |',
    '',
  ].join('\n'));

  assert.match(html, /<h1[^>]*>Heading<\/h1>/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.test">link<\/a>/);
  assert.match(html, /<table>[\s\S]*<th>col<\/th>[\s\S]*<td>val<\/td>/);
});
