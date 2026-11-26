import React from 'react';

// Tiny markdown renderer for AI text: **bold**, `code` and "- " lists.
// It builds React elements only, so every string is escaped by React. No HTML is ever injected.

export function parseInline(text) {
  const tokens = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;
  let last = 0, match;
  const source = String(text ?? '');
  while ((match = pattern.exec(source))) {
    if (match.index > last) tokens.push({ type: 'text', text: source.slice(last, match.index) });
    tokens.push(match[1] !== undefined ? { type: 'code', text: match[1] } : { type: 'bold', text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < source.length) tokens.push({ type: 'text', text: source.slice(last) });
  return tokens;
}

export function parseBlocks(text) {
  const blocks = [];
  let paragraph = [], list = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join('\n') });
    if (list) blocks.push({ type: 'ul', items: list });
    paragraph = []; list = null;
  };
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (paragraph.length) { blocks.push({ type: 'p', text: paragraph.join('\n') }); paragraph = []; }
      (list ??= []).push(item[1]);
    } else if (!line.trim()) flush();
    else {
      if (list) { blocks.push({ type: 'ul', items: list }); list = null; }
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

export function InlineMarkdown({ text }) {
  return React.createElement(React.Fragment, null, parseInline(text).map((token, index) =>
    token.type === 'bold' ? React.createElement('strong', { key: index }, token.text) :
    token.type === 'code' ? React.createElement('code', { key: index }, token.text) :
    React.createElement(React.Fragment, { key: index }, token.text)));
}

export function Markdown({ text, className = '' }) {
  const blocks = parseBlocks(text);
  return React.createElement('div', { className: 'markdown ' + className }, blocks.map((block, index) =>
    block.type === 'ul' ?
      React.createElement('ul', { key: index }, block.items.map((item, i) =>
        React.createElement('li', { key: i }, React.createElement(InlineMarkdown, { text: item })))) :
      React.createElement('p', { key: index }, React.createElement(InlineMarkdown, { text: block.text }))));
}
