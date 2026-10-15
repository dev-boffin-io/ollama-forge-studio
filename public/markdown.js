'use strict';

/**
 * Tiny markdown → HTML renderer for chat messages (no dependencies).
 * Everything is HTML-escaped FIRST; only tags generated here ever reach the DOM, and links are limited to http(s)/mailto.
 * Supports: headings, **bold**, *italic*, ~~strike~~, `code`, fenced code (with syntax colours + Copy button), nested lists
 * (Bengali digits work as list numbers), blockquotes, tables, horizontal rules, links/autolinks.
 */
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- syntax highlighting (generic, good enough for most languages) ---------- */

  const KW = ('abstract as async await break case catch class const continue debugger def default defer del delete do elif else enum except export extends ' +
    'finally fn for from func function global go goto if impl implements import in instanceof interface is lambda let loop match mod module mut namespace new nonlocal ' +
    'of package pass private protected pub public raise return select self static struct super switch this throw trait try type typeof union unsafe use using var void ' +
    'while with yield select insert update create table where join group order by limit values into set alter drop index primary key foreign references echo fi then done esac ' +
    'int float double char bool boolean string long short byte str dict list tuple').split(/\s+/);
  const KW_RE = new RegExp('\\b(?:' + KW.join('|') + ')\\b', 'i');
  const HASH_COMMENT = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|ruby|rb|dockerfile|ps1|powershell|conf|ini|make|makefile|r|perl|pl|env|properties|text|txt|)$/;

  function highlight(code, lang) {
    lang = String(lang || '').toLowerCase();
    if (code.length > 30000) return esc(code);
    if (lang === 'diff' || lang === 'patch') {
      return code.split('\n').map((l) => {
        const cls = /^(\+\+\+|---)/.test(l) ? 'tk-meta' : l[0] === '+' ? 'tk-add' : l[0] === '-' ? 'tk-del' : /^@@/.test(l) ? 'tk-fn' : '';
        return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
      }).join('\n');
    }
    const isJson = lang === 'json' || lang === 'jsonc';
    const parts = [
      '(\\/\\*[\\s\\S]*?(?:\\*\\/|$)|<!--[\\s\\S]*?(?:-->|$)|\\/\\/[^\\n]*' + (HASH_COMMENT.test(lang) ? '|#[^\\n]*' : '') + (/^(sql|lua|hs)$/.test(lang) ? '|--[^\\n]*' : '') + ')', // 1 comment
      '("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)',                                                                    // 2 string
      '(\\b0x[0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',                                                                           // 3 number
      '(\\b(?:true|false|null|None|True|False|nil|undefined|NaN)\\b)',                                                                                   // 4 constant
      '(\\b[A-Za-z_$][\\w$]*(?=\\())',                                                                                                                  // 5 call
      '(\\b[A-Za-z_$][\\w$]*\\b)',                                                                                                                      // 6 word
    ];
    const re = new RegExp(parts.join('|'), 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      last = m.index + m[0].length;
      const t = m[0];
      let cls = '';
      if (m[1] !== undefined) cls = 'tk-c';
      else if (m[2] !== undefined) cls = isJson && /^\s*:/.test(code.slice(last, last + 3)) ? 'tk-p' : 'tk-s';
      else if (m[3] !== undefined) cls = 'tk-n';
      else if (m[4] !== undefined) cls = 'tk-n';
      else if (m[5] !== undefined) cls = /^(if|for|while|switch|catch|match|return|elif|function|def|fn|with|select)$/i.test(t) ? 'tk-k' : 'tk-fn';
      else if (m[6] !== undefined) cls = !isJson && KW_RE.test(t) ? 'tk-k' : '';
      out += cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t);
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return out + esc(code.slice(last));
  }

  function codeHtml({ lang, code }) {
    const label = esc(lang || 'code');
    return `<div class="code"><div class="code-head"><span>${label}</span><button type="button" class="copy-btn">Copy</button></div>` +
      `<pre><code>${highlight(code, lang)}</code></pre></div>`;
  }

  /* ---------- inline ---------- */

  function inline(src) {
    const codes = [];
    let t = esc(src);
    t = t.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001`; });
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?'"])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    t = t.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^\w])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\w])/g, '$1<em>$2</em>');
    t = t.replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, '<del>$1</del>');
    return t.replace(/\u0001(\d+)\u0001/g, (m, i) => `<code>${codes[+i]}</code>`);
  }

  /* ---------- blocks ---------- */

  const LIST_RE = /^(\s*)([-*+•]|[0-9০-৯]+[.)])\s+(.*)$/;
  const PLACEHOLDER_RE = /^\s*\u0000B(\d+)\u0000\s*$/;
  const bnDigits = (s) => s.replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d));
  const isTableSep = (s) => /-/.test(s) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s);
  const splitRow = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const startsBlock = (l, next) => /^#{1,6}\s/.test(l) || LIST_RE.test(l) || /^\s*>/.test(l) || PLACEHOLDER_RE.test(l) ||
    /^\s*([-*_])\1{2,}\s*$/.test(l) || (l.includes('|') && next !== undefined && isTableSep(next));

  function listHtml(items) {
    let i = 0;
    const build = (indent) => {
      const first = items[i];
      const startNum = first.ordered ? parseInt(bnDigits(first.marker), 10) : 1;
      let h = first.ordered ? `<ol${startNum > 1 ? ` start="${startNum}"` : ''}>` : '<ul>';
      while (i < items.length && items[i].indent === indent) {
        const it = items[i++];
        let li = inline(it.text) + it.extra;
        if (i < items.length && items[i].indent > indent) li += build(items[i].indent);
        h += `<li>${li}</li>`;
      }
      return h + (first.ordered ? '</ol>' : '</ul>');
    };
    let html = '';
    while (i < items.length) {
      // an item that is LESS indented than the one before it (after a nested run) restarts at its own level
      html += build(items[i].indent);
    }
    return html;
  }

  function blocks(text, store) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(PLACEHOLDER_RE))) { out.push(codeHtml(store[+m[1]])); i++; continue; }
      if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { const n = Math.min(m[1].length + 1, 6); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${blocks(q.join('\n'), store)}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push('<div class="tbl"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (LIST_RE.test(line)) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          const lm = l.match(LIST_RE);
          if (lm) {
            const ind = lm[1].replace(/\t/g, '    ').length >> 1 << 1;
            const ordered = /^[0-9০-৯]/.test(lm[2]);
            if (items.length && ind <= items[0].indent && ordered !== items[0].ordered) break; // bullets → numbers starts a new list
            items.push({ indent: ind, marker: lm[2], ordered, text: lm[3], extra: '' });
            i++;
          } else if (PLACEHOLDER_RE.test(l) && items.length) { items[items.length - 1].extra += codeHtml(store[+l.match(PLACEHOLDER_RE)[1]]); i++; }
          else if (!l.trim()) { // a single blank line between items keeps the list going
            let k = i + 1;
            while (k < lines.length && !lines[k].trim()) k++;
            const nx = k < lines.length && lines[k].match(LIST_RE);
            if (nx && (/^[0-9০-৯]/.test(nx[2]) === items[0].ordered || nx[1].length > 0)) i = k; else break;
          } else if (/^\s{2,}\S/.test(l) && items.length && !startsBlock(l)) { items[items.length - 1].text += '\n' + l.trim(); i++; }
          else break;
        }
        // normalise indents to levels so "  " and "    " nesting both work
        const levels = [...new Set(items.map((x) => x.indent))].sort((a, b) => a - b);
        items.forEach((x) => { x.indent = levels.indexOf(x.indent); });
        items.forEach((x) => { x.text = x.text.replace(/\n/g, ' '); });
        out.push(listHtml(items));
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  function renderMarkdown(src) {
    const store = [];
    // fenced code first (an unterminated fence — still streaming — is rendered as an open block)
    const text = String(src).replace(/(^|\n)[ \t]*(```|~~~)([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, (m, pre, fence, lang, code) => {
      store.push({ lang, code });
      return `${pre}\u0000B${store.length - 1}\u0000`;
    });
    return blocks(text, store);
  }

  /** Markdown source → readable plain text (for "Copy text"). */
  function markdownToText(src) {
    return String(src)
      .replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n([\s\S]*?)(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, (m, pre, f, code) => `${pre}${code}`)
      .replace(/^#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
      .replace(/!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, t, u) => (t && t !== u ? `${t} (${u})` : u))
      .replace(/\*\*(.+?)\*\*|__(.+?)__/gs, (m, a, b) => a || b).replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/^\s*[-*+]\s+/gm, '• ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function copyToClipboard(text) {
    return new Promise((resolve, reject) => {
      if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(resolve, reject); return; }
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  window.renderMarkdown = renderMarkdown;
  window.markdownToText = markdownToText;
  window.copyToClipboard = copyToClipboard;

  /* Copy buttons on code blocks (one delegated handler for the whole chat) */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.copy-btn');
    if (!btn) return;
    const text = btn.closest('.code').querySelector('code').textContent;
    copyToClipboard(text).then(() => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); }, () => {});
  });
})();
