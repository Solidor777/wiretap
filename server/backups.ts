/**
 * The backup file store: the one sidecar module that creates, reads, lists and recycles backup files, and the only
 * importer of the `trash` package. It never overwrites a file (every create is exclusive), never reads or recycles a
 * file whose name is off the backup pattern or whose header and size do not check out, and refuses every symbolic link
 * (on Windows a directory junction counts as one) on the folder, on `.wiretap` for the default folder, and on the file.
 * Residual risk, as for the MCP config file: each link check and the following open are separate calls (time-of-check
 * to time-of-use), so a link swapped in between is not caught; no `O_NOFOLLOW` open is used.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import trash from 'trash';
import {
   BACKUP_FILE_PATTERN,
   BACKUP_FOLDER_INVALID,
   BACKUP_FORMAT_VERSION,
   BACKUP_INVALID,
   BACKUP_NOT_FOUND,
   BACKUP_WRITE_FAILED,
   HEADER_LINE_BYTES,
   LIST_HEADER_READS_MAX,
   TRASH_FAILED,
   backupFileName,
   blankHeaderLine,
   formatHeaderLine,
   parseHeaderLine,
   type BackupHeader,
} from '../shared/backup.js';
import { describeCause } from '../shared/logText.js';
import { BridgeError } from './endpoints.ts';
import { defaultConfigRoot, ensureWiretapDir, refuseSymbolicLink } from './mcpConfigFile.ts';

/** Moves files to the recycle bin; the `trash` package's call shape. */
export type TrashFunction = (paths: string[], options: { glob: false }) => Promise<void>;

/** Injectable dependencies of the store; each has a production default. */
export interface BackupStoreOptions {
   /** The directory holding `.wiretap/`; default the module root. */
   root?: string;
   /** The recycle bin; default the `trash` package. */
   trash?: TrashFunction;
   /** The clock; default `() => new Date()`. */
   now?: () => Date;
   /** Eight file-name characters of `[A-Za-z0-9_-]`; default six random bytes in base64url. */
   randomSuffix?: () => string;
   /** The platform whose path rules apply to folder equality; default `process.platform`. */
   platform?: NodeJS.Platform;
}

/** Where a folder came from: the default folder, the Backup folder setting, or a folder the caller named. */
export type FolderKind = 'default' | 'setting' | 'named';

/** A backup folder resolved to an absolute path. */
export interface ResolvedFolder {
   /** The absolute, resolved path. */
   path: string;
   /** Where it came from. */
   kind: FolderKind;
}

/** A backup file being written: a blank header line, then appended document lines, then the header in place. */
export interface BackupFileWriter {
   /** The file name. */
   file: string;
   /** The absolute file path. */
   filePath: string;
   /** Write bytes at the end of the file. */
   append(data: Uint8Array): void;
   /** The file size so far, header line included. */
   size(): number;
   /** Write the header over the blank line, close the file and return the header. */
   finish(fields: Omit<BackupHeader, 'wiretapBackup' | 'created' | 'bytes'>): BackupHeader;
   /** Close the file if it is still open. */
   close(): void;
}

/** A checked backup file open for reading its document lines. */
export interface BackupFileReader {
   /** The file name. */
   file: string;
   /** The parsed header. */
   header: BackupHeader;
   /** Read the next piece of at most `maxBytes` bytes after the header line; null at the end of the file. */
   readPiece(maxBytes: number): Buffer | null;
   /** Close the file. */
   close(): void;
}

/** The backups of one folder, newest first. */
export interface BackupListing {
   /** `[file, created, documents, note]` per valid backup, with full notes. */
   rows: Array<[string, string, number, string]>;
   /** How many names in the folder match the backup pattern. */
   total: number;
   /** How many of the names read were not valid backups. */
   invalid: number;
}

