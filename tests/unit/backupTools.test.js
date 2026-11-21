// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createBackupTools, createBackupSink, fitListResult, fitRestoreResult } from '../../server/backupTools.ts';
import { createBackupStore } from '../../server/backups.ts';
import { BridgeError } from '../../server/endpoints.ts';
import {
   BACKUP_FILE_PATTERN,
   HEADER_LINE_BYTES,
   parseHeaderLine,
} from '../../shared/backup.js';
import { ENDPOINT_GONE, OP_BACKUP_EXPORT, OP_BACKUP_RESTORE } from '../../shared/protocol.js';
import { closedGateState } from '../../shared/gates.js';
import { defaultBridgeSettings } from '../../shared/bridgeSettings.js';
import { fakeTrash, scratchRoot } from './backupTestHelpers.js';
import { definitionBytes } from '../../shared/scripts.js';
import { getBudget } from '../../shared/budgets.js';

/** @typedef {import('../../server/backups.ts').BackupStore} BackupStore */
/** @typedef {import('../../server/backups.ts').TrashFunction} TrashFunction */
/** @typedef {import('../../server/endpoints.ts').Endpoint} Endpoint */
/** @typedef {import('../../server/foundryBridge.ts').PieceSink} PieceSink */
/** @typedef {import('../../server/foundryBridge.ts').OutgoingPiece} OutgoingPiece */
/** @typedef {import('../../server/mcp.ts').ToolRegistration} ToolRegistration */

/**
 * @typedef {object} Invocation
 * @property {string} op - The op the tool invoked.
 * @property {object | undefined} params - The params `prepare` returned and the fake sent.
 * @property {string} requestId - The invocation's requestId.
 * @property {PieceSink | undefined} sink - The sink the tool registered for this invocation, if any.
 */

/** @typedef {{ op: string, options: object, sent: boolean, params: object | undefined }} InvokeRecord */

/** @typedef {{ seq: number, data?: Buffer, end?: true, pieces?: number, bytes?: number }} Piece */

/** @typedef {{ worldId: string, foundryVersion: string, systemId: string, systemVersion: string }} World */

/**
 * @typedef {object} FakeBridge
 * @property {Endpoint | undefined} endpoint - The endpoint every call reaches; undefined for none.
 * @property {(invocation: Invocation) => Promise<unknown>} behaviour - The fake client: runs after `onSent`.
 * @property {InvokeRecord[]} calls - Each invoke.
 * @property {number} sinkCount - How many sinks were registered.
 * @property {Map<string, PieceSink>} sinks - The registered sinks by `<socketId>/<requestId>`.
 * @property {OutgoingPiece[]} sentPieces - Every restore piece sent, in order.
 * @property {(piece: OutgoingPiece) => Promise<void>} onPiece - Answers each restore piece; resolves by default.
 * @property {Promise<void>} ended - Resolves once the restore end marker was sent.
 */

/** @type {number} Counter that keeps the fake clock moving and every file suffix unique. */
let tick = 0;

/**
 * Build a GM endpoint with every gate closed and the default settings.
 * @returns {Endpoint} A healthy agent endpoint on socket `socket-1`.
 */
function makeEndpoint() {
   return {
      socketId: 'socket-1',
      userId: 'MOCK_USER_A',
      userName: 'MOCK_GM',
      kind: 'agent',
      dom: false,
      gateState: closedGateState(),
      settings: defaultBridgeSettings(),
      health: 'healthy',
      registeredAt: 0,
      tools: [],
   };
}

/**
 * Build the fake bridge: `invoke` runs `prepare` on the fake endpoint, calls `onSent`, and then lets the configured
 * fake client answer.
 * @returns {FakeBridge & import('../../server/backupTools.ts').BackupBridge} The fake bridge.
 */
function makeBridge() {
   /** @type {(() => void) | undefined} Resolves `ended` once the restore end marker is sent. */
   let resolveEnded;
   /** @type {FakeBridge & import('../../server/backupTools.ts').BackupBridge} The fake. */
   const bridge = {
      endpoint: makeEndpoint(),
      behaviour: async () => ({}),
      calls: [],
      sinkCount: 0,
      sinks: new Map(),
      sentPieces: [],
      onPiece: async () => {},
      ended: new Promise((resolve) => {
         resolveEnded = resolve;
      }),
      async invoke(op, params, options = {}) {
         /** @type {InvokeRecord} The record of this invoke. */
         const call = {
            op,
            options,
            sent: false,
            params: undefined,
         };
         bridge.calls.push(call);
         if (bridge.endpoint === undefined) {
            throw new BridgeError('NO_ENDPOINT', 'No Foundry GM client is connected.');
         }
         /** @type {string} The requestId of this invocation. */
         const requestId = `request-${bridge.calls.length}`;
         call.params = options.prepare?.(bridge.endpoint, requestId) ?? params;
         call.sent = true;
         options.onSent?.();
         return bridge.behaviour({
            op,
            params: call.params,
            requestId,
            sink: bridge.sinks.get(`${bridge.endpoint.socketId}/${requestId}`),
         });
      },
      snapshot() {
         if (bridge.endpoint === undefined) {
            return undefined;
         }
         return {
            socketId: bridge.endpoint.socketId,
            gateState: { ...bridge.endpoint.gateState },
            settings: { ...bridge.endpoint.settings },
         };
      },
      expectPieces(socketId, requestId, sink) {
         bridge.sinkCount += 1;
         bridge.sinks.set(`${socketId}/${requestId}`, sink);
         return () => {
            bridge.sinks.delete(`${socketId}/${requestId}`);
         };
      },
      async sendPiece(socketId, piece) {
         bridge.sentPieces.push(piece);
         await bridge.onPiece(piece);
         if ('end' in piece) {
            resolveEnded?.();
         }
      },
   };
   return bridge;
}

