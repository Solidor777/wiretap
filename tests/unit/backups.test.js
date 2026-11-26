// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createBackupStore } from '../../server/backups.ts';
import {
   BACKUP_FILE_PATTERN,
   HEADER_LINE_BYTES,
   backupFileName,
   blankHeaderLine,
   formatHeaderLine,
   parseHeaderLine,
} from '../../shared/backup.js';
import { fakeTrash, scratchRoot } from './backupTestHelpers.js';

/** @typedef {import('../../server/backups.ts').BackupStore} BackupStore */
/** @typedef {import('../../server/backups.ts').BackupStoreOptions} BackupStoreOptions */
/** @typedef {import('../../server/backups.ts').ResolvedFolder} ResolvedFolder */

/** @type {boolean} Whether the tests run on Windows, where POSIX file modes are not enforced. */
const isWindows = process.platform === 'win32';

/** @type {'junction' | 'dir'} The directory link type that needs no administrator rights on this platform. */
const DIR_LINK = isWindows ? 'junction' : 'dir';

/** @typedef {Omit<import('../../shared/backup.js').BackupHeader, 'wiretapBackup' | 'created' | 'bytes'>} Fields */

/** @type {Fields} Synthetic header fields of one-document backups. */
const FIELDS = {
   worldId: 'w',
   foundryVersion: '14.364',
   systemId: 's',
   systemVersion: '1',
   note: '',
   documents: 1,
};

/** @type {string} One document line of a synthetic backup. */
const LINE = '{"a":1}\n';

/**
 * @typedef {object} Fixture
 * @property {string} root - The scratch root that holds `.wiretap/`.
 * @property {string} bin - The fake recycle bin directory.
 * @property {ReturnType<typeof fakeTrash>} trash - The fake recycle bin.
 * @property {BackupStore} store - The store under test.
 */

/**
 * Build a store over a fresh scratch root and a fake recycle bin.
 * @param {BackupStoreOptions} [options] - Options that replace the defaults of the fixture.
 * @returns {Fixture} The root, the bin directory, the fake recycle bin and the store.
 */
function setup(options = {}) {
   /** @type {string} The scratch root. */
   const root = scratchRoot('backups');
   /** @type {string} The fake recycle bin directory. */
   const bin = path.join(root, 'bin');
   /** @type {ReturnType<typeof fakeTrash>} The fake recycle bin. */
   const trash = fakeTrash(bin);
   return {
      root,
      bin,
      trash,
      store: createBackupStore({
         root,
         trash,
         ...options,
      }),
   };
}

/**
 * Create a directory under the scratch root and return it as a named folder.
 * @param {Fixture} fixture - The store and its scratch root.
 * @param {string} name - The name of the directory to create under the root.
 * @returns {ResolvedFolder} The new directory, resolved as a named folder.
 */
function namedFolder(fixture, name) {
   /** @type {string} The directory path. */
   const dir = path.join(fixture.root, name);
   fs.mkdirSync(dir);
   return fixture.store.resolveFolder(dir, '');
}

/**
 * Write one complete backup through the store.
 * @param {BackupStore} store - The store that writes it.
 * @param {ResolvedFolder} folder - The checked folder to write into.
 * @returns {Promise<string>} The absolute path of the finished file.
 */
async function writeBackup(store, folder) {
   /** @type {import('../../server/backups.ts').BackupFileWriter} A new backup file being written. */
   const writer = await store.createFile(folder);
   writer.append(Buffer.from(LINE));
   writer.finish(FIELDS);
   return writer.filePath;
}

/**
 * Run a function and return what it threw.
 * @param {() => unknown} fn - Code that is expected to throw.
 * @returns {any} What it threw.
 * @throws {Error} When it does not throw.
 */
function thrown(fn) {
   try {
      fn();
   } catch (error) {
      return error;
   }
   throw new Error('expected a throw');
}

afterEach(() => {
   vi.restoreAllMocks();
});

