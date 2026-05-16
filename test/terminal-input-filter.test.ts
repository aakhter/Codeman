import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type TerminalInputFilter = {
  isTerminalQueryResponse: (data: string) => boolean;
  shouldSuppressTerminalQueryResponse: (data: string) => boolean;
};

function loadFilter(): TerminalInputFilter {
  const file = resolve(import.meta.dirname, '../src/web/public/terminal-ui.js');
  const code = readFileSync(file, 'utf8');
  const context = vm.createContext({ window: {}, CodemanApp: { prototype: {} } });
  vm.runInContext(code, context, { filename: file });
  return (context.window as { CodemanTerminalInput: TerminalInputFilter }).CodemanTerminalInput;
}

describe('terminal input filter', () => {
  const filter = loadFilter();

  it('suppresses automatic terminal query replies for every mode', () => {
    expect(filter.shouldSuppressTerminalQueryResponse('\x1b[?1;2c')).toBe(true);
    expect(filter.shouldSuppressTerminalQueryResponse('\x1b[>0;276;0c')).toBe(true);
    expect(filter.shouldSuppressTerminalQueryResponse('\x1b[12;40R')).toBe(true);
  });

  it('does not suppress normal user input', () => {
    expect(filter.shouldSuppressTerminalQueryResponse('hello')).toBe(false);
    expect(filter.shouldSuppressTerminalQueryResponse('\r')).toBe(false);
  });
});