/**
 * @typedef {object} Fixture
 * @property {string} root - The scratch root holding `.wiretap/`.
 * @property {ReturnType<typeof fakeTrash>} trash - The fake recycle bin.
 * @property {BackupStore} store - The real store over the scratch root.
 * @property {ReturnType<typeof makeBridge>} bridge - The fake bridge.
 * @property {string[]} logs - The tools' log lines.
 * @property {ToolRegistration[]} tools - The registrations for a session with no endpoint restriction.
 * @property {(name: string, args: object) => Promise<Record<string, unknown>>} call - Runs a tool by name.
 */

/**
 * Build the store, the fake bridge and the tools.
 * @param {{ trash?: TrashFunction }} [options] - A recycle bin to use instead of the fake one.
 * @returns {Fixture} The fixture.
 */
function setup(options = {}) {
   /** @type {string} The scratch root. */
   const root = scratchRoot('backupTools');
   /** @type {ReturnType<typeof fakeTrash>} The fake recycle bin. */
   const trash = fakeTrash(path.join(root, 'bin'));
   /** @type {BackupStore} The real store over the scratch root. */
   const store = createBackupStore({
      root,
      trash: options.trash ?? trash,
      now: () => new Date(Date.UTC(2026, 10, 21, 0, 0, 0, 0) + (tick += 1)),
      randomSuffix: () => `s${String(tick).padStart(7, '0')}`,
   });
   /** @type {ReturnType<typeof makeBridge>} The fake bridge. */
   const bridge = makeBridge();
   /** @type {string[]} The log lines. */
   const logs = [];
   /** @type {ToolRegistration[]} The registrations. */
   const tools = createBackupTools({
      bridge,
      store,
      log: (line) => logs.push(line),
   })(undefined);
   return {
      root,
      trash,
      store,
      bridge,
      logs,
      tools,
      call: (name, args) => callTool(tools, name, args),
   };
}

/**
 * Run a tool's handler and parse its text.
 * @param {ToolRegistration[]} tools - The registrations.
 * @param {string} name - Which registration to run.
 * @param {object} args - The arguments.
 * @returns {Promise<Record<string, unknown>>} The parsed result, or `{ error }` for a thrown BridgeError.
 */
async function callTool(tools, name, args) {
   /** @type {ToolRegistration | undefined} The registration of that name. */
   const tool = tools.find((candidate) => candidate.name === name);
   if (tool === undefined) {
      throw new Error(`no tool ${name}`);
   }
   try {
      /** @type {import('@modelcontextprotocol/sdk/types.js').CallToolResult} What the handler returned. */
      const result = await tool.handler(/** @type {never} */ (args));
      /** @type {string} The JSON text of the first content item. */
      const text = /** @type {{ text: string }} */ (result.content[0]).text;
      return {
         ...JSON.parse(text),
         __bytes: Buffer.byteLength(text, 'utf8'),
      };
   } catch (error) {
      if (error instanceof BridgeError) {
         return { error: `${error.code}: ${error.message}` };
      }
      throw error;
   }
}

/**
 * Feed data pieces and an end marker to a sink as the client does, stopping at the first refused piece.
 * @param {PieceSink} sink - The sink the tool registered.
 * @param {Piece[]} pieces - Data pieces, then the end marker.
 * @returns {Promise<BridgeError | undefined>} The refusal, if a piece was refused.
 */
async function feed(sink, pieces) {
   for (const piece of pieces) {
      try {
         await sink.piece(piece);
      } catch (error) {
         return /** @type {BridgeError} */ (error);
      }
   }
   return undefined;
}

/**
 * Build the data pieces and the end marker of a stream of document lines, one line per piece.
 * @param {string[]} lines - The lines, each with its newline.
 * @returns {Piece[]} The pieces.
 */
function streamOf(lines) {
   /** @type {Buffer[]} One buffer per line. */
   const data = lines.map((line) => Buffer.from(line));
   /** @type {number} The data byte total. */
   const bytes = data.reduce((sum, piece) => sum + piece.length, 0);
   return [
      ...data.map((piece, seq) => ({
         seq,
         data: piece,
      })),
      {
         seq: data.length,
         end: true,
         pieces: data.length,
         bytes,
      },
   ];
}

/** @type {World} The world the fake client reports. */
const WORLD = {
   worldId: 'mock-world',
   foundryVersion: '14.364',
   systemId: 'mock-system',
   systemVersion: '1.0.0',
};

/** @type {string[]} Two synthetic document lines. */
const LINES = [
   '{"uuid":"Actor.MOCKACTOR0000001","documentName":"Actor","data":{"name":"MOCK_A"}}\n',
   '{"uuid":"Actor.MOCKACTOR0000002","documentName":"Actor","data":{"name":"MOCK_B"}}\n',
];

/**
 * Make the fake client stream the given pieces and answer with a result computed from what it streamed.
 * @param {Fixture} fixture - The store, fake bridge and tools.
 * @param {Piece[]} pieces - The stream.
 * @param {(bytes: number) => object} result - Builds the client result from the data byte total.
 * @returns {void}
 */
function clientStreams(fixture, pieces, result) {
   fixture.bridge.behaviour = async ({ sink }) => {
      /** @type {BridgeError | undefined} A refusal. */
      const refused = sink === undefined ? undefined : await feed(sink, pieces);
      if (refused !== undefined) {
         throw new BridgeError('PIECE_REFUSED', 'The sidecar refused a backup piece.');
      }
      /** @type {number} The data bytes. */
      const bytes = pieces.reduce((sum, piece) => sum + (piece.data?.length ?? 0), 0);
      return result(bytes);
   };
}

/**
 * List the backup files in a directory.
 * @param {string} dir - The directory.
 * @returns {string[]} The backup file names; empty when the directory is missing.
 */
function backupFiles(dir) {
   return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => BACKUP_FILE_PATTERN.test(name)) : [];
}