describe('resolveFolder', () => {
   it('resolves no folder to the default, and to the setting when the setting is set', () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      expect(fixture.store.defaultFolder).toBe(path.join(fixture.root, '.wiretap', 'backups'));
      expect(fixture.store.resolveFolder(undefined, '')).toEqual({
         kind: 'default',
         path: path.join(fixture.root, '.wiretap', 'backups'),
      });
      expect(fixture.store.resolveFolder(undefined, fixture.root)).toEqual({
         kind: 'setting',
         path: fixture.root,
      });
   });

   it('treats other spellings of the default and the setting as the same folder on Windows', () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup({ platform: 'win32' });
      /** @type {string} The default folder. */
      const def = fixture.store.defaultFolder;
      /** @type {string} The Backup folder setting. */
      const setting = path.join(fixture.root, 'set');
      for (const spelling of [def.toUpperCase(), def + path.sep, `${def}${path.sep}x${path.sep}..`]) {
         expect(fixture.store.resolveFolder(spelling, setting).kind).toBe('default');
      }
      for (const spelling of [setting.toUpperCase(), setting + path.sep, `${setting}${path.sep}x${path.sep}..`]) {
         expect(fixture.store.resolveFolder(spelling, setting)).toEqual({
            kind: 'setting',
            path: path.resolve(spelling),
         });
      }
      expect(fixture.store.resolveFolder(path.join(fixture.root, 'other'), setting).kind).toBe('named');
      /** @type {BackupStore} The same root on a case-sensitive platform. */
      const linux = createBackupStore({
         root: fixture.root,
         trash: fixture.trash,
         platform: 'linux',
      });
      expect(linux.resolveFolder(def.toUpperCase(), '').kind).toBe('named');
   });

   it('refuses a relative folder and a relative setting with BACKUP_FOLDER_INVALID', () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      expect(thrown(() => fixture.store.resolveFolder('rel', ''))).toMatchObject({
         code: 'BACKUP_FOLDER_INVALID',
         message: 'The folder must be an absolute path.',
      });
      expect(thrown(() => fixture.store.resolveFolder(undefined, 'rel'))).toMatchObject({
         code: 'BACKUP_FOLDER_INVALID',
         message: 'The Backup folder setting must be an absolute path.',
      });
   });

   it('resolves a named absolute folder while the Backup folder setting is relative', () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      expect(fixture.store.resolveFolder(fixture.root, 'rel')).toEqual({
         kind: 'named',
         path: fixture.root,
      });
      expect(fixture.store.resolveFolder(fixture.store.defaultFolder, 'rel')).toEqual({
         kind: 'default',
         path: fixture.store.defaultFolder,
      });
   });
});

describe('checkFolder', () => {
   it('creates the default folder only when asked, and refuses a missing named folder', () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {ResolvedFolder} The default folder. */
      const def = fixture.store.resolveFolder(undefined, '');
      expect(fixture.store.checkFolder(def, false)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, '.wiretap'))).toBe(false);
      expect(fixture.store.checkFolder(def, true)).toBe(true);
      expect(fs.statSync(def.path).isDirectory()).toBe(true);
      expect(fixture.store.checkFolder(def, false)).toBe(true);
      /** @type {ResolvedFolder} A named folder that does not exist. */
      const missing = fixture.store.resolveFolder(path.join(fixture.root, 'missing'), '');
      expect(thrown(() => fixture.store.checkFolder(missing, true))).toMatchObject({
         code: 'BACKUP_FOLDER_INVALID',
         message: 'The folder does not exist.',
      });
      expect(fs.existsSync(missing.path)).toBe(false);
   });

   it('refuses a folder that is not a directory', () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {string} A regular file. */
      const file = path.join(fixture.root, 'file.txt');
      fs.writeFileSync(file, 'x');
      expect(thrown(() => fixture.store.checkFolder(fixture.store.resolveFolder(file, ''), false))).toMatchObject({
         code: 'BACKUP_FOLDER_INVALID',
         message: 'The folder is not a directory.',
      });
   });

   it.skipIf(isWindows)('creates the default folder at 0o700', () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      fixture.store.checkFolder(fixture.store.resolveFolder(undefined, ''), true);
      expect(fs.statSync(fixture.store.defaultFolder).mode & 0o777).toBe(0o700);
   });

   it('refuses a folder that is a symbolic link, and a .wiretap that is one', () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {string} A real directory the links point at. */
      const target = path.join(fixture.root, 'target');
      fs.mkdirSync(target);
      /** @type {string} A link to it. */
      const link = path.join(fixture.root, 'link');
      fs.symlinkSync(target, link, DIR_LINK);
      expect(thrown(() => fixture.store.checkFolder(fixture.store.resolveFolder(link, ''), false))).toMatchObject({
         code: 'BACKUP_FOLDER_INVALID',
         message: 'The backup folder is a symbolic link.',
      });
      fs.symlinkSync(target, path.join(fixture.root, '.wiretap'), DIR_LINK);
      /** @type {ResolvedFolder} The default folder, under the linked `.wiretap`. */
      const def = fixture.store.resolveFolder(undefined, '');
      for (const create of [false, true]) {
         expect(thrown(() => fixture.store.checkFolder(def, create))).toMatchObject({
            code: 'BACKUP_FOLDER_INVALID',
            message: 'The backup folder is a symbolic link.',
         });
      }
      expect(fs.readdirSync(target)).toEqual([]);
   });
});

