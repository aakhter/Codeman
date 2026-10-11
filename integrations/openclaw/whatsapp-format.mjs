/** Deterministic presentation only; never change the native answer or run a model. */
const LIMIT = 3500;
export function validAnswerPart(part) {
  return typeof part === 'string'
    ? part.length <= LIMIT
    : part?.kind === 'csv' &&
        /^brain-table-[1-9][0-9]*\.csv$/.test(part.name ?? '') &&
        typeof part.data === 'string' &&
        part.data.length <= 2000000;
}
function cells(line) {
  const row = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // A pipe escaped in Markdown or inside inline code is a cell value.
  const result = [];
  let cell = '',
    code = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\' && row[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cell += c;
    } else if (c === '|' && !code) {
      result.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  result.push(cell.trim());
  return result;
}
function tableAt(lines, start) {
  if (!lines[start]?.includes('|')) return;
  const headers = cells(lines[start]);
  if (headers.length < 2 || headers.some((h) => !h)) return;
  const separator = cells(lines[start + 1] ?? '');
  if (separator.length !== headers.length || !separator.every((c) => /^:?-{3,}:?$/.test(c))) return;
  const rows = [];
  let end = start + 2;
  while (end < lines.length && lines[end].includes('|')) {
    const row = cells(lines[end]);
    if (row.length !== headers.length) return; // Ambiguous output remains untouched.
    rows.push(row);
    end++;
  }
  return rows.length ? { headers, rows, end } : undefined;
}
function asciiTable(lines) {
  const border = /^\s*\+(?:[-=]+\+){2,}\s*$/;
  if (!border.test(lines[0] ?? '') || !border.test(lines.at(-1) ?? '')) return;
  const rowLines = lines.filter((l) => !border.test(l));
  if (rowLines.length < 2 || rowLines.some((l) => !/^\s*\|.*\|\s*$/.test(l))) return;
  const [headers, ...rows] = rowLines.map(cells);
  if (headers.length < 2 || headers.some((h) => !h) || rows.some((r) => r.length !== headers.length)) return;
  return { headers, rows };
}
function split(text) {
  const parts = [];
  let chunk = '';
  for (const char of text) {
    if (chunk.length + char.length > LIMIT) {
      parts.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) parts.push(chunk);
  return parts;
}
const plain = (s) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
function rowBlock(headers, row, index) {
  const label = plain(row[0])
    .replace(/[\r\n]/g, ' ')
    .trim();
  return (
    `**${plain(headers[0])}: ${label || `Row ${index + 1}`}**\n` +
    headers
      .slice(1)
      .map((h, i) => `- ${plain(h)}: ${row[i + 1] || '—'}`)
      .join('\n')
  );
}
function csvCell(s) {
  let value = plain(s);
  // Prevent spreadsheet formula execution while retaining the original in Codeman.
  if (/^[\s]*[=+\-@]/.test(value)) value = "'" + value;
  return '"' + value.replace(/"/g, '""') + '"';
}
export function whatsappParts(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const units = [];
  let prose = [],
    tableNumber = 0;
  const flush = () => {
    if (prose.length) {
      units.push(prose.join('\n').replace(/^\n+|\n+$/g, ''));
      prose = [];
    }
  };
  const render = (table) => {
    flush();
    tableNumber++;
    const blocks = table.rows.map((r, i) => rowBlock(table.headers, r, i));
    const large = table.rows.length > 8 || blocks.some((b) => b.length > LIMIT) || blocks.join('\n\n').length > LIMIT;
    if (large) {
      units.push(`**Table ${tableNumber} · ${table.rows.length} rows**\nFull table attached as CSV.`);
      for (const b of blocks.slice(0, 2)) if (b.length <= LIMIT) units.push(b);
      units.push({
        kind: 'csv',
        name: `brain-table-${tableNumber}.csv`,
        data: [table.headers, ...table.rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n',
      });
    } else units.push(...blocks);
  };
  for (let i = 0; i < lines.length; ) {
    const fence = /^\s*(`{3,}|~{3,})([\w-]*)\s*$/.exec(lines[i]);
    if (fence) {
      let end = i + 1;
      const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (end < lines.length && !close.test(lines[end])) end++;
      const body = lines.slice(i + 1, end);
      const trimmed = [...body];
      while (trimmed[0] === '') trimmed.shift();
      while (trimmed.at(-1) === '') trimmed.pop();
      const table = ['', 'text', 'plaintext', 'markdown', 'md'].includes(fence[2].toLowerCase())
        ? (tableAt(trimmed, 0) ?? asciiTable(trimmed))
        : undefined;
      if (end < lines.length && table && (table.end === undefined || table.end === trimmed.length)) render(table);
      else prose.push(...lines.slice(i, Math.min(end + 1, lines.length)));
      i = Math.min(end + 1, lines.length);
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      render(table);
      i = table.end;
    } else prose.push(lines[i++]);
  }
  flush();
  const parts = [];
  let pending = '';
  for (const unit of units) {
    if (typeof unit !== 'string') {
      if (pending) parts.push(pending);
      pending = '';
      parts.push(unit);
      continue;
    }
    if (!unit.trim()) continue;
    for (const piece of split(unit)) {
      if (pending && pending.length + piece.length + 2 > LIMIT) {
        parts.push(pending);
        pending = '';
      }
      pending += (pending ? '\n\n' : '') + piece;
    }
  }
  if (pending) parts.push(pending);
  return parts.length ? parts : split(text);
}