/**
 * Write a valid backup file through the store.
 * @param {BackupStore} store - The store that writes the file.
 * @param {string} folderPath - The folder, or the default when omitted.
 * @param {{ lines?: string[], note?: string }} [content] - The document lines and the note.
 * @returns {string} The file name.
 */
function writeBackup(store, folderPath = store.defaultFolder, content = {}) {
   /** @type {import('../../server/backups.ts').ResolvedFolder} The folder the file goes to. */
   const folder = {
      path: folderPath,
      kind: folderPath === store.defaultFolder ? 'default' : 'named',
   };
   store.checkFolder(folder, true);
   /** @type {import('../../server/backups.ts').BackupFileWriter} The new file. */
   const writer = store.createFile(folder);
   /** @type {string[]} The document lines to write. */
   const lines = content.lines ?? LINES;
   for (const line of lines) {
      writer.append(Buffer.from(line));
   }
   writer.finish({
      ...WORLD,
      note: content.note ?? '',
      documents: lines.length,
   });
   return writer.file;
}

/** @type {'junction' | 'dir'} The directory link type that needs no administrator rights on this platform. */
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * Write a valid backup into a real directory and reach it through links: a named folder that is a link to it, and a
 * `.wiretap` that is a link to its parent, so the default folder resolves to it too.
 * @param {Fixture} fixture - The store, fake bridge and tools.
 * @returns {{ link: string, target: string, file: string }} The linked named folder, the real folder and the file.
 */
function linkedFolders(fixture) {
   /** @type {string} The real directory standing in for `.wiretap`. */
   const realWiretap = path.join(fixture.root, 'real-wiretap');
   /** @type {string} The real folder holding the backup. */
   const target = path.join(realWiretap, 'backups');
   fs.mkdirSync(target, { recursive: true });
   /** @type {string} The backup. */
   const file = writeBackup(fixture.store, target);
   /** @type {string} A named folder that links to the real folder. */
   const link = path.join(fixture.root, 'link');
   fs.symlinkSync(target, link, DIR_LINK);
   fs.symlinkSync(realWiretap, path.join(fixture.root, '.wiretap'), DIR_LINK);
   return {
      link,
      target,
      file,
   };
}

/** @type {object} A restore result with every field the client restore always sends. */
const RESTORE_RESULT = {
   replaced: 1,
   created: 1,
   skipped: 0,
   failed: 0,
   rows: [
      [
         'Actor.MOCKACTOR0000002',
         'created',
         'FOLDER_GONE: restored outside its folder.',
      ],
      [
         'Actor.MOCKACTOR0000001',
         'replaced',
      ],
   ],
   secretLost: 0,
};

describe('backup tool definitions', () => {
   it('lists each definition within DEFINITION_MAX_BYTES, measured as the MCP SDK lists it', () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {number} The per-definition budget. */
      const limit = getBudget('DEFINITION_MAX_BYTES').value;
      expect(fixture.tools.map((tool) => tool.name)).toEqual([
         'backup_documents',
         'list_backups',
         'restore_backup',
         'delete_backup',
      ]);
      for (const tool of fixture.tools) {
         /** @type {unknown} The input schema as the SDK converts a raw shape for `tools/list`. */
         const listed = z.toJSONSchema(z.object(tool.inputSchema), {
            target: 'draft-7',
            io: 'input',
         });
         expect(definitionBytes(tool.name, tool.description, listed), tool.name).toBeLessThanOrEqual(limit);
      }
   });
});

describe('backup_documents arguments', () => {
   it('refuses no selector and two selectors with ARGS_INVALID', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} The expected refusal. */
      const refusal = 'ARGS_INVALID: Give exactly one of uuids, folderUuid, documentName or pack.';
      expect(await fixture.call('backup_documents', {})).toEqual({ error: refusal });
      expect(await fixture.call('backup_documents', {
         uuids: ['Actor.MOCKACTOR0000001'],
         pack: 'world.mock',
      })).toEqual({ error: refusal });
      expect(await fixture.call('backup_documents', {
         folderUuid: 'Folder.MOCKFOLDER000001',
         documentName: 'Actor',
      })).toEqual({ error: refusal });
      expect(fixture.bridge.calls).toHaveLength(0);
   });

   it('refuses a note over 200 bytes or with a control character', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} The expected refusal. */
      const refusal = 'ARGS_INVALID: note must be at most 200 bytes with no control characters.';
      expect(await fixture.call('backup_documents', {
         documentName: 'Actor',
         note: 'x'.repeat(201),
      })).toEqual({ error: refusal });
      expect(await fixture.call('backup_documents', {
         documentName: 'Actor',
         note: 'line\nbreak',
      })).toEqual({ error: refusal });
      expect(fixture.bridge.calls).toHaveLength(0);
   });
});

