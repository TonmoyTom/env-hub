'use strict';

// Shows a Markdown file (PLANNING.md, HANDOVER.md) in a small read-only window.
// The page has no preload, no scripts and no network: it is plain text turned into HTML here.

const fs = require('fs');
const { BrowserWindow, shell } = require('electron');

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// **bold**, `code` and [text](https://link) inside one line. Everything is escaped first.
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

// A small Markdown to HTML: headings, bullet and numbered lists, code blocks, tables, paragraphs.
function markdownToHtml(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let code = false;
  let table = [];

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const closeTable = () => {
    if (table.length === 0) return;
    const rows = table.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r));
    out.push('<table>');
    rows.forEach((row, i) => {
      const cells = row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const tag = i === 0 ? 'th' : 'td';
      out.push(`<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
    });
    out.push('</table>');
    table = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList();
      closeTable();
      out.push(code ? '</pre>' : '<pre>');
      code = !code;
    } else if (code) {
      out.push(escapeHtml(line));
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      table.push(line);
    } else {
      closeTable();
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      } else if (bullet || number) {
        const kind = bullet ? 'ul' : 'ol';
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        out.push(`<li>${inline((bullet || number)[1])}</li>`);
      } else if (line.trim() === '') {
        closeList();
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
  }
  closeList();
  closeTable();
  if (code) out.push('</pre>');
  return out.join('\n');
}

function pageHtml(title, markdown) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.6 system-ui, Segoe UI, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px 28px 60px; background: Canvas; color: CanvasText; }
h1, h2, h3 { line-height: 1.25; margin: 1.6em 0 0.5em; }
h1 { font-size: 1.7rem; margin-top: 0; }
h2 { font-size: 1.25rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding-bottom: 4px; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; background: color-mix(in srgb, CanvasText 10%, transparent); padding: 1px 5px; border-radius: 4px; }
pre { background: color-mix(in srgb, CanvasText 8%, transparent); padding: 12px 14px; border-radius: 8px; overflow: auto; font-family: ui-monospace, Consolas, monospace; font-size: 0.85rem; }
table { border-collapse: collapse; margin: 12px 0; width: 100%; font-size: 0.92rem; }
th, td { border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: color-mix(in srgb, CanvasText 8%, transparent); }
li { margin: 3px 0; }
a { color: LinkText; }
</style></head><body>${markdownToHtml(markdown)}</body></html>`;
}

// Opens the window. Returns it, or null when the file cannot be read.
function openDocWindow(parent, title, file) {
  let markdown;
  try {
    markdown = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
  const win = new BrowserWindow({
    parent,
    width: 920,
    height: 760,
    title,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  win.setMenuBarVisibility(false);
  // Links open in the browser. The window itself never leaves its page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(title, markdown))}`);
  return win;
}

module.exports = { markdownToHtml, openDocWindow, escapeHtml };
