const FOCUS_REPORT_LENGTH = 3;
const X10_REPORT_LENGTH = 6;
const SGR_MOUSE_REPORT = /^\x1b\[<\d+;\d+;\d+[Mm]/;

function terminalReportLengthAt(data: string, offset: number): number {
  const rest = data.slice(offset);
  if (rest.startsWith('\x1b[I') || rest.startsWith('\x1b[O')) return FOCUS_REPORT_LENGTH;

  const sgr = SGR_MOUSE_REPORT.exec(rest);
  if (sgr) return sgr[0].length;

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