describe('backup_documents', () => {
   it('writes the file from the pieces and finishes the header from the client result', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      clientStreams(fixture, streamOf(LINES), (bytes) => ({
         documents: 2,
         bytes: HEADER_LINE_BYTES + bytes,
         unreadable: 0,
         parents: 0,
         world: WORLD,
      }));
      /** @type {Record<string, unknown>} The parsed tool result. */
      const result = await fixture.call('backup_documents', {
         uuids: ['Actor.MOCKACTOR0000001', 'Actor.MOCKACTOR0000002'],
         note: 'n',
      });
      /** @type {string} The data bytes. */
      const data = LINES.join('');
      expect(result).toEqual({
         file: expect.stringMatching(BACKUP_FILE_PATTERN),
         folder: 'default',
         documents: 2,
         bytes: HEADER_LINE_BYTES + Buffer.byteLength(data),
         __bytes: expect.any(Number),
      });
      expect(result.__bytes).toBeLessThanOrEqual(256);
      expect(fixture.bridge.calls[0].op).toBe(OP_BACKUP_EXPORT);
      expect(fixture.bridge.calls[0].options.replyWaitMs).toBe(122_000);
      expect(fixture.bridge.calls[0].params).toEqual({
         uuids: ['Actor.MOCKACTOR0000001', 'Actor.MOCKACTOR0000002'],
         timeoutMs: 120_000,
      });
      /** @type {string} Where the backup was written. */
      const filePath = path.join(fixture.store.defaultFolder, /** @type {string} */ (result.file));
      /** @type {Buffer} The file. */
      const content = fs.readFileSync(filePath);
      expect(content.length).toBe(result.bytes);
      /** @type {import('../../shared/backup.js').BackupHeader | null} The parsed header line. */
      const header = parseHeaderLine(content.subarray(0, HEADER_LINE_BYTES).toString('utf8'));
      expect(header).toMatchObject({
         documents: 2,
         note: 'n',
         worldId: 'mock-world',
         systemId: 'mock-system',
         bytes: content.length,
      });
      expect(content.subarray(HEADER_LINE_BYTES).toString('utf8')).toBe(data);
      expect(fixture.bridge.sinks.size).toBe(0);
   });

   it('passes the selector, dry run and timeoutMs and routes to the session endpoint kind', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {ToolRegistration[]} The tools of a session restricted to human endpoints. */
      const tools = createBackupTools({
         bridge: fixture.bridge,
         store: fixture.store,
      })('human');
      fixture.bridge.behaviour = async () => ({
         documents: 1,
         bytes: 3000,
         unreadable: 0,
         parents: 0,
      });
      await callTool(tools, 'backup_documents', {
         pack: 'world.mock',
         dryRun: true,
         timeoutMs: 5000,
      });
      expect(fixture.bridge.calls[0].options).toMatchObject({
         endpoint: 'human',
         replyWaitMs: 7000,
      });
      expect(fixture.bridge.calls[0].params).toEqual({
         pack: 'world.mock',
         dryRun: true,
         timeoutMs: 5000,
      });
      await fixture.call('list_backups', {});
      expect(fixture.bridge.calls).toHaveLength(1);
   });

   it('a dry run sends no sink, creates no folder and returns the measurement', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      fixture.bridge.behaviour = async () => ({
         documents: 2,
         bytes: 3000,
         unreadable: 1,
         parents: 0,
      });
      /** @type {Record<string, unknown>} The parsed tool result. */
      const result = await fixture.call('backup_documents', {
         documentName: 'Actor',
         dryRun: true,
      });
      expect(result).toEqual({
         dryRun: true,
         folder: 'default',
         documents: 2,
         bytes: 3000,
         unreadable: 1,
         __bytes: expect.any(Number),
      });
      expect(fixture.bridge.sinkCount).toBe(0);
      expect(fs.existsSync(path.join(fixture.root, '.wiretap'))).toBe(false);
      expect(fixture.bridge.calls[0].params).toEqual({
         documentName: 'Actor',
         dryRun: true,
         timeoutMs: 120_000,
      });
   });

   it('refuses a dry run whose client counts are not non-negative integers', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      fixture.bridge.behaviour = async () => ({
         documents: 2,
         bytes: 3000,
         unreadable: -1,
         parents: 0,
      });
      expect(await fixture.call('backup_documents', {
         documentName: 'Actor',
         dryRun: true,
      })).toEqual({
         error: 'BACKUP_INCOMPLETE: The Foundry client sent a result that does not match the pieces it sent.',
      });
   });

   it('writes to the setting folder without the gate and needs allowBackupAnyFolder for a named folder', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} The setting folder. */
      const settingDir = path.join(fixture.root, 'setting');
      /** @type {string} A folder the call names. */
      const namedDir = path.join(fixture.root, 'named');
      fs.mkdirSync(settingDir);
      fs.mkdirSync(namedDir);
      /** @type {Endpoint} The fake bridge's endpoint, changed in place. */
      const endpoint = /** @type {Endpoint} */ (fixture.bridge.endpoint);
      endpoint.settings.backupFolder = settingDir;
      clientStreams(fixture, streamOf(LINES), (bytes) => ({
         documents: 2,
         bytes: HEADER_LINE_BYTES + bytes,
         unreadable: 0,
         parents: 0,
         world: WORLD,
      }));
      /** @type {Record<string, unknown>} The setting-folder result. */
      const toSetting = await fixture.call('backup_documents', { documentName: 'Actor' });
      expect(toSetting.folder).toBe('setting');
      expect(backupFiles(settingDir)).toEqual([toSetting.file]);

      /** @type {Record<string, unknown>} The refused named-folder call. */
      const refused = await fixture.call('backup_documents', {
         documentName: 'Actor',
         folder: namedDir,
      });
      expect(refused.error).toMatch(/^GATE_DENIED: .*allowBackupAnyFolder/);
      expect(fixture.bridge.calls[1].sent).toBe(false);
      expect(fixture.bridge.calls[1].params).toBeUndefined();
      expect(backupFiles(namedDir)).toEqual([]);

      endpoint.gateState.allowBackupAnyFolder = true;
      /** @type {Record<string, unknown>} The named-folder result with the gate open. */
      const toNamed = await fixture.call('backup_documents', {
         documentName: 'Actor',
         folder: namedDir,
      });
      expect(toNamed.folder).toBe('named');
      expect(backupFiles(namedDir)).toEqual([toNamed.file]);
   });

   it('refuses an out-of-order piece, a short end marker and a result whose documents differ from the lines',
      async () => {
         /** @type {Fixture} The store, fake bridge and tools under test. */
         const fixture = setup();
         /** @type {string} The mismatch refusal. */
         const mismatch = 'BACKUP_INCOMPLETE: The Foundry client sent a result that does not match the pieces it sent.';
         /** @type {Piece[]} The stream. */
         const good = streamOf(LINES);
         /**
          * Build a client result that matches the stream.
          * @param {number} bytes - The data byte total.
          * @returns {object} The client result.
          */
         const result = (bytes) => ({
            documents: 2,
            bytes: HEADER_LINE_BYTES + bytes,
            unreadable: 0,
            parents: 0,
            world: WORLD,
         });

         clientStreams(fixture, [
            good[0],
            {
               ...good[1],
               seq: 2,
            },
         ], result);
         expect(await fixture.call('backup_documents', { documentName: 'Actor' })).toEqual({
            error: 'BACKUP_INCOMPLETE: A backup piece arrived out of order.',
         });

         clientStreams(fixture, [
            good[0],
            good[1],
            {
               seq: 2,
               end: true,
               pieces: 1,
               bytes: good[0].data?.length,
            },
         ], result);
         expect((await fixture.call('backup_documents', { documentName: 'Actor' })).error)
            .toMatch(/^BACKUP_INCOMPLETE: /);

         clientStreams(fixture, good, (bytes) => ({
            ...result(bytes),
            documents: 3,
         }));
         expect(await fixture.call('backup_documents', { documentName: 'Actor' })).toEqual({ error: mismatch });

         clientStreams(fixture, good.slice(0, 2), result);
         expect(await fixture.call('backup_documents', { documentName: 'Actor' })).toEqual({ error: mismatch });

         clientStreams(fixture, good, (bytes) => ({
            ...result(bytes),
            bytes: HEADER_LINE_BYTES + bytes + 1,
         }));
         expect(await fixture.call('backup_documents', { documentName: 'Actor' })).toEqual({ error: mismatch });

         clientStreams(fixture, good, (bytes) => ({
            ...result(bytes),
            world: {
               ...WORLD,
               worldId: 'bad\u0000id',
            },
         }));
         expect(await fixture.call('backup_documents', { documentName: 'Actor' })).toEqual({ error: mismatch });

         expect(fixture.trash.calls).toHaveLength(6);
         for (const [filePath] of fixture.trash.calls) {
            expect(path.dirname(filePath)).toBe(fixture.store.defaultFolder);
            expect(path.basename(filePath)).toMatch(BACKUP_FILE_PATTERN);
         }
         expect(backupFiles(fixture.store.defaultFolder)).toEqual([]);
      });

   it('saves 10000 documents as a listable backup and refuses 10001 with BACKUP_TOO_LARGE, trashing the file',
      async () => {
         /** @type {Fixture} The store, fake bridge and tools under test. */
         const fixture = setup();
         /**
          * Stream `count` short document lines in one piece and answer with a result that matches them.
          * @param {number} count - The document lines.
          * @returns {void}
          */
         const streamLines = (count) => {
            clientStreams(fixture, streamOf(['{"uuid":"Actor.MOCKACTOR0000001"}\n'.repeat(count)]), (bytes) => ({
               documents: count,
               bytes: HEADER_LINE_BYTES + bytes,
               unreadable: 0,
               parents: 0,
               world: WORLD,
            }));
         };

         streamLines(10_000);
         /** @type {Record<string, unknown>} The saved backup. */
         const saved = await fixture.call('backup_documents', { documentName: 'Actor' });
         expect(saved.documents).toBe(10_000);
         expect(await fixture.call('list_backups', {})).toMatchObject({
            rows: [[saved.file, expect.any(String), 10_000, '']],
            total: 1,
         });

         streamLines(10_001);
         expect(await fixture.call('backup_documents', { documentName: 'Actor' })).toEqual({
            error: 'BACKUP_TOO_LARGE: The backup would exceed 10000 documents.',
         });
         expect(fixture.trash.calls).toHaveLength(1);
         expect(backupFiles(fixture.store.defaultFolder)).toEqual([saved.file]);
      });

   it('names the partial file when the recycle bin refuses it', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup({
         trash: async () => {
            throw new Error('no recycle bin');
         },
      });
      clientStreams(fixture, [
         streamOf(LINES)[0],
         {
            seq: 5,
            data: Buffer.from(LINES[1]),
         },
      ], () => ({}));
      /** @type {Record<string, unknown>} The parsed tool result. */
      const result = await fixture.call('backup_documents', { documentName: 'Actor' });
      /** @type {string[]} The partial file left in place. */
      const left = backupFiles(fixture.store.defaultFolder);
      expect(left).toHaveLength(1);
      expect(result.error).toBe(
         'BACKUP_INCOMPLETE: A backup piece arrived out of order. '
            + `The partial file ${left[0]} could not be moved to the recycle bin.`,
      );
   });

   it('reports ENDPOINT_GONE when the client disconnects mid-backup and trashes the partial file', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      fixture.bridge.behaviour = async ({ sink }) => {
         await feed(/** @type {PieceSink} */ (sink), [streamOf(LINES)[0]]);
         /** @type {PieceSink} */ (sink).gone();
         throw new BridgeError(ENDPOINT_GONE, 'The Foundry endpoint disconnected before it answered.');
      };
      expect(await fixture.call('backup_documents', { documentName: 'Actor' })).toEqual({
         error: 'ENDPOINT_GONE: The Foundry endpoint disconnected during the backup; nothing was saved.',
      });
      expect(fixture.trash.calls).toHaveLength(1);
      expect(backupFiles(fixture.store.defaultFolder)).toEqual([]);
   });

   it('fails with the client error when no piece arrived and leaves no file', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      fixture.bridge.behaviour = async () => {
         throw new BridgeError('BACKUP_EMPTY', 'Nothing to back up: the selection holds no readable document.');
      };
      expect(await fixture.call('backup_documents', { documentName: 'Actor' })).toEqual({
         error: 'BACKUP_EMPTY: Nothing to back up: the selection holds no readable document.',
      });
      expect(fixture.trash.calls).toHaveLength(0);
      expect(backupFiles(fixture.store.defaultFolder)).toEqual([]);
   });
});

