import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatsappParts, validAnswerPart } from './whatsapp-format.mjs';
const table = '| Pacific | Dubai | Availability |\n| --- | --- | --- |\n| 8:30–9 AM | 7:30–8 PM | Tentative holds |';
test('ordinary and fenced tables become labelled rows while retaining surrounding prose', () => {
  for (const content of [table, '```\n' + table + '\n```', '~~~text\n' + table + '\n~~~']) {
    const parts = whatsappParts('Here are your options:\n\n' + content + '\n\nNothing booked.');
    assert.deepEqual(parts, [
      'Here are your options:\n\n**Pacific: 8:30–9 AM**\n- Dubai: 7:30–8 PM\n- Availability: Tentative holds\n\nNothing booked.',
    ]);
  }
});
test('fenced bordered ASCII tables convert but ordinary code, malformed and ambiguous tables remain untouched', () => {
  const ascii =
    '```text\n+-------+-------+\n| Name  | Value |\n+-------+-------+\n| Brain | Ready |\n+-------+-------+\n```';
  assert.match(whatsappParts(ascii)[0], /\*\*Name: Brain\*\*\n- Value: Ready/);
  for (const text of [
    '```js\n' + table + '\n```',
    '```\nconsole.log("a|b");\n```',
    '| A | B |\n| --- | --- |\n| one | two | three |',
    '```\n' + table,
  ])
    assert.deepEqual(whatsappParts(text), [text]);
});
test('cell pipes, inline code, empty values and Unicode remain readable', () => {
  const text = '| Name | Notes |\n| --- | --- |\n| Café | a\\|b and `x|y` |\n| Other | |';
  const parts = whatsappParts(text);
  assert.match(parts[0], /Café/);
  assert.match(parts[0], /a\|b and `x\|y`/);
  assert.match(parts[0], /Notes: —/);
});
test('large tables export every row as CSV with safe quoting and spreadsheet formula neutralization', () => {
  const rows = ['=SUM(1,2)', 'say "hello"', ...Array.from({ length: 7 }, (_, i) => 'row ' + i)];
  const parts = whatsappParts('| Name | Value |\n| --- | --- |\n' + rows.map((r) => `| ${r} | ${r} |`).join('\n'));
  assert.match(parts[0], /9 rows/);
  const csv = parts.find((p) => typeof p !== 'string');
  assert.equal(csv.name, 'brain-table-1.csv');
  assert.match(csv.data, /"'=SUM\(1,2\)"/);
  assert.match(csv.data, /"say ""hello"""/);
  assert.equal(csv.data.split('\r\n').filter(Boolean).length, 10);
  assert.ok(parts.every(validAnswerPart));
});
test('rows stay intact at chunk boundaries, oversized cells export and numbering covers multiple tables', () => {
  const rows = Array.from({ length: 8 }, (_, i) => `| row ${i} | ${'😀'.repeat(150)} |`);
  const t = '| Name | Value |\n| --- | --- |\n' + rows.join('\n');
  const parts = whatsappParts('intro\n' + 'x'.repeat(3300) + '\n' + t);
  for (let i = 0; i < 8; i++)
    assert.ok(
      parts.some((p) => typeof p === 'string' && p.includes(`**Name: row ${i}**\n- Value: ` + '😀'.repeat(150)))
    );
  assert.ok(parts.every(validAnswerPart));
  const huge = '| Name | Value |\n| --- | --- |\n| Big | ' + 'x'.repeat(4000) + ' |';
  assert.equal(whatsappParts(huge).find((p) => typeof p !== 'string').name, 'brain-table-1.csv');
  assert.equal(whatsappParts(table + '\n\n' + huge).find((p) => typeof p !== 'string').name, 'brain-table-2.csv');
});
test('saved export descriptors reject paths, unsupported objects and oversize data', () => {
  assert.equal(validAnswerPart({ kind: 'csv', name: '../../secret', data: 'x' }), false);
  assert.equal(validAnswerPart({ kind: 'csv', name: 'brain-table-1.csv', data: 'x'.repeat(2000001) }), false);
  assert.equal(validAnswerPart({ kind: 'image', name: 'brain-table-1.csv', data: 'x' }), false);
});
