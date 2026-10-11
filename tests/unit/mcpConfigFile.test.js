// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigRoot, writeMcpConfig } from '../../server/mcpConfigFile.ts';

/** @type {boolean} Whether the tests run on Windows, where POSIX file modes are not enforced. */
const isWindows = process.platform === 'win32';

/** @type {string} The gitignored scratch directory every filesystem test writes into; never the real module root. */
const SCRATCH = path.resolve(
   path.dirname(fileURLToPath(import.meta.url)),
   '..',
   '..',
   'test',
   'tmp',
   'mcpConfigFile',
);

/** @type {number} Epoch milliseconds at module load; separates this run's roots from an earlier run's recycled pid. */
const RUN_STAMP = Date.now();

/** @type {number} Counter that makes every scratch root of this process unique. */
let rootCounter = 0;

/**
 * Return a scratch root no earlier run or test has used: `<SCRATCH>/<timestamp>-<pid>-<counter>/<name>`. The
 * timestamp keeps a recycled process id from colliding with an earlier run. The root must not exist yet, so a stale
 * scratch directory fails the test loudly instead of letting it pass on leftovers. Nothing is ever removed; leftovers
 * stay in the gitignored scratch directory.
 * @param {string} name - A label for the test.
 * @returns {string} The absolute path of a root that does not exist.
 */
function freshRoot(name) {
   rootCounter += 1;
   /** @type {string} The unique root. */
   const root = path.join(SCRATCH, `${RUN_STAMP}-${process.pid}-${rootCounter}`, name);
   expect(fs.existsSync(root), `stale scratch root ${root}`).toBe(false);
   return root;
}

/** @type {string} The module root, used only to assert the default root path (nothing is written there). */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

afterEach(() => {
   vi.restoreAllMocks();
});

describe('defaultConfigRoot', () => {
   it('is the module root (the parent of server/), independent of the working directory', () => {
      expect(defaultConfigRoot()).toBe(MODULE_ROOT);
   });
});

describe('writeMcpConfig', () => {
   it('writes <root>/.wiretap/mcp-<port>.json with the config JSON and returns the path', () => {
      /** @type {string} The root used by this test. */
      const root = freshRoot('write');
      /** @type {string} The written config file path. */
      const file = writeMcpConfig(31417, root);
      expect(fs.existsSync(root)).toBe(true);
      expect(file).toBe(path.join(root, '.wiretap', 'mcp-31417.json'));
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.wiretap.url).toBe('http://127.0.0.1:31417/mcp');
   });

   it('creates the root and .wiretap directories when they do not exist yet', () => {
      /** @type {string} A nested root that is created by the writer itself. */
      const root = freshRoot('nested');
      /** @type {string} The written config file path. */
      const file = writeMcpConfig(31417, root);
      expect(fs.existsSync(root)).toBe(true);
      expect(fs.statSync(path.dirname(file)).isDirectory()).toBe(true);
   });

   it('overwrites an existing file', () => {
      /** @type {string} The root used by this test. */
      const root = freshRoot('overwrite');
      /** @type {string} The target path. */
      const file = path.join(root, '.wiretap', 'mcp-31417.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'pre-existing');
      expect(writeMcpConfig(31417, root)).toBe(file);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.wiretap.type).toBe('http');
   });

   it('is idempotent across repeated writes', () => {
      /** @type {string} The root used by this test. */
      const root = freshRoot('idempotent');
      /** @type {string} The first write's content. */
      const first = fs.readFileSync(writeMcpConfig(31417, root), 'utf8');
      expect(fs.readFileSync(writeMcpConfig(31417, root), 'utf8')).toBe(first);
   });

   it.skipIf(isWindows)('creates the directory 0o700 and the file 0o600', () => {
      /** @type {string} A root no other test has created, so the writer creates the modes under test. */
      const root = freshRoot('modes');
      /** @type {string} The written config file path. */
      const file = writeMcpConfig(31418, root);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
   });

   it('refuses a file path that is a symbolic link and leaves the target untouched', () => {
      /** @type {string} The root used by this test. */
      const root = freshRoot('symlink-file');
      /** @type {string} The target path. */
      const file = path.join(root, '.wiretap', 'mcp-31417.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'pre-existing');
      /** @type {typeof fs.lstatSync} The real lstat, used for every path except the file under test. */
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) =>
         target === file ? { isSymbolicLink: () => true } : realLstat(target, ...rest),
      );
      expect(() => writeMcpConfig(31417, root)).toThrow(/mcp-31417\.json is a symbolic link/);
      expect(fs.readFileSync(file, 'utf8')).toBe('pre-existing');
   });

   it('refuses a .wiretap directory that is a symbolic link and writes nothing', () => {
      /** @type {string} The root used by this test. */
      const root = freshRoot('symlink-dir');
      /** @type {string} The config directory under test. */
      const dir = path.join(root, '.wiretap');
      /** @type {typeof fs.lstatSync} The real lstat, used for every path except the directory under test. */
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) =>
         target === dir ? { isSymbolicLink: () => true } : realLstat(target, ...rest),
      );
      /** @type {import('vitest').MockInstance} Records writes so none can slip through. */
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      expect(() => writeMcpConfig(31417, root)).toThrow(/\.wiretap is a symbolic link/);
      expect(writeSpy).not.toHaveBeenCalled();
   });

   it('throws when the root path is a regular file', () => {
      /** @type {string} A file standing where the root directory would be. */
      const blocker = path.join(freshRoot('blocker'), 'blocker.txt');
      fs.mkdirSync(path.dirname(blocker), { recursive: true });
      fs.writeFileSync(blocker, 'not a directory');
      expect(() => writeMcpConfig(31417, blocker)).toThrow();
   });
});