describe('createBackupSink', () => {
   it('createBackupSink refuses received bytes over 64000000 with BACKUP_TOO_LARGE', async () => {
      /** @type {number} Bytes the fake writer received. */
      let appended = 0;
      /** @type {import('../../server/backups.ts').BackupFileWriter} A writer that only counts. */
      const writer = {
         file: 'counting',
         filePath: 'counting',
         append(data) {
            appended += data.length;
         },
         size: () => HEADER_LINE_BYTES + appended,
         finish: () => {
            throw new Error('not finished in this test');
         },
         close: () => {},
      };
      /** @type {import('../../server/backupTools.ts').BackupSink} The sink under test. */
      const sink = createBackupSink(() => writer);
      /** @type {Buffer} One full piece, reused. */
      const piece = Buffer.alloc(512_000);
      for (let seq = 0; seq < 124; seq += 1) {
         await sink.piece({
            seq,
            data: piece,
         });
      }
      expect(appended).toBe(63_488_000);
      /** @type {unknown} The refusal of piece 125. */
      const refusal = await Promise.resolve(sink.piece({
         seq: 124,
         data: piece,
      })).catch((error) => error);
      expect(refusal).toBeInstanceOf(BridgeError);
      expect(/** @type {BridgeError} */ (refusal).code).toBe('BACKUP_TOO_LARGE');
      expect(sink.failure()).toBe(refusal);
      expect(appended).toBe(63_488_000);
      /** @type {unknown} The refusal of a later piece. */
      const later = await Promise.resolve(sink.piece({
         seq: 125,
         data: Buffer.from('x'),
      })).catch((error) => error);
      expect(later).toBe(refusal);
      expect(sink.writer()).toBe(writer);
      expect(sink.counts()).toEqual({
         pieces: 124,
         bytes: 63_488_000,
         lines: 0,
         ended: false,
      });
   });

   it('counts newline bytes and accepts a matching end marker', async () => {
      /** @type {import('../../server/backupTools.ts').BackupSink} The sink under test. */
      const sink = createBackupSink(() => /** @type {never} */ ({
         append: () => {},
         size: () => 0,
      }));
      expect(sink.writer()).toBeUndefined();
      expect(await feed(sink, streamOf(['{"a":1}\n{"b":2}\n', '{"c":3}\n']))).toBeUndefined();
      expect(sink.counts()).toEqual({
         pieces: 2,
         bytes: 24,
         lines: 3,
         ended: true,
      });
      sink.gone();
      expect(sink.failure()?.code).toBe(ENDPOINT_GONE);
   });
});

