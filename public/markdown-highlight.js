// Syntax highlighting helper for fenced code blocks rendered by marked.
// Works in browser and Node so the same module powers the dashboard UI
// and the test suite (issue #10).
//
// Design notes:
//   * We never call Prism.highlightElement or Prism.highlightAll. Those
//     walk the DOM and trust existing HTML, which would re-introduce an
//     XSS surface. Prism.highlight(string, grammar, language) only ever
//     reads a raw string, so user input cannot escape the tokenizer.
//   * Unknown / missing languages fall through to HTML-escaped plaintext
//     with no language-* class, matching what marked emits for plain
//     fences. No silent guessing.
//   * Oversize blocks (>100k chars) bypass Prism so a pasted log dump
//     cannot stall the render loop.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MarkdownHighlight = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_MAX_CHARS = 100000;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function resolvePrism(opts) {
    if (opts && opts.prism) return opts.prism;
    if (typeof Prism !== 'undefined') return Prism;
    return null;
  }

  function resolveGrammar(prism, lang) {
    if (!prism || !prism.languages || !lang) return null;
    const key = String(lang).toLowerCase();
    return prism.languages[key] || null;
  }

  // Returns { html, language } where:
  //   * html is always safe to drop into innerHTML (HTML-escaped on every
  //     branch),
  //   * language is the resolved Prism language key (lowercased) on a hit,
  //     and null otherwise.
  function highlightCode(code, lang, opts) {
    const options = opts || {};
    const maxChars = typeof options.maxChars === 'number'
      ? options.maxChars
      : DEFAULT_MAX_CHARS;
    const src = code == null ? '' : String(code);

    if (src.length > maxChars) {
      return { html: escapeHtml(src), language: null };
    }
    const prism = resolvePrism(options);
    const grammar = resolveGrammar(prism, lang);
    if (!grammar) {
      return { html: escapeHtml(src), language: null };
    }
    const key = String(lang).toLowerCase();
    try {
      const html = prism.highlight(src, grammar, key);
      return { html: html, language: key };
    } catch {
      return { html: escapeHtml(src), language: null };
    }
  }

  // Emits the full <pre><code>...</code></pre> block. Adds a
  // language-<lang> class only when highlighting actually happened, so
  // unknown fences render identically to a plain code block.
  function renderCodeBlock(code, lang, opts) {
    const result = highlightCode(code, lang, opts);
    const open = result.language
      ? '<pre><code class="language-' + escapeHtml(result.language) + '">'
      : '<pre><code>';
    return open + result.html + '</code></pre>\n';
  }

  // Registers a marked custom renderer that routes every fenced code
  // block through renderCodeBlock. Must be called after marked is loaded
  // but before any marked.parse calls. Safe to call once per page.
  function attachMarkedHighlighter(marked, opts) {
    if (!marked || typeof marked.use !== 'function') {
      throw new Error('[runway] attachMarkedHighlighter requires a marked instance');
    }
    marked.use({
      renderer: {
        code(token) {
          // marked v18 invokes code(token) with { text, lang, ... }.
          // Older shapes that pass (code, lang) still work because we
          // read positional args defensively.
          if (token && typeof token === 'object') {
            return renderCodeBlock(token.text, token.lang, opts);
          }
          return renderCodeBlock(arguments[0], arguments[1], opts);
        }
      }
    });
  }

  return {
    highlightCode,
    renderCodeBlock,
    attachMarkedHighlighter,
    escapeHtml,
  };
});
