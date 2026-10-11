// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePtyOptions, DEFAULT_BACKEND } from '../../server/ptyOptions.ts';
import { resolveSpawn } from '../../server/spawnCommand.ts';
import { createTerminalManager } from '../../server/terminal.ts';
import { TERMINAL_LAUNCH } from '$shared/protocol.js';

describe('resolvePtyOptions', () => {
   it('returns no backend options off Windows', () => {
      expect(resolvePtyOptions('linux', {})).toEqual({});
      expect(resolvePtyOptions('darwin', { WIRETAP_PTY_BACKEND: 'winpty' })).toEqual({});
   });

   it('maps each WIRETAP_PTY_BACKEND value to the right options on Windows', () => {
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'conpty' })).toEqual({});
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'conpty-dll' })).toEqual({ useConptyDll: true });
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'winpty' })).toEqual({ useConpty: false });
   });

   it('falls back to the default backend on an unset or unknown value', () => {
      const expected = resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: DEFAULT_BACKEND });
      expect(resolvePtyOptions('win32', {})).toEqual(expected);
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'bogus' })).toEqual(expected);
      expect(resolvePtyOptions('win32', { WIRETAP_PTY_BACKEND: 'constructor' })).toEqual(expected);
   });
});

describe('resolveSpawn', () => {
   it('returns a verbatim command-line STRING on Windows (avoids node-pty arg re-escaping)', () => {
      expect(resolveSpawn('node -e "x"', 'win32', 'C:\\Windows\\System32\\cmd.exe'))
         .toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: '/c node -e "x"' });
   });

   it('defaults to cmd.exe when ComSpec is undefined', () => {
      expect(resolveSpawn('claude', 'win32', undefined)).toEqual({ file: 'cmd.exe', args: '/c claude' });
   });

   it('returns an argument ARRAY via /bin/sh on POSIX', () => {
      expect(resolveSpawn('node -e "x"', 'linux', undefined))
         .toEqual({ file: '/bin/sh', args: ['-c', 'node -e "x"'] });
   });
});

describe('terminal manager dispose', () => {
   it('kills the active PTY and is idempotent', () => {
      const child = {
         onData: vi.fn(),
         onExit: vi.fn(),
         write: vi.fn(),
         resize: vi.fn(),
         kill: vi.fn(),
      };
      const spawn = vi.fn(() => child);
      const io = { emit: vi.fn() };
      const handlers = {};
      const socket = {
         emit: vi.fn(),
         on: (event, fn) => {
            handlers[event] = fn;
         },
      };
      const manager = createTerminalManager(io, spawn);
      manager.handleConnection(socket);
      handlers[TERMINAL_LAUNCH]({ command: 'x', cols: 80, rows: 24 });
      expect(spawn).toHaveBeenCalledTimes(1);

      manager.dispose();
      expect(child.kill).toHaveBeenCalledTimes(1);
      // A second dispose is a safe no-op (the term is already cleared).
      manager.dispose();
      expect(child.kill).toHaveBeenCalledTimes(1);
   });
});

/** @type {string} The gitignored scratch root every real config write of these tests lands in. */
const SCRATCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'tmp', 'terminal');

