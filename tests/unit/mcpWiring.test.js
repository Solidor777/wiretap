// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
   buildMcpConfig,
   mcpConfigFileName,
   planMcpWiring,
   wireMcpConfig,
   isSafeConfigPath,
} from '../../server/mcpWiring.ts';

describe('buildMcpConfig', () => {
   it('registers the wiretap HTTP endpoint on the given port', () => {
      expect(JSON.parse(buildMcpConfig(31417))).toEqual({
         mcpServers: { wiretap: { type: 'http', url: 'http://127.0.0.1:31417/mcp' } },
      });
   });
});

describe('mcpConfigFileName', () => {
   it('derives the file name from the MCP port', () => {
      expect(mcpConfigFileName(31417)).toBe('mcp-31417.json');
   });
});

describe('planMcpWiring', () => {
   it.each(['claude', 'claude --model opus -c', '  claude\t-c  ', 'claude a--b', 'claude --model claude-opus-4.1'])(
      'wires the allowlisted command %j',
      (command) => {
         expect(planMcpWiring(command)).toEqual({ kind: 'wire' });
      },
   );

   it('wires every character class of the allowlist', () => {
      expect(planMcpWiring('claude aZ09._:=/@+,-')).toEqual({ kind: 'wire' });
   });

   it.each(['', 'node --version', 'claude-code', 'claude.exe', 'echo claude', 'claudex -c', '"claude" -c'])(
      'reports not-claude for %j',
      (command) => {
         expect(planMcpWiring(command)).toEqual({ kind: 'not-claude' });
      },
   );

   it.each([
      ['&', 'claude a&b'],
      ['|', 'claude a|b'],
      [';', 'claude a;b'],
      ['<', 'claude a<b'],
      ['>', 'claude a>b'],
      ['(', 'claude a(b'],
      [')', 'claude a)b'],
      ['^', 'claude a^b'],
      ['#', 'claude a#b'],
      ['trailing backslash', 'claude a\\'],
      ['backslash', 'claude C:\\x'],
      ['double quote', 'claude --append-system-prompt "hi"'],
      ['single quote', "claude --append-system-prompt 'hi'"],
      ['percent', 'claude %PATH%'],
      ['dollar', 'claude $HOME'],
      ['backtick', 'claude `id`'],
      ['unbalanced quote', 'claude "oops'],
      ['quoted metacharacter', 'claude --append-system-prompt "a & b"'],
      ['newline', 'claude\nrm x'],
      ['carriage return', 'claude\r\nrm x'],
      ['star', 'claude *'],
      ['question mark', 'claude ?'],
      ['tilde', 'claude ~'],
      ['bang', 'claude !x'],
      ['brace', 'claude {a,b}'],
      ['bracket', 'claude [a]'],
   ])('skips a claude command containing %s with an allowlist reason', (_label, command) => {
      const plan = planMcpWiring(command);
      expect(plan.kind).toBe('skip');
      expect(plan.reason).toMatch(/allowlist/);
   });

   it('skips a standalone -- argument with its own reason', () => {
      expect(planMcpWiring('claude -- prompt')).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/--/) });
      expect(planMcpWiring('claude --model x --')).toMatchObject({ kind: 'skip' });
   });

   it('skips a command that already passes --mcp-config in either form', () => {
      expect(planMcpWiring('claude --mcp-config my.json')).toMatchObject({
         kind: 'skip',
         reason: expect.stringMatching(/--mcp-config/),
      });
      expect(planMcpWiring('claude --mcp-config=my.json')).toMatchObject({ kind: 'skip' });
   });
});

describe('wireMcpConfig', () => {
   // A Windows path containing real backslashes and a space.
   const cfg = String.raw`C:\Users\Some User\wiretap\.wiretap\mcp-31417.json`;

   it('appends a double-quoted --mcp-config to the bare claude command, keeping backslashes and spaces', () => {
      expect(wireMcpConfig('claude', cfg)).toBe(`claude --mcp-config "${cfg}"`);
      expect(wireMcpConfig('claude', cfg)).toContain('\\Some User\\');
   });

   it('appends after existing arguments and trims surrounding whitespace', () => {
      expect(wireMcpConfig('claude --model opus -c', cfg)).toBe(`claude --model opus -c --mcp-config "${cfg}"`);
      expect(wireMcpConfig('  claude\t-c  ', cfg)).toBe(`claude\t-c --mcp-config "${cfg}"`);
   });
});

describe('isSafeConfigPath', () => {
   it('accepts a path with spaces and backslashes', () => {
      expect(isSafeConfigPath(String.raw`C:\Some User\a.json`, 'win32')).toBe(true);
      expect(isSafeConfigPath('/tmp/some user/a.json', 'linux')).toBe(true);
   });

   it.each(['"', '%'])('rejects %s on every platform', (bad) => {
      expect(isSafeConfigPath(`a${bad}b`, 'linux')).toBe(false);
      expect(isSafeConfigPath(`a${bad}b`, 'win32')).toBe(false);
   });

   it.each(['$', '`', '\\'])('rejects %s on POSIX only', (bad) => {
      expect(isSafeConfigPath(`/tmp/a${bad}b`, 'linux')).toBe(false);
      expect(isSafeConfigPath(`C:\\a${bad}b`, 'win32')).toBe(true);
   });
});