describe('backup lock', () => {
   it('refuses a second backup or restore and a delete while one runs, and lists meanwhile', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} A backup to restore and delete. */
      const file = writeBackup(fixture.store);
      /** @type {(() => void) | undefined} Lets the running backup finish. */
      let release;
      fixture.bridge.behaviour = () => new Promise((resolve) => {
         release = () => resolve({
            documents: 1,
            bytes: 3000,
            unreadable: 0,
            parents: 0,
         });
      });
      /** @type {Promise<Record<string, unknown>>} The running dry run. */
      const running = fixture.call('backup_documents', {
         documentName: 'Actor',
         dryRun: true,
      });
      /** @type {string} The busy refusal. */
      const busy = 'BACKUP_BUSY: A backup or restore is already running; retry when it ends.';
      expect(await fixture.call('backup_documents', {
         documentName: 'Actor',
         dryRun: true,
      })).toEqual({ error: busy });
      expect(await fixture.call('restore_backup', { file })).toEqual({ error: busy });
      expect(await fixture.call('delete_backup', { file })).toEqual({ error: busy });
      expect((await fixture.call('list_backups', {})).rows).toHaveLength(1);
      expect(fixture.bridge.calls).toHaveLength(1);
      release?.();
      expect((await running).dryRun).toBe(true);
      expect(await fixture.call('delete_backup', { file })).toMatchObject({
         file,
         trashed: true,
      });
   });
});