describe('createFile', () => {
   it('creates the file exclusively at 0o600 with a blank header, then writes the header in place', async () => {
      /** @type {Date} The fixed creation time. */
      const created = new Date(Date.UTC(2026, 10, 21, 1, 2, 3, 4));
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup({
         now: () => created,
         randomSuffix: () => 'abcdEFGH',
      });
      /** @type {ResolvedFolder} The default folder. */
      const folder = fixture.store.resolveFolder(undefined, '');
      fixture.store.checkFolder(folder, true);
      /** @type {import('../../server/backups.ts').BackupFileWriter} A new backup file being written. */
      const writer = await fixture.store.createFile(folder);
      expect(writer.file).toBe(backupFileName(created, 'abcdEFGH'));
      expect(writer.file).toMatch(BACKUP_FILE_PATTERN);
      expect(writer.filePath).toBe(path.join(folder.path, writer.file));
      expect(fs.readFileSync(writer.filePath, 'utf8')).toBe(blankHeaderLine());
      expect(writer.size()).toBe(HEADER_LINE_BYTES);
      writer.append(Buffer.from(LINE));
      expect(writer.size()).toBe(HEADER_LINE_BYTES + 8);
      /** @type {import('../../shared/backup.js').BackupHeader} The written header. */
      const header = writer.finish(FIELDS);
      writer.close();
      expect(header).toEqual({
         wiretapBackup: 1,
         created: created.toISOString(),
         ...FIELDS,
         bytes: HEADER_LINE_BYTES + 8,
      });
      expect(fs.statSync(writer.filePath).size).toBe(header.bytes);
      /** @type {string} The file text. */
      const text = fs.readFileSync(writer.filePath, 'utf8');
      expect(text.slice(0, HEADER_LINE_BYTES)).toBe(formatHeaderLine(header));
      expect(parseHeaderLine(text.slice(0, HEADER_LINE_BYTES))).toEqual(header);
      expect(text.slice(HEADER_LINE_BYTES)).toBe(LINE);
      if (!isWindows) {
         expect(fs.statSync(writer.filePath).mode & 0o777).toBe(0o600);
      }
   });

   it('never overwrites an existing file, and logs the failure through the given logger', async () => {
      /** @type {string[]} The store's log lines. */
      const logs = [];
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup({
         now: () => new Date(Date.UTC(2026, 0, 1)),
         randomSuffix: () => 'sameSAME',
         log: (line) => logs.push(line),
      });
      /** @type {ResolvedFolder} The default folder. */
      const folder = fixture.store.resolveFolder(undefined, '');
      fixture.store.checkFolder(folder, true);
      /** @type {string} The backup whose name the second create repeats. */
      const first = await writeBackup(fixture.store, folder);
      /** @type {Buffer} Its bytes before the second create. */
      const before = fs.readFileSync(first);
      /** @type {import('vitest').MockInstance} The console sink the store must not use. */
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(fixture.store.createFile(folder)).rejects.toMatchObject({
         code: 'BACKUP_WRITE_FAILED',
         message: 'The backup file could not be written.',
      });
      expect(fs.readFileSync(first)).toEqual(before);
      expect(consoleError).not.toHaveBeenCalled();
      expect(logs).toEqual([expect.stringMatching(/^Wiretap sidecar \| backup file write failed: /)]);
      expect(fixture.trash.calls).toEqual([]);
   });

   it('moves the new file to the recycle bin when writing its blank header fails', async () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup({ log: () => {} });
      /** @type {ResolvedFolder} The default folder. */
      const folder = fixture.store.resolveFolder(undefined, '');
      fixture.store.checkFolder(folder, true);
      vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
         throw new Error('disk full');
      });
      await expect(fixture.store.createFile(folder)).rejects.toMatchObject({
         code: 'BACKUP_WRITE_FAILED',
         message: 'The backup file could not be written.',
      });
      expect(fs.readdirSync(folder.path)).toEqual([]);
      expect(fixture.trash.calls).toHaveLength(1);
      expect(path.basename(fixture.trash.calls[0][0])).toMatch(BACKUP_FILE_PATTERN);
   });

   it('names the new file when writing its header fails and the recycle bin refuses it', async () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup({
         log: () => {},
         trash: async () => {
            throw new Error('no bin');
         },
      });
      /** @type {ResolvedFolder} The default folder. */
      const folder = fixture.store.resolveFolder(undefined, '');
      fixture.store.checkFolder(folder, true);
      vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
         throw new Error('disk full');
      });
      /** @type {any} The thrown error. */
      const error = await fixture.store.createFile(folder).catch((caught) => caught);
      /** @type {string[]} The partial file left in place. */
      const left = fs.readdirSync(folder.path);
      expect(left).toHaveLength(1);
      expect(error).toMatchObject({
         code: 'BACKUP_WRITE_FAILED',
         message: 'The backup file could not be written. '
            + `The partial file ${left[0]} could not be moved to the recycle bin.`,
      });
   });
});