describe('terminal manager MCP auto-wiring', () => {
   /** @type {string} The scratch root passed as `configRoot`; the real module directory is never reachable. */
   const root = SCRATCH_ROOT;
   /** @type {import('vitest').MockInstance} Silences and records console.error output. */
   let errorSpy;
   /** @type {import('vitest').MockInstance} Silences and records console.warn output. */
   let warnSpy;
   /** @type {PropertyDescriptor | undefined} The original process.platform descriptor, restored after each test. */
   let platformDescriptor;

   beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
   });

   afterEach(() => {
      Object.defineProperty(process, 'platform', platformDescriptor);
      vi.restoreAllMocks();
   });

   /**
    * Pretend the host platform is the given one for the duration of the test.
    * @param {string} platform - The platform name to report from process.platform.
    */
   function usePlatform(platform) {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
   }

   /**
    * Create a manager with a fake spawner and a connected fake socket.
    * @param {object} [options] - The manager options; `configRoot` defaults to the per-test scratch root.
    * @returns {{ spawn: Function, handlers: object, child: object, manager: object }} The spies and handlers.
    */
   function createManager(options) {
      const child = { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
      const spawn = vi.fn(() => child);
      const handlers = {};
      const socket = {
         emit: vi.fn(),
         on: (event, fn) => {
            handlers[event] = fn;
         },
      };
      const manager = createTerminalManager({ emit: vi.fn() }, spawn, { configRoot: root, ...options });
      manager.handleConnection(socket);
      return { spawn, handlers, child, manager };
   }

   /**
    * Launch a command through a manager with a fake spawner and return the spies.
    * @param {unknown} command - The launch command (undefined uses the default).
    * @param {object} [options] - The manager options.
    * @returns {{ spawn: Function, writeConfig: Function, commandLine: () => string }} The spies and a getter.
    */
   function launchWith(command, options) {
      const writeConfig = vi.fn(() => '/tmp/mcp-31417.json');
      const { spawn, handlers } = createManager({ writeConfig, ...options });
      handlers[TERMINAL_LAUNCH]({ command, cols: 80, rows: 24 });
      const commandLine = () => {
         const [, args] = spawn.mock.calls[0];
         return Array.isArray(args) ? args.join(' ') : args;
      };
      return { spawn, writeConfig, commandLine };
   }

   it('spawns the wired command as a verbatim string on win32', () => {
      usePlatform('win32');
      const cfg = String.raw`C:\Users\Some User\wiretap\.wiretap\mcp-31417.json`;
      const writeConfig = vi.fn(() => cfg);
      const { spawn } = launchWith('claude', { mcpPort: 31417, writeConfig });
      expect(writeConfig).toHaveBeenCalledWith(31417, root);
      expect(spawn.mock.calls[0][1]).toBe(`/c claude --mcp-config "${cfg}"`);
   });

   it('spawns the wired command as an sh -c argument array on POSIX', () => {
      usePlatform('linux');
      const cfg = '/tmp/some user/.wiretap/mcp-31417.json';
      const { spawn } = launchWith('claude', { mcpPort: 31417, writeConfig: vi.fn(() => cfg) });
      expect(spawn.mock.calls[0][0]).toBe('/bin/sh');
      expect(spawn.mock.calls[0][1]).toEqual(['-c', `claude --mcp-config "${cfg}"`]);
   });

   it('wires the default command (claude) when no command is given', () => {
      const { commandLine } = launchWith(undefined, { mcpPort: 31417 });
      expect(commandLine()).toContain('claude --mcp-config');
   });

   it('spawns other commands unchanged and writes no config', () => {
      const { writeConfig, commandLine } = launchWith('node --version', { mcpPort: 31417 });
      expect(writeConfig).not.toHaveBeenCalled();
      expect(commandLine()).not.toContain('--mcp-config');
   });

   it('does not wire when no MCP port is configured', () => {
      const { writeConfig, commandLine } = launchWith('claude', undefined);
      expect(writeConfig).not.toHaveBeenCalled();
      expect(commandLine()).not.toContain('--mcp-config');
   });

   it('wires `claude --model opus -c` and bare `claude`', () => {
      const withArgs = launchWith('claude --model opus -c', { mcpPort: 31417 });
      expect(withArgs.commandLine()).toContain('claude --model opus -c --mcp-config');
      const bare = launchWith('claude', { mcpPort: 31417 });
      expect(bare.commandLine()).toContain('claude --mcp-config');
   });

   it.each([
      ['a shell metacharacter', 'claude --model a & b', /allowlist/],
      ['a caret', 'claude a^b', /allowlist/],
      ['a hash', 'claude a#b', /allowlist/],
      ['a trailing backslash', 'claude a\\', /allowlist/],
      ['a double quote', 'claude --append-system-prompt "hi"', /allowlist/],
      ['a single quote', "claude --append-system-prompt 'hi'", /allowlist/],
      ['a percent sign', 'claude %PATH%', /allowlist/],
      ['a dollar sign', 'claude $HOME', /allowlist/],
      ['a backtick', 'claude `id`', /allowlist/],
      ['an unbalanced quote', 'claude "oops', /allowlist/],
      ['a newline', 'claude\nrm x', /allowlist/],
      ['a standalone --', 'claude -- prompt', /standalone --/],
      ['an existing --mcp-config', 'claude --mcp-config my.json', /--mcp-config/],
   ])('spawns a claude command containing %s unchanged and logs the skip', (_label, command, reason) => {
      const { writeConfig, commandLine } = launchWith(command, { mcpPort: 31417 });
      expect(writeConfig).not.toHaveBeenCalled();
      expect(commandLine()).not.toContain('--mcp-config "');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(reason));
   });

   it('spawns unchanged and logs when the config path cannot be quoted safely', () => {
      const { commandLine } = launchWith('claude', { mcpPort: 31417, writeConfig: () => '/tmp/50%/wiretap.json' });
      expect(commandLine()).not.toContain('--mcp-config');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/quoted/));
   });

   it('spawns the claude command unchanged and logs when the config writer throws', () => {
      const { commandLine } = launchWith('claude', {
         mcpPort: 31417,
         writeConfig: () => {
            throw new Error('disk full');
         },
      });
      expect(commandLine()).not.toContain('--mcp-config');
      expect(errorSpy).toHaveBeenCalledTimes(1);
   });

   it('spawns unchanged and logs when the real writer fails because the root is a regular file', () => {
      /** @type {string} A regular file standing where the config root would be. */
      const blocker = path.join(root, 'blocker.txt');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(blocker, 'not a directory');
      const { handlers, spawn } = createManager({ mcpPort: 31417, configRoot: blocker });
      handlers[TERMINAL_LAUNCH]({ command: 'claude', cols: 80, rows: 24 });
      const [, args] = spawn.mock.calls[0];
      expect(Array.isArray(args) ? args.join(' ') : args).not.toContain('--mcp-config');
      expect(errorSpy).toHaveBeenCalledTimes(1);
   });

   it('writes the config to <configRoot>/.wiretap/mcp-<port>.json and wires that path', () => {
      const { handlers, spawn } = createManager({ mcpPort: 31417 });
      handlers[TERMINAL_LAUNCH]({ command: 'claude', cols: 80, rows: 24 });
      /** @type {string} The expected config file path. */
      const file = path.join(root, '.wiretap', 'mcp-31417.json');
      const [, args] = spawn.mock.calls[0];
      expect(Array.isArray(args) ? args.join(' ') : args).toContain(`--mcp-config "${file}"`);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.wiretap.url).toBe('http://127.0.0.1:31417/mcp');
      expect(errorSpy).not.toHaveBeenCalled();
   });

   it('rewrites the config file on every wired launch, restoring changed content', () => {
      const { spawn, handlers, child } = createManager({ mcpPort: 31417 });
      handlers[TERMINAL_LAUNCH]({ command: 'claude', cols: 80, rows: 24 });
      /** @type {string} The config file path. */
      const file = path.join(root, '.wiretap', 'mcp-31417.json');
      fs.writeFileSync(file, 'tampered');
      child.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 });
      handlers[TERMINAL_LAUNCH]({ command: 'claude', cols: 80, rows: 24 });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.wiretap.type).toBe('http');
      expect(errorSpy).not.toHaveBeenCalled();
   });

   it('calls the writer on every wired launch', () => {
      const writeConfig = vi.fn(() => '/tmp/.wiretap/mcp-31417.json');
      const { handlers, child } = createManager({ mcpPort: 31417, writeConfig });
      handlers[TERMINAL_LAUNCH]({ command: 'claude', cols: 80, rows: 24 });
      child.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 });
      handlers[TERMINAL_LAUNCH]({ command: 'claude', cols: 80, rows: 24 });
      expect(writeConfig).toHaveBeenCalledTimes(2);
   });

   it('rethrows the kill error on dispose, clears the terminal and makes a second dispose a no-op', () => {
      const { handlers, manager, child } = createManager({ mcpPort: 31417, writeConfig: vi.fn(() => '/tmp/c.json') });
      handlers[TERMINAL_LAUNCH]({ command: 'claude', cols: 80, rows: 24 });
      child.kill.mockImplementation(() => {
         throw new Error('kill failed');
      });
      expect(() => manager.dispose()).toThrow('kill failed');
      expect(() => manager.dispose()).not.toThrow();
      expect(child.kill).toHaveBeenCalledTimes(1);
   });

   it('disposes cleanly when no config was ever written', () => {
      const { manager } = createManager({ mcpPort: 31417 });
      expect(() => manager.dispose()).not.toThrow();
   });

   it.each([[123], [null], [{}], [['claude']], [true]])('launches nothing for a non-string command %j', (command) => {
      const { spawn, handlers } = createManager({ mcpPort: 31417 });
      expect(() => handlers[TERMINAL_LAUNCH]({ command, cols: 80, rows: 24 })).not.toThrow();
      expect(spawn).not.toHaveBeenCalled();
   });

   it.each([[undefined], [null], ['claude'], [42]])('launches nothing and does not throw for payload %j', (payload) => {
      const { spawn, handlers } = createManager({ mcpPort: 31417 });
      expect(() => handlers[TERMINAL_LAUNCH](payload)).not.toThrow();
      expect(spawn).not.toHaveBeenCalled();
   });
});