/** The backup file store. */
export interface BackupStore {
   /** `<root>/.wiretap/backups`. */
   defaultFolder: string;
   /** Resolve the caller's folder (or none) against the default and the Backup folder setting. */
   resolveFolder(folder: string | undefined, settingFolder: string): ResolvedFolder;
   /** Check a folder, creating the default one when `create` is set; returns whether it exists. */
   checkFolder(folder: ResolvedFolder, create: boolean): boolean;
   /** Create a new backup file exclusively. */
   createFile(folder: ResolvedFolder): BackupFileWriter;
   /** Open and check a backup file by name. */
   openFile(folder: ResolvedFolder, file: string): BackupFileReader;
   /** List the folder's backups, newest first. */
   list(folder: ResolvedFolder, limit: number): BackupListing;
   /** Check a backup file by name, then move it to the recycle bin. */
   trashFile(folder: ResolvedFolder, file: string): Promise<void>;
   /** Move a path to the recycle bin and confirm it is gone. */
   trashPath(filePath: string): Promise<void>;
}

/** What `lstat` found at a path. */
type PathState = 'missing' | 'directory' | 'file' | 'other';

// Longest recycle-bin failure reason in a `TRASH_FAILED` message, in UTF-8 bytes.
const TRASH_REASON_MAX_BYTES: number = 120;

/**
 * Build a `BACKUP_FOLDER_INVALID` error.
 * @param {string} message - The fixed message.
 * @returns {BridgeError} The error.
 */
function folderInvalid(message: string): BridgeError {
   return new BridgeError(BACKUP_FOLDER_INVALID, message);
}

/**
 * Build the `BACKUP_INVALID` error for a file that is not a backup.
 * @returns {BridgeError} The error.
 */
function notABackup(): BridgeError {
   return new BridgeError(BACKUP_INVALID, 'The file is not a Wiretap backup.');
}

/**
 * Inspect a folder path with `lstat`, refusing a symbolic link.
 * @param {string} target - The path.
 * @returns {PathState} What is at the path.
 * @throws {BridgeError} `BACKUP_FOLDER_INVALID` when the path is a symbolic link.
 */
function inspectFolder(target: string): PathState {
   // The path's own status, or null when nothing is there.
   let stat: fs.Stats | null;
   try {
      stat = fs.lstatSync(target);
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
         throw error;
      }
      stat = null;
   }
   if (stat === null) {
      return 'missing';
   }
   if (stat.isSymbolicLink()) {
      throw folderInvalid('The backup folder is a symbolic link.');
   }
   if (stat.isDirectory()) {
      return 'directory';
   }
   return stat.isFile() ? 'file' : 'other';
}

/**
 * Write all of a buffer at a file position.
 * @param {number} fd - The open file descriptor.
 * @param {Uint8Array} data - The bytes.
 * @param {number} position - The file offset of the first byte.
 * @returns {void}
 */
function writeAll(fd: number, data: Uint8Array, position: number): void {
   // How many bytes are written so far.
   let written: number = 0;
   while (written < data.length) {
      written += fs.writeSync(fd, data, written, data.length - written, position + written);
   }
}

/**
 * Read into a buffer from a file position until it is full or the file ends.
 * @param {number} fd - The open file descriptor.
 * @param {Buffer} buffer - The buffer to fill.
 * @param {number} position - The file offset of the first byte.
 * @returns {number} How many bytes were read.
 */
function readAll(fd: number, buffer: Buffer, position: number): number {
   // How many bytes are read so far.
   let filled: number = 0;
   while (filled < buffer.length) {
      // Bytes read by this call; 0 at the end of the file.
      const count: number = fs.readSync(fd, buffer, filled, buffer.length - filled, position + filled);
      if (count === 0) {
         break;
      }
      filled += count;
   }
   return filled;
}

/**
 * Log a file-system failure and return the fixed `BACKUP_WRITE_FAILED` error that replaces it.
 * @param {unknown} cause - The failure.
 * @returns {BridgeError} The error to throw.
 */
function writeFailed(cause: unknown): BridgeError {
   console.error(`Wiretap sidecar | backup file write failed: ${describeCause(cause)}`);
   return new BridgeError(BACKUP_WRITE_FAILED, 'The backup file could not be written.');
}

/**
 * Create the backup file store. No file is touched until a method is called.
 * @param {BackupStoreOptions} [options] - Dependencies to replace.
 * @returns {BackupStore} The store.
 */
