const FOCUS_REPORT_LENGTH = 3;
const X10_REPORT_LENGTH = 6;

function sgrMouseReportLength(rest: string): number {
  if (!rest.startsWith('\x1b[<')) return 0;

  let offset = 3;
  for (let field = 0; field < 3; field += 1) {
    const digitStart = offset;
    while (offset < rest.length && rest.charCodeAt(offset) >= 48 && rest.charCodeAt(offset) <= 57) {
      offset += 1;
    }
    if (offset === digitStart) return 0;

    if (field < 2) {
      if (rest[offset] !== ';') return 0;
      offset += 1;
    }
  }

  return rest[offset] === 'M' || rest[offset] === 'm' ? offset + 1 : 0;
}

function terminalReportLengthAt(data: string, offset: number): number {
  const rest = data.slice(offset);
  if (rest.startsWith('\x1b[I') || rest.startsWith('\x1b[O')) return FOCUS_REPORT_LENGTH;

  const sgrLength = sgrMouseReportLength(rest);
  if (sgrLength > 0) return sgrLength;

  if (rest.startsWith('\x1b[M') && rest.length >= X10_REPORT_LENGTH) return X10_REPORT_LENGTH;
  return 0;
}

/**
 * Whether terminal input contains any keyboard-bearing bytes.
 *
 * Returns false only when every byte is consumed as an allowlisted mouse or
 * focus report. Unknown, malformed, mixed, and empty input fails closed.
 */
export function isKeyboardTerminalInput(data: string): boolean {
  if (data.length === 0) return true;

  let offset = 0;
  while (offset < data.length) {
    const reportLength = terminalReportLengthAt(data, offset);
    if (reportLength === 0) return true;
    offset += reportLength;
  }
  return false;
}