describe('restore_backup', () => {
   it('restore opens the file in prepare and pumps its bytes after the header in order, then the end marker',
      async () => {
         /** @type {Fixture} The store, fake bridge and tools under test. */
         const fixture = setup();
         /** @type {string[]} Three lines of about 300 KB each, so the file needs two pieces. */
         const lines = ['a', 'b', 'c'].map((letter) => `{"x":"${letter.repeat(300_000)}"}\n`);
         /** @type {string} The backup. */
         const file = writeBackup(fixture.store, fixture.store.defaultFolder, { lines });
         /** @type {Buffer} The file's document bytes. */
         const body = fs.readFileSync(path.join(fixture.store.defaultFolder, file)).subarray(HEADER_LINE_BYTES);
         /** @type {number} Reader closes seen. */
         let closes = 0;
         /** @type {BackupStore['openFile']} The real open. */
         const open = fixture.store.openFile;
         fixture.store.openFile = (folder, name) => {
            /** @type {import('../../server/backups.ts').BackupFileReader} The real reader. */
            const reader = open(folder, name);
            return {
               ...reader,
               readPiece: reader.readPiece,
               close: () => {
                  closes += 1;
                  reader.close();
               },
            };
         };
         fixture.bridge.behaviour = async () => {
            await fixture.bridge.ended;
            return {
               replaced: 3,
               created: 0,
               skipped: 0,
               failed: 0,
               rows: [],
               secretLost: 0,
            };
         };
         /** @type {Record<string, unknown>} The parsed tool result. */
         const result = await fixture.call('restore_backup', {
            file,
            uuids: ['Actor.MOCKACTOR0000001'],
         });
         expect(Object.keys(result)[0]).toBe('file');
         expect(result).toMatchObject({
            file,
            replaced: 3,
            rows: [],
         });
         /** @type {InvokeRecord} The invoke. */
         const call = fixture.bridge.calls[0];
         expect(call.op).toBe(OP_BACKUP_RESTORE);
         expect(call.params).toMatchObject({
            header: {
               documents: 3,
               worldId: 'mock-world',
            },
            uuids: ['Actor.MOCKACTOR0000001'],
            timeoutMs: 120_000,
         });
         /** @type {OutgoingPiece[]} The restore pieces the pump sent. */
         const pieces = fixture.bridge.sentPieces;
         expect(pieces.map((piece) => piece.seq)).toEqual([0, 1, 2]);
         expect(pieces.every((piece) => piece.requestId === 'request-1')).toBe(true);
         /** @type {Buffer} The data the pump sent. */
         const sent = Buffer.concat(pieces.slice(0, 2).map((piece) => /** @type {{ data: Buffer }} */ (piece).data));
         expect(sent.equals(body)).toBe(true);
         expect(/** @type {{ data: Buffer }} */ (pieces[0]).data.length).toBe(512_000);
         expect(pieces[2]).toEqual({
            requestId: 'request-1',
            seq: 2,
            end: true,
            pieces: 2,
            bytes: body.length,
         });
         await new Promise((resolve) => setImmediate(resolve));
         expect(closes).toBe(1);
      });

   it('stops the pump on a refused piece, logs it and returns the client outcome', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} The backup. */
      const file = writeBackup(fixture.store);
      fixture.bridge.onPiece = async () => {
         throw new BridgeError('PIECE_REFUSED', 'The Foundry client refused a restore piece: ARGS_INVALID.');
      };
      fixture.bridge.behaviour = async () => {
         await new Promise((resolve) => setImmediate(resolve));
         throw new BridgeError('ARGS_INVALID', 'The backup is of another world.');
      };
      expect(await fixture.call('restore_backup', { file })).toEqual({
         error: 'ARGS_INVALID: The backup is of another world.',
      });
      expect(fixture.bridge.sentPieces).toHaveLength(1);
      expect(fixture.logs.some((line) => line.includes('PIECE_REFUSED'))).toBe(true);
   });

   it('restore of an off-pattern or invalid file fails before anything is sent', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      writeBackup(fixture.store);
      expect((await fixture.call('restore_backup', { file: '../escape.wtbackup.jsonl' })).error)
         .toMatch(/^BACKUP_NOT_FOUND: /);
      /** @type {string} A file with a backup name and a broken header. */
      const broken = '20261121T000000000Z-brokenaa.wtbackup.jsonl';
      fs.writeFileSync(path.join(fixture.store.defaultFolder, broken), 'not a header\n');
      expect((await fixture.call('restore_backup', { file: broken })).error).toMatch(/^BACKUP_INVALID: /);
      expect(fixture.bridge.calls.every((call) => !call.sent)).toBe(true);
      expect(fixture.bridge.sentPieces).toHaveLength(0);
   });

   it('restore maps ENDPOINT_GONE to the partly applied message', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} The backup. */
      const file = writeBackup(fixture.store);
      fixture.bridge.behaviour = async () => {
         throw new BridgeError(ENDPOINT_GONE, 'The Foundry endpoint disconnected before it answered.');
      };
      expect(await fixture.call('restore_backup', { file })).toEqual({
         error: 'ENDPOINT_GONE: The Foundry endpoint disconnected during the restore; the restore may be partly '
            + 'applied.',
      });
   });

   it('fits a restore result to 4000 bytes, dropping rows from the end and setting cut', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} The backup. */
      const file = writeBackup(fixture.store);
      /** @type {string[][]} Twenty rows of 250-byte uuids. */
      const rows = Array.from({ length: 20 }, (_, index) => [
         `Actor.${String(index).padStart(244, '0')}`,
         'replaced',
      ]);
      fixture.bridge.behaviour = async () => ({
         replaced: 20,
         created: 0,
         skipped: 0,
         failed: 0,
         rows,
         secretLost: 0,
      });
      /** @type {Record<string, unknown>} The parsed tool result. */
      const result = await fixture.call('restore_backup', { file });
      expect(result.__bytes).toBeLessThanOrEqual(4000);
      expect(result.cut).toBe(true);
      expect(Object.keys(result)[0]).toBe('file');
      /** @type {string[][]} The kept rows. */
      const kept = /** @type {string[][]} */ (result.rows);
      expect(kept.length).toBeLessThan(20);
      expect(kept).toEqual(rows.slice(0, kept.length));
   });

   it('returns the result the client restore sends after a Foundry or system update, differences included',
      async () => {
         /** @type {Fixture} The store, fake bridge and tools under test. */
         const fixture = setup();
         /** @type {string} The backup. */
         const file = writeBackup(fixture.store);
         /** @type {object} A dry run's result as `restoreBackup` of the client builds it, every optional field set. */
         const clientResult = {
            ...RESTORE_RESULT,
            secretLost: 1,
            differences: [
               'foundryVersion: 13.351 -> 14.364',
               'systemId: mock-system -> mock-system-b',
               'systemVersion: 1.0.0 -> 1.1.0',
            ],
            dryRun: true,
         };
         fixture.bridge.behaviour = async () => clientResult;
         expect(await fixture.call('restore_backup', {
            file,
            dryRun: true,
         })).toEqual({
            file,
            ...clientResult,
            __bytes: expect.any(Number),
         });
      });

   it('refuses a malformed restore result with BACKUP_INCOMPLETE', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} The backup. */
      const file = writeBackup(fixture.store);
      /** @type {string} A difference of the longest kind the client builds. */
      const difference = `foundryVersion: ${'v'.repeat(64)} -> ${'w'.repeat(64)}`;
      /** @type {object[]} Client results the client restore cannot send, each one change away from a real one. */
      const malformed = [
         {
            ...RESTORE_RESULT,
            rows: Array.from({ length: 21 }, () => ['Actor.MOCKACTOR0000001', 'replaced']),
         },
         {
            ...RESTORE_RESULT,
            replaced: -1,
         },
         {
            ...RESTORE_RESULT,
            rows: [['Actor.MOCKACTOR0000001', 'failed', 'r'.repeat(300)]],
         },
         {
            ...RESTORE_RESULT,
            secretLost: undefined,
         },
         {
            ...RESTORE_RESULT,
            extra: 'text',
         },
         {
            ...RESTORE_RESULT,
            dryRun: false,
         },
         {
            ...RESTORE_RESULT,
            differences: 'foundryVersion: 13.351 -> 14.364',
         },
         {
            ...RESTORE_RESULT,
            differences: [],
         },
         {
            ...RESTORE_RESULT,
            differences: Array.from({ length: 4 }, () => difference),
         },
         {
            ...RESTORE_RESULT,
            differences: [1],
         },
         {
            ...RESTORE_RESULT,
            differences: [`${difference}${'x'.repeat(200)}`],
         },
      ];
      for (const result of malformed) {
         fixture.bridge.behaviour = async () => JSON.parse(JSON.stringify(result));
         expect((await fixture.call('restore_backup', { file })).error).toMatch(/^BACKUP_INCOMPLETE: /);
      }
   });

   it('refuses to restore from a folder that is a link or whose .wiretap is a link', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      fixture.bridge.endpoint.gateState.allowBackupAnyFolder = true;
      const { link, file } = linkedFolders(fixture);
      expect((await fixture.call('restore_backup', {
         file,
         folder: link,
      })).error).toBe('BACKUP_FOLDER_INVALID: The backup folder is a symbolic link.');
      expect((await fixture.call('restore_backup', { file })).error)
         .toBe('BACKUP_FOLDER_INVALID: The backup folder is a symbolic link.');
      expect(fixture.bridge.calls.every((call) => !call.sent)).toBe(true);
      expect(fixture.bridge.sentPieces).toHaveLength(0);
   });
});