export function createBackupStore(options: BackupStoreOptions = {}): BackupStore {
   // The directory holding `.wiretap/`.
   const root: string = options.root ?? defaultConfigRoot();
   // The recycle bin.
   const moveToTrash: TrashFunction = options.trash ?? trash;
   // The clock.
   const now: () => Date = options.now ?? (() => new Date());
   // The file-name suffix source.
   const randomSuffix: () => string = options.randomSuffix ?? (() => randomBytes(6).toString('base64url'));
   // The platform whose path rules apply.
   const platform: NodeJS.Platform = options.platform ?? process.platform;
   // The `.wiretap` directory.
   const wiretapDir: string = path.join(root, '.wiretap');
   // The default backup folder.
   const defaultFolder: string = path.join(wiretapDir, 'backups');

   /**
    * Compare two resolved paths, ignoring case on Windows.
    * @param {string} a - The first path.
    * @param {string} b - The second path.
    * @returns {boolean} Whether they name the same folder.
    */
   function samePath(a: string, b: string): boolean {
      return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
   }

   /**
    * Resolve the caller's folder against the default folder and the Backup folder setting.
    * @param {string | undefined} folder - The caller's folder, or undefined for none.
    * @param {string} settingFolder - The Backup folder setting; empty when unset.
    * @returns {ResolvedFolder} The resolved folder.
    * @throws {BridgeError} `BACKUP_FOLDER_INVALID` when the folder or the setting is not an absolute path.
    */
   function resolveFolder(folder: string | undefined, settingFolder: string): ResolvedFolder {
      if (folder !== undefined && !path.isAbsolute(folder)) {
         throw folderInvalid('The folder must be an absolute path.');
      }
      if (settingFolder !== '' && !path.isAbsolute(settingFolder)) {
         throw folderInvalid('The Backup folder setting must be an absolute path.');
      }
      // The resolved setting, or null when unset.
      const setting: string | null = settingFolder === '' ? null : path.resolve(settingFolder);
      if (folder === undefined) {
         return setting === null
            ? {
               path: path.resolve(defaultFolder),
               kind: 'default',
            }
            : {
               path: setting,
               kind: 'setting',
            };
      }
      // The resolved folder.
      const resolved: string = path.resolve(folder);
      if (samePath(resolved, path.resolve(defaultFolder))) {
         return {
            path: resolved,
            kind: 'default',
         };
      }
      if (setting !== null && samePath(resolved, setting)) {
         return {
            path: resolved,
            kind: 'setting',
         };
      }
      return {
         path: resolved,
         kind: 'named',
      };
   }

   /**
    * Check a folder: no symbolic link, a directory, and present unless it is the default folder.
    * @param {ResolvedFolder} folder - The folder.
    * @param {boolean} create - Whether to create the default folder when it is missing.
    * @returns {boolean} Whether the folder exists.
    * @throws {BridgeError} `BACKUP_FOLDER_INVALID` for a link, a missing setting or named folder, or a non-directory.
    */
   function checkFolder(folder: ResolvedFolder, create: boolean): boolean {
      if (folder.kind === 'default') {
         // What is at `.wiretap`.
         const wiretap: PathState = inspectFolder(wiretapDir);
         if (wiretap === 'missing' && !create) {
            return false;
         }
         if (create) {
            ensureWiretapDir(root);
            if (inspectFolder(folder.path) === 'missing') {
               fs.mkdirSync(folder.path, { mode: 0o700 });
            }
         }
      }
      // What is at the folder path.
      const state: PathState = inspectFolder(folder.path);
      if (state === 'missing') {
         if (folder.kind === 'default') {
            return false;
         }
         throw folderInvalid('The folder does not exist.');
      }
      if (state !== 'directory') {
         throw folderInvalid('The folder is not a directory.');
      }
      return true;
   }

   /**
    * Create a new backup file exclusively at mode 0o600 and write the blank header line.
    * @param {ResolvedFolder} folder - The folder, already checked.
    * @returns {BackupFileWriter} The writer.
    * @throws {BridgeError} `BACKUP_WRITE_FAILED` on any file-system failure, an existing file included.
    */
   function createFile(folder: ResolvedFolder): BackupFileWriter {
      // The creation time, used for both the name and the header.
      const createdAt: Date = now();
      // The file name.
      const file: string = backupFileName(createdAt, randomSuffix());
      // The file path.
      const filePath: string = path.join(folder.path, file);
      // The open descriptor, or null once closed.
      let fd: number | null = null;
      // The file size so far.
      let size: number = 0;
      try {
         refuseSymbolicLink(filePath, 'write the backup file');
         fd = fs.openSync(filePath, 'wx', 0o600);
         writeAll(fd, Buffer.from(blankHeaderLine()), 0);
         size = HEADER_LINE_BYTES;
      } catch (error) {
         if (fd !== null) {
            fs.closeSync(fd);
         }
         throw writeFailed(error);
      }
      /**
       * Return the open descriptor.
       * @returns {number} The descriptor.
       * @throws {BridgeError} `BACKUP_WRITE_FAILED` when the file is already closed.
       */
      function openFd(): number {
         if (fd === null) {
            throw writeFailed(new Error('the backup file is closed'));
         }
         return fd;
      }
      return {
         file,
         filePath,
         append(data: Uint8Array): void {
            // The descriptor.
            const handle: number = openFd();
            try {
               writeAll(handle, data, size);
            } catch (error) {
               throw writeFailed(error);
            }
            size += data.length;
         },
         size(): number {
            return size;
         },
         finish(fields: Omit<BackupHeader, 'wiretapBackup' | 'created' | 'bytes'>): BackupHeader {
            // The descriptor.
            const handle: number = openFd();
            try {
               // The complete header, keys in the written order.
               const header: BackupHeader = {
                  wiretapBackup: BACKUP_FORMAT_VERSION,
                  created: createdAt.toISOString(),
                  worldId: fields.worldId,
                  foundryVersion: fields.foundryVersion,
                  systemId: fields.systemId,
                  systemVersion: fields.systemVersion,
                  note: fields.note,
                  documents: fields.documents,
                  bytes: fs.fstatSync(handle).size,
               };
               writeAll(handle, Buffer.from(formatHeaderLine(header)), 0);
               fd = null;
               fs.closeSync(handle);
               return header;
            } catch (error) {
               throw writeFailed(error);
            }
         },
         close(): void {
            if (fd !== null) {
               // The descriptor being closed.
               const handle: number = fd;
               fd = null;
               try {
                  fs.closeSync(handle);
               } catch (error) {
                  throw writeFailed(error);
               }
            }
         },
      };
   }

   /**
    * Open a backup file by name and check its header and size.
    * @param {ResolvedFolder} folder - The folder.
    * @param {string} file - The file name.
    * @returns {BackupFileReader} The reader, positioned after the header line.
    * @throws {BridgeError} `BACKUP_NOT_FOUND` for an off-pattern or missing name; `BACKUP_INVALID` for a link, a
    *         non-file, a refused header or a size different from the header's.
    */
   function openFile(folder: ResolvedFolder, file: string): BackupFileReader {
      if (!BACKUP_FILE_PATTERN.test(file)) {
         throw new BridgeError(BACKUP_NOT_FOUND, 'No backup file of that name.');
      }
      // The file path.
      const filePath: string = path.join(folder.path, file);
      // The file's own status.
      let stat: fs.Stats;
      try {
         stat = fs.lstatSync(filePath);
      } catch (error) {
         if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new BridgeError(BACKUP_NOT_FOUND, 'No backup file of that name.');
         }
         throw error;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
         throw notABackup();
      }
      // The open descriptor.
      const fd: number = fs.openSync(filePath, 'r');
      // The parsed header.
      let header: BackupHeader;
      try {
         // The header line bytes.
         const line: Buffer = Buffer.alloc(HEADER_LINE_BYTES);
         // The parsed header, or null when refused.
         const parsed: BackupHeader | null = readAll(fd, line, 0) === HEADER_LINE_BYTES
            ? parseHeaderLine(line.toString('utf8'))
            : null;
         if (parsed === null) {
            throw notABackup();
         }
         if (fs.fstatSync(fd).size !== parsed.bytes) {
            throw new BridgeError(BACKUP_INVALID, 'The backup file is incomplete or was changed.');
         }
         header = parsed;
      } catch (error) {
         fs.closeSync(fd);
         throw error;
      }
      // The file offset of the next piece.
      let position: number = HEADER_LINE_BYTES;
      return {
         file,
         header,
         readPiece(maxBytes: number): Buffer | null {
            // The piece buffer.
            const piece: Buffer = Buffer.alloc(maxBytes);
            // Bytes read into it.
            const count: number = readAll(fd, piece, position);
            if (count === 0) {
               return null;
            }
            position += count;
            return piece.subarray(0, count);
         },
         close(): void {
            fs.closeSync(fd);
         },
      };
   }

   /**
    * List a folder's backups, newest first, reading at most `LIST_HEADER_READS_MAX` headers.
    * @param {ResolvedFolder} folder - The folder.
    * @param {number} limit - The most rows to return.
    * @returns {BackupListing} The listing; empty for a missing default folder.
    * @throws {BridgeError} `BACKUP_FOLDER_INVALID` when the folder fails `checkFolder`.
    */
   function list(folder: ResolvedFolder, limit: number): BackupListing {
      // The listing being built.
      const listing: BackupListing = {
         rows: [],
         total: 0,
         invalid: 0,
      };
      if (!checkFolder(folder, false)) {
         return listing;
      }
      // Backup names, newest first: each starts with its UTC creation time.
      const names: string[] = fs.readdirSync(folder.path)
         .filter((name) => BACKUP_FILE_PATTERN.test(name))
         .sort()
         .reverse();
      listing.total = names.length;
      // How many headers are read so far.
      let reads: number = 0;
      for (const name of names) {
         if (listing.rows.length >= limit || reads >= LIST_HEADER_READS_MAX) {
            break;
         }
         reads += 1;
         try {
            // The checked file.
            const reader: BackupFileReader = openFile(folder, name);
            reader.close();
            listing.rows.push([
               name,
               reader.header.created,
               reader.header.documents,
               reader.header.note,
            ]);
         } catch (error) {
            if (!(error instanceof BridgeError)) {
               throw error;
            }
            if (error.code === BACKUP_INVALID) {
               listing.invalid += 1;
            }
         }
      }
      return listing;
   }

   /**
    * Move a path to the recycle bin and confirm nothing is left at it.
    * @param {string} filePath - The path.
    * @returns {Promise<void>} Resolves once the path is gone.
    * @throws {BridgeError} `TRASH_FAILED` naming the file when the recycle bin throws or leaves it in place.
    */
   async function trashPath(filePath: string): Promise<void> {
      // Why the recycle bin failed, or null when it did not throw.
      let reason: string | null = null;
      try {
         await moveToTrash([filePath], { glob: false });
      } catch (error) {
         reason = describeCause(error, TRASH_REASON_MAX_BYTES);
      }
      if (reason === null && inspectPath(filePath) === 'missing') {
         return;
      }
      throw new BridgeError(
         TRASH_FAILED,
         `Could not move ${path.basename(filePath)} to the recycle bin` + (reason ? `: ${reason}` : '') + '.',
      );
   }

   /**
    * Inspect any path with `lstat`, links included.
    * @param {string} target - The path.
    * @returns {'missing' | 'present'} Whether anything is at the path.
    */
   function inspectPath(target: string): 'missing' | 'present' {
      try {
         fs.lstatSync(target);
         return 'present';
      } catch (error) {
         if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
         }
         return 'missing';
      }
   }

   /**
    * Check a backup file by name, then move it to the recycle bin.
    * @param {ResolvedFolder} folder - The folder.
    * @param {string} file - The file name.
    * @returns {Promise<void>} Resolves once the file is gone.
    * @throws {BridgeError} The `openFile` errors, or `TRASH_FAILED`.
    */
   async function trashFile(folder: ResolvedFolder, file: string): Promise<void> {
      openFile(folder, file).close();
      await trashPath(path.join(folder.path, file));
   }

   return {
      defaultFolder,
      resolveFolder,
      checkFolder,
      createFile,
      openFile,
      list,
      trashFile,
      trashPath,
   };
}