describe('openFile', () => {
   it('opens a valid backup and reads it in pieces after the header', async () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {ResolvedFolder} A named folder. */
      const folder = namedFolder(fixture, 'named');
      /** @type {string} The backup file. */
      const filePath = await writeBackup(fixture.store, folder);
      /** @type {import('../../server/backups.ts').BackupFileReader} The checked backup, open for reading. */
      const reader = fixture.store.openFile(folder, path.basename(filePath));
      expect(reader.file).toBe(path.basename(filePath));
      expect(reader.header).toMatchObject({
         ...FIELDS,
         bytes: HEADER_LINE_BYTES + 8,
      });
      /** @type {Buffer | null} The first piece. */
      const one = reader.readPiece(5);
      /** @type {Buffer | null} The second piece. */
      const two = reader.readPiece(5);
      expect(reader.readPiece(5)).toBeNull();
      reader.close();
      expect(Buffer.concat([one, two]).toString('utf8')).toBe(LINE);
      expect(one.length).toBe(5);
   });

   it('refuses an off-pattern or missing name with BACKUP_NOT_FOUND', async () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {ResolvedFolder} A named folder. */
      const folder = namedFolder(fixture, 'named');
      /** @type {string} A valid backup file. */
      const filePath = await writeBackup(fixture.store, folder);
      fs.copyFileSync(filePath, path.join(folder.path, 'copy.jsonl'));
      for (const name of ['../x', 'copy.jsonl', backupFileName(new Date(0), 'absentAA')]) {
         expect(thrown(() => fixture.store.openFile(folder, name))).toMatchObject({
            code: 'BACKUP_NOT_FOUND',
            message: 'No backup file of that name.',
         });
      }
   });

   it('refuses a truncated, appended, blank-header or non-backup file with BACKUP_INVALID, without echoing content',
      async () => {
         /** @type {Fixture} A store over a fresh scratch root. */
         const fixture = setup();
         /** @type {ResolvedFolder} A named folder. */
         const folder = namedFolder(fixture, 'named');
         /** @type {string} A valid backup file. */
         const valid = fs.readFileSync(await writeBackup(fixture.store, folder), 'utf8');
         /** @type {Array<[string, string, string]>} Name suffix, content and expected message of each case. */
         const cases = [
            ['trunc', valid.slice(0, -2), 'The backup file is incomplete or was changed.'],
            ['appnd', `${valid}{"b":2}\n`, 'The backup file is incomplete or was changed.'],
            ['blank', `${blankHeaderLine()}${LINE}`, 'The file is not a Wiretap backup.'],
            ['other', 'SECRETCONTENT', 'The file is not a Wiretap backup.'],
         ];
         for (const [suffix, content, message] of cases) {
            /** @type {string} The case's file name. */
            const name = backupFileName(new Date(1000), `${suffix}XYZ`);
            fs.writeFileSync(path.join(folder.path, name), content);
            /** @type {any} The thrown error. */
            const error = thrown(() => fixture.store.openFile(folder, name));
            expect(error).toMatchObject({
               code: 'BACKUP_INVALID',
               message,
            });
            expect(error.message).not.toMatch(/SECRET|"a"|wiretapBackup/);
         }
         /** @type {string} A directory named on the pattern. */
         const dirName = backupFileName(new Date(2000), 'dirAAAAA');
         fs.mkdirSync(path.join(folder.path, dirName));
         expect(thrown(() => fixture.store.openFile(folder, dirName))).toMatchObject({
            code: 'BACKUP_INVALID',
            message: 'The file is not a Wiretap backup.',
         });
      });
});

