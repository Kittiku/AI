import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseBlocks, parseInline } from '../src/markdown.js';
import { getJobStatusBadge, statusLabels } from '../src/jobBadge.js';

const html = text => renderToStaticMarkup(React.createElement(Markdown, { text }));

test('markdown renders bold and inline code without raw markers', () => {
  const out = html('**a** and `b`');
  assert.match(out, /<strong>a<\/strong>/);
  assert.match(out, /<code>b<\/code>/);
  assert.ok(!out.includes('**'));
});

test('markdown renders "-" lists', () => {
  assert.deepEqual(parseBlocks('intro\n- one\n- **two**'), [
    { type: 'p', text: 'intro' }, { type: 'ul', items: ['one', '**two**'] }]);
  assert.match(html('- one\n- two'), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test('markdown always escapes HTML', () => {
  const out = html('<script>alert(1)</script> **<b>x</b>**');
  assert.ok(!out.includes('<script>'));
  assert.ok(!out.includes('<b>'));
  assert.match(out, /&lt;script&gt;/);
  assert.deepEqual(parseInline('`<i>`'), [{ type: 'code', text: '<i>' }]);
});

test('status badge shows one label for every status', () => {
  for (const status of Object.keys(statusLabels)) {
    if (status === 'waiting_approval') continue;
    assert.equal(getJobStatusBadge({ status }).label, statusLabels[status]);
  }
  assert.equal(getJobStatusBadge({ status: 'waiting_approval', approval: { kind: 'plan' } }).label, 'รออนุมัติ');
  assert.equal(getJobStatusBadge({ status: 'waiting_approval', approval: { kind: 'before_merge' } }).label, 'รออนุมัติ merge');
  assert.equal(getJobStatusBadge({ status: 'unknown' }).label, 'unknown');
});

test('a merged job gets a single merged badge', () => {
  assert.deepEqual(getJobStatusBadge({ status: 'complete', merged: { into: 'main' } }), { status: 'merged', label: 'merge แล้ว' });
  assert.match(getJobStatusBadge({ status: 'needs_review', merged: {} }).label, /merge แล้ว/);
  assert.equal(getJobStatusBadge({ status: 'failed', merged: {} }).label, statusLabels.failed);
});