describe('list_backups and delete_backup', () => {
   it('lists with the note cut to 40 bytes and fits the list to 2000 bytes', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      for (let index = 0; index < 30; index += 1) {
         writeBackup(fixture.store, fixture.store.defaultFolder, { note: `note ${index} ${'n'.repeat(100)}` });
      }
      /** @type {Record<string, unknown>} The default listing. */
      const listing = await fixture.call('list_backups', {});
      expect(listing.folder).toBe('default');
      expect(listing.total).toBe(30);
      /** @type {Array<[string, string, number, string]>} The listed rows. */
      const rows = /** @type {Array<[string, string, number, string]>} */ (listing.rows);
      expect(rows).toHaveLength(10);
      expect(rows[0][3]).toMatch(/^note 29 /);
      expect(rows.every((row) => Buffer.byteLength(row[3], 'utf8') <= 40)).toBe(true);
      expect(listing.cut).toBeUndefined();

      /** @type {Record<string, unknown>} A listing too large for the budget. */
      const large = await fixture.call('list_backups', { limit: 30 });
      expect(large.__bytes).toBeLessThanOrEqual(2000);
      expect(large.cut).toBe(true);
      expect(/** @type {unknown[]} */ (large.rows).length).toBeLessThan(30);
   });

   it('fitListResult and fitRestoreResult leave a fitting result unchanged', () => {
      /** @type {object} A small listing. */
      const small = {
         folder: 'default',
         rows: [['a', 'b', 1, '']],
         total: 1,
      };
      expect(fitListResult(small, 2000)).toEqual(small);
      expect(fitRestoreResult({
         file: 'f',
         rows: [],
      }, 4000)).toEqual({
         file: 'f',
         rows: [],
      });
   });

   it('lists and deletes in the default folder only when no GM endpoint is connected', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} A backup in the default folder. */
      const file = writeBackup(fixture.store);
      /** @type {string} A named folder. */
      const namedDir = path.join(fixture.root, 'named');
      fs.mkdirSync(namedDir);
      fixture.bridge.endpoint = undefined;
      expect((await fixture.call('list_backups', {})).rows).toHaveLength(1);
      expect((await fixture.call('list_backups', { folder: namedDir })).error)
         .toMatch(/^GATE_DENIED: .*allowBackupAnyFolder/);
      expect((await fixture.call('delete_backup', {
         file,
         folder: namedDir,
      })).error).toMatch(/^GATE_DENIED: /);
      expect(await fixture.call('delete_backup', { file })).toMatchObject({ trashed: true });
   });

   it('refuses to delete from a folder that is a link or whose .wiretap is a link', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      fixture.bridge.endpoint.gateState.allowBackupAnyFolder = true;
      const { link, target, file } = linkedFolders(fixture);
      expect((await fixture.call('delete_backup', {
         file,
         folder: link,
      })).error).toBe('BACKUP_FOLDER_INVALID: The backup folder is a symbolic link.');
      expect((await fixture.call('delete_backup', { file })).error)
         .toBe('BACKUP_FOLDER_INVALID: The backup folder is a symbolic link.');
      expect(fixture.trash.calls).toEqual([]);
      expect(backupFiles(target)).toEqual([file]);
   });

   it('deletes a valid backup into the recycle bin and returns { file, trashed: true } within 128 bytes', async () => {
      /** @type {Fixture} The store, fake bridge and tools under test. */
      const fixture = setup();
      /** @type {string} The backup. */
      const file = writeBackup(fixture.store);
      /** @type {Record<string, unknown>} The parsed tool result. */
      const result = await fixture.call('delete_backup', { file });
      expect(result).toEqual({
         file,
         trashed: true,
         __bytes: expect.any(Number),
      });
      expect(result.__bytes).toBeLessThanOrEqual(128);
      expect(fixture.trash.calls).toEqual([[path.join(fixture.store.defaultFolder, file)]]);
      expect(backupFiles(fixture.store.defaultFolder)).toEqual([]);
   });
});