describe('list', () => {
   it('lists newest first, counts total and invalid, and skips partial files', async () => {
      /** @type {number} The clock, advanced by each `now()` call. */
      let clock = Date.UTC(2026, 0, 1);
      /** @type {number} Counter for unique suffixes. */
      let suffix = 0;
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup({
         now: () => new Date((clock += 1000)),
         randomSuffix: () => `suffix${(suffix += 1)}A`,
      });
      /** @type {ResolvedFolder} The default folder. */
      const folder = fixture.store.resolveFolder(undefined, '');
      expect(fixture.store.list(folder, 10)).toEqual({
         rows: [],
         total: 0,
         invalid: 0,
         unread: 0,
      });
      fixture.store.checkFolder(folder, true);
      /** @type {string[]} The valid files, oldest first. */
      const files = [];
      for (let index = 0; index < 3; index += 1) {
         files.push(path.basename(await writeBackup(fixture.store, folder)));
      }
      (await fixture.store.createFile(folder)).close();
      fs.writeFileSync(path.join(folder.path, 'notes.txt'), 'x');
      /** @type {import('../../server/backups.ts').BackupListing} The two newest valid backups and the counts. */
      const listing = fixture.store.list(folder, 2);
      expect(listing).toEqual({
         rows: [
            [files[2], new Date(Date.UTC(2026, 0, 1) + 3000).toISOString(), 1, ''],
            [files[1], new Date(Date.UTC(2026, 0, 1) + 2000).toISOString(), 1, ''],
         ],
         total: 4,
         invalid: 1,
         unread: 0,
      });
   });

   // The cap is only reachable with 1001 real files on disk, so this test writes 1001 files and reads 1000 headers.
   // Measured on Windows with real-time antivirus on: 4.6 to 5.5 s with this file run alone, and 11 to 31 s in a full
   // default-worker run, where the header reads alone took up to 29 s. The limit is about twice the worst full run.
   it('stops reading headers after 1000', { timeout: 60000 }, () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {ResolvedFolder} A named folder. */
      const folder = namedFolder(fixture, 'many');
      for (let index = 0; index < 1001; index += 1) {
         fs.writeFileSync(
            path.join(folder.path, backupFileName(new Date(index), `p${String(index).padStart(7, '0')}`)),
            blankHeaderLine(),
         );
      }
      expect(fixture.store.list(folder, 50)).toEqual({
         rows: [],
         total: 1001,
         invalid: 1000,
         unread: 1,
      });
   });
});

describe('trashFile and trashPath', () => {
   it('moves a valid backup to the recycle bin and refuses a non-backup', async () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {import('vitest').Mock} A spy over the fake recycle bin, to see the options. */
      const trash = vi.fn(fixture.trash);
      /** @type {BackupStore} The store using the spy. */
      const store = createBackupStore({
         root: fixture.root,
         trash,
      });
      /** @type {ResolvedFolder} A named folder. */
      const folder = namedFolder(fixture, 'named');
      /** @type {string} A valid backup file. */
      const filePath = await writeBackup(store, folder);
      await store.trashFile(folder, path.basename(filePath));
      expect(fixture.trash.calls).toEqual([[filePath]]);
      expect(trash).toHaveBeenCalledWith([filePath], { glob: false });
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.bin, path.basename(filePath)))).toBe(true);
      /** @type {string} A partial file named on the pattern. */
      const partial = backupFileName(new Date(0), 'partialA');
      fs.writeFileSync(path.join(folder.path, partial), blankHeaderLine());
      await expect(store.trashFile(folder, partial)).rejects.toMatchObject({
         code: 'BACKUP_INVALID',
         message: 'The file is not a Wiretap backup.',
      });
      expect(trash).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(folder.path, partial))).toBe(true);
   });

   it('fails TRASH_FAILED naming the file when trash throws or leaves the file in place', async () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {ResolvedFolder} A named folder. */
      const folder = namedFolder(fixture, 'named');
      /** @type {string} A valid backup file. */
      const filePath = await writeBackup(fixture.store, folder);
      /** @type {string} The backup's file name, expected in each message. */
      const name = path.basename(filePath);
      /** @type {BackupStore} A store whose recycle bin rejects. */
      const rejecting = createBackupStore({
         root: fixture.root,
         trash: async () => {
            throw new Error('no bin');
         },
      });
      await expect(rejecting.trashFile(folder, name)).rejects.toMatchObject({
         code: 'TRASH_FAILED',
         message: `Could not move ${name} to the recycle bin: no bin.`,
      });
      expect(fs.existsSync(filePath)).toBe(true);
      /** @type {BackupStore} A store whose recycle bin resolves without moving the file. */
      const idle = createBackupStore({
         root: fixture.root,
         trash: async () => {},
      });
      await expect(idle.trashPath(filePath)).rejects.toMatchObject({
         code: 'TRASH_FAILED',
         message: `Could not move ${name} to the recycle bin.`,
      });
      expect(fs.existsSync(filePath)).toBe(true);
   });

   it('bounds the reason to 120 bytes', async () => {
      /** @type {Fixture} A store over a fresh scratch root. */
      const fixture = setup();
      /** @type {string} A file to move. */
      const filePath = path.join(fixture.root, backupFileName(new Date(0), 'boundAAA'));
      fs.writeFileSync(filePath, 'x');
      /** @type {BackupStore} A store whose recycle bin rejects with a long reason. */
      const store = createBackupStore({
         root: fixture.root,
         trash: async () => {
            throw new Error('r'.repeat(500));
         },
      });
      /** @type {string} The message prefix before the reason. */
      const prefix = `Could not move ${path.basename(filePath)} to the recycle bin: `;
      /** @type {any} The thrown error. */
      const error = await store.trashPath(filePath).catch((caught) => caught);
      expect(error.code).toBe('TRASH_FAILED');
      expect(error.message.startsWith(`${prefix}rrr`)).toBe(true);
      expect(error.message.endsWith('.')).toBe(true);
      expect(Buffer.byteLength(error.message.slice(prefix.length, -1))).toBeLessThanOrEqual(120);
   });
});
