/**
 * Shared support for the context-budget test and the manual calibration script: starts the real MCP server in-process
 * with the real bridge, lists its tools through the real SDK client, runs each tool's representative-result fixture
 * through the real result enforcer, and reports every budget breach. It is not a test file (vitest only collects
 * `*.test.js`) and is never part of a shipping build.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createWiretapServer } from '../../server/server.ts';
import { startMcpServer } from '../../server/mcp.ts';
import { getBudget } from '../../shared/budgets.js';
import { HEADER_LINE_BYTES } from '../../shared/backup.js';
import {
   BRIDGE_BACKUP_PIECE,
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_REGISTRY,
   BRIDGE_RESTORE_PIECE,
   PROTOCOL_VERSION,
} from '../../shared/protocol.js';
import { registryPayload, script, shippedScripts } from './scriptFixtures.js';
import { fakeTrash, scratchRoot } from './backupTestHelpers.js';
import { reservePort } from '../portPool.js';

/**
 * @typedef {object} GmAck
 * @property {boolean} ok - Whether the fake GM client reports success.
 * @property {unknown} [result] - The result of a successful operation.
 * @property {{ code: string, message: string }} [error] - The error of a failed operation.
 */

/**
 * A fake GM client's answer to one invocation: it may emit events on the GM socket before it resolves the ack.
 * @typedef {(request: { op: string, params: object, requestId: string }, gm: import('socket.io-client').Socket) =>
 * Promise<GmAck>} GmHandler
 */

/**
 * @typedef {object} FixtureContext
 * @property {Client} client - The SDK client connected to the server under test.
 * @property {(ack: GmAck) => void} setGmAck - Sets the ack the fake GM client answers the next invocations with and
 * drops any handler.
 * @property {(handler: GmHandler) => void} setGmHandler - Makes the fake GM client answer the next invocations with
 * the handler's ack.
 */

/**
 * @typedef {object} FixtureCase
 * @property {string} label - What the case represents.
 * @property {string} budget - The `shared/budgets.js` constant the result must stay within.
 * @property {Function} run - Takes a FixtureContext, calls the tool through the client and resolves its result.
 */

/**
 * @typedef {object} BudgetReport
 * @property {string[]} failures - Hard-budget breaches and structural failures; any entry fails the test.
 * @property {string[]} warnings - Warn-budget breaches; reported only.
 * @property {object[]} listing - Per listed tool: name, nameChars, descriptionChars and definitionBytes.
 * @property {{ count: number, definitionBytes: number }} totals - The count and summed definition size of the listed
 * tools that are not test-local helpers; the tool-count and total-size budgets apply to these.
 * @property {{ count: number, definitionBytes: number }} helperTotals - The same for the test-local helper tools,
 * which are held to the per-tool budgets and fixtures only.
 * @property {object[]} fixtureRuns - Per fixture result: tool, label, budget, bytes and limit.
 */

/** @type {string} The module root. */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @type {string} The directory the module-level skill set ships in (`skills/wiretap/SKILL.md`). The skill scan reads
 * every `.md` file under it; a missing directory makes the scan find nothing.
 */
export const DEFAULT_SKILLS_ROOT = path.join(MODULE_ROOT, 'skills');

/** @type {string} The test-local tool that returns a synthetic document larger than the hard cap. */
export const HELPER_TOOL_NAME = 'mock_big_document';

/**
 * @type {RegExp} A tool reference in skill or instruction text. Matching rule: the literal prefix `mcp__wiretap__`,
 * then a name made of letters, digits and underscores in which hyphens may join such runs. A hyphen, period or other
 * punctuation at the end of the name belongs to the sentence, not to the name.
 */
const TOOL_MENTION_PATTERN = /mcp__wiretap__([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)/g;

/**
 * Build the synthetic document the helper tool returns: 120 obviously fake embedded items, over 100 KB serialized.
 * @returns {object} An actor-shaped document with an `items` array.
 */
export function makeBigDocument() {
   return {
      name: 'MOCK_ACTOR',
      type: 'MOCK_TYPE',
      system: { hp: 7 },
      items: Array.from({ length: 120 }, (_, index) => ({
         _id: `MOCKID${index}`,
         name: `MOCK_ITEM_${index}`,
         system: { description: 'd'.repeat(800) },
      })),
   };
}

/**
 * Sum the UTF-8 bytes of every text item in a tool result.
 * @param {{ content: { type: string, text?: string }[] }} result - The tool result.
 * @returns {number} The byte total.
 */
export function textBytes(result) {
   return result.content.reduce((sum, item) => sum + (item.text === undefined ? 0 : Buffer.byteLength(item.text)), 0);
}

/**
 * Create the helper tool registration that returns the synthetic large document.
 * @returns {import('../../server/mcp.ts').ToolRegistration} The registration.
 */
function makeHelperTool() {
   return {
      name: HELPER_TOOL_NAME,
      description: 'Test-only tool returning a synthetic document over the result cap.',
      inputSchema: { unused: z.string().optional() },
      handler: async () => ({
         content: [
            {
               type: 'text',
               text: JSON.stringify(makeBigDocument()),
            },
         ],
      }),
   };
}

/**
 * Create a fixture for a tool that answers with a short text: one case within the acknowledgement budget.
 * @param {string} name - The tool name.
 * @returns {FixtureCase[]} The fixture cases.
 */
export function trivialFixture(name) {
   return [
      {
         label: 'short answer',
         budget: 'ACK_MAX_BYTES',
         run: ({ client }) => client.callTool({
            name,
            arguments: {},
         }),
      },
   ];
}

/**
 * Build a GM ack for a successful operation.
 * @param {unknown} result - The operation result.
 * @returns {GmAck} An ack that carries `result`.
 */
function okAck(result) {
   return {
      ok: true,
      result,
   };
}

/**
 * Build a synthetic `list_document_types` result shaped like a real system's: 14 world classes, 20 embedded classes
 * and subtypes for the typed classes.
 * @returns {object} The result.
 */
function mockDocumentTypes() {
   return {
      system: 'mock-system',
      world: [
         'Actor',
         'Cards',
         'ChatMessage',
         'Combat',
         'FogExploration',
         'Folder',
         'Item',
         'JournalEntry',
         'Macro',
         'Playlist',
         'RollTable',
         'Scene',
         'Setting',
         'User',
      ],
      embedded: [
         'ActiveEffect',
         'ActorDelta',
         'AmbientLight',
         'AmbientSound',
         'Card',
         'Combatant',
         'CombatantGroup',
         'Drawing',
         'Item',
         'JournalEntryCategory',
         'JournalEntryPage',
         'Note',
         'PlaylistSound',
         'Region',
         'RegionBehavior',
         'Level',
         'TableResult',
         'Tile',
         'Token',
         'Wall',
      ],
      packOnly: ['Adventure'],
      subtypes: {
         Actor: [
            'player',
            'npc',
         ],
         Item: Array.from({ length: 7 }, (_, index) => `mock_item_${index}`),
         ChatMessage: Array.from({ length: 26 }, (_, index) => `mockMessageReport${index}`),
         RegionBehavior: Array.from({ length: 12 }, (_, index) => `mockBehavior${index}`),
      },
   };
}

/**
 * Build a synthetic compact view of an actor near its bound: 8 key leaves and 40 embedded item tuples.
 * @returns {object} A view shaped like `ctx.shape.compact` output.
 */
function mockCompactView() {
   return {
      uuid: 'Actor.MOCKACTOR0000001',
      name: 'MOCK_ACTOR',
      type: 'player',
      version: 'a1b2c3d4e5f607',
      fields: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
         `system.mock.g${index}.value`,
         index,
      ])),
      embedded: {
         items: {
            total: 120,
            rows: Array.from({ length: 40 }, (_, index) => [
               `MOCKITEM${String(index).padStart(8, '0')}`,
               `MOCK_I${index}`,
               'weapon',
            ]),
         },
      },
   };
}

/**
 * Build synthetic acknowledgement rows of created or deleted documents.
 * @param {number} count - How many rows.
 * @returns {Array<{ uuid: string, name: string, type: string }>} The acknowledgement rows of a create call.
 */
function mockAckRows(count) {
   return Array.from({ length: count }, (_, index) => ({
      uuid: `Actor.MOCKACTOR${String(index).padStart(8, '0')}`,
      name: `MOCK_ACTOR_${index}`,
      type: 'npc',
   }));
}

/**
 * Build `create_documents` arguments that pass the sidecar's schema.
 * @returns {{ documentName: string, data: string[] }} The tool arguments with JSON-text data.
 */
function mockCreateArguments() {
   return {
      documentName: 'Actor',
      data: ['{"name":"MOCK_ACTOR_1","type":"npc"}'],
   };
}

/**
 * Build a world description whose four fields each have the most bytes a backup header accepts, 128 ASCII characters.
 * @returns {{ worldId: string, foundryVersion: string, systemId: string, systemVersion: string }} The description.
 */
function mockWorld() {
   return {
      worldId: 'W'.repeat(128),
      foundryVersion: 'F'.repeat(128),
      systemId: 'S'.repeat(128),
      systemVersion: 'V'.repeat(128),
   };
}

/**
 * Build a fake GM answer to a backup export: it streams one document line and the end marker on the GM socket, then
 * acks the largest counts the result can carry: 9,999 unreadable documents, 199 parents, 128-character world fields.
 * @returns {GmHandler} Answers an export invocation with that stream and ack.
 */
function backupExportHandler() {
   return async (request, gm) => {
      /** @type {Buffer} The one document line of the backup. */
      const line = Buffer.from(`${JSON.stringify({
         uuid: 'Actor.MOCKACTOR0000001',
         documentName: 'Actor',
         data: { name: 'MOCK_ACTOR' },
      })}\n`);
      await gm.emitWithAck(BRIDGE_BACKUP_PIECE, {
         requestId: request.requestId,
         seq: 0,
         data: line,
      });
      await gm.emitWithAck(BRIDGE_BACKUP_PIECE, {
         requestId: request.requestId,
         seq: 1,
         end: true,
         pieces: 1,
         bytes: line.length,
      });
      return okAck({
         documents: 1,
         bytes: HEADER_LINE_BYTES + line.length,
         unreadable: 9999,
         parents: 199,
         world: mockWorld(),
      });
   };
}

/**
 * Call a backup tool and return its result, failing on an error result: an error text is at most 512 bytes, well
 * under every backup budget, so a fixture that measured one would pass without building the result it names.
 * @param {Client} client - The SDK client of the running fixture.
 * @param {string} name - The tool to call.
 * @param {Record<string, unknown>} args - The arguments of the call.
 * @returns {Promise<{ content: { text: string }[] }>} The successful result.
 * @throws {Error} When the call returns an error result; the message carries its text.
 */
async function callBackupTool(client, name, args) {
   /** @type {{ isError?: boolean, content: { text: string }[] }} The result of the call. */
   const result = await client.callTool({
      name,
      arguments: args,
   });
   if (result.isError) {
      throw new Error(`${name} failed: ${result.content[0].text}`);
   }
   return result;
}

/**
 * Make one backup through the client with the fake GM answer of `backupExportHandler`.
 * @param {FixtureContext} context - The client and the fake GM controls of the running fixture.
 * @param {string} [note] - The `note` argument of the call; none when absent.
 * @returns {Promise<{ content: { text: string }[] }>} The `backup_documents` result.
 * @throws {Error} When the call fails, so a fixture never measures a refusal instead of a backup.
 */
async function makeBackup({ client, setGmHandler }, note) {
   setGmHandler(backupExportHandler());
   return callBackupTool(client, 'backup_documents', {
      uuids: ['Actor.x'],
      ...(note === undefined ? {} : { note }),
   });
}

/**
 * Build a fake GM answer to a restore: it acks every restore piece it receives and, once the end marker arrives,
 * answers 20 rows with 256-byte uuids and 160-byte reasons and three differences, the largest result the sidecar
 * accepts before cutting rows.
 * @returns {GmHandler} Answers a restore invocation once its pieces have arrived.
 */
function restoreHandler() {
   return (request, gm) => new Promise((resolve) => {
      /**
       * Ack one restore piece of this request and answer the restore after its end marker.
       * @param {{ requestId: string, end?: true }} piece - A data piece or the end marker the sidecar sent.
       * @param {(ack: { ok: true }) => void} reply - Sends the piece's ack back to the sidecar.
       * @returns {void}
       */
      const onPiece = (piece, reply) => {
         reply({ ok: true });
         if (piece.requestId !== request.requestId || piece.end !== true) {
            return;
         }
         gm.off(BRIDGE_RESTORE_PIECE, onPiece);
         resolve(okAck({
            replaced: 20,
            created: 0,
            skipped: 0,
            failed: 0,
            secretLost: 0,
            rows: Array.from({ length: 20 }, (_, index) => [
               `Actor.${String(index).padStart(2, '0')}${'U'.repeat(248)}`,
               'replaced',
               'R'.repeat(160),
            ]),
            differences: [
               `foundryVersion: ${'F'.repeat(110)} -> ${'G'.repeat(110)}`,
               `systemId: ${'S'.repeat(110)} -> ${'T'.repeat(110)}`,
               `systemVersion: ${'V'.repeat(110)} -> ${'X'.repeat(110)}`,
            ],
         }));
      };
      gm.on(BRIDGE_RESTORE_PIECE, onPiece);
   });
}

/**
 * Give a pack ack row the longest ASCII label that keeps its JSON within `ACK_MAX_BYTES`: the worst case the pack
 * handlers' label cut produces.
 * @param {Record<string, unknown>} row - The ack row without a label.
 * @returns {Record<string, unknown>} The row with a `label` that fills the budget exactly.
 */
function withFittedLabel(row) {
   /** @type {number} The bytes the row's JSON holds with an empty label. */
   const emptyBytes = Buffer.byteLength(JSON.stringify({
      ...row,
      label: '',
   }));
   return {
      ...row,
      label: 'L'.repeat(getBudget('ACK_MAX_BYTES').value - emptyBytes),
   };
}

/**
 * @type {number} The backups the `list_backups` fixture makes: one more than the 16 rows that fit in
 * `BACKUP_LIST_MAX_BYTES`, so the listing is cut. Every row has the same length (same-length file names, one document,
 * notes cut to `LIST_NOTE_MAX_BYTES`), so the cut result is the same 1,971 bytes as with more backups; each extra
 * backup only adds a file write and a header read, the slowest steps of the report when every vitest worker is busy.
 */
const LIST_FIXTURE_BACKUPS = 17;

/**
 * The representative-result fixtures, keyed by tool name. Every listed tool needs an entry; the data is synthetic.
 * @type {Record<string, FixtureCase[]>}
 */
export const FIXTURES = {
   backup_documents: [
      {
         label: 'largest ack: longest counts',
         budget: 'BACKUP_RESULT_MAX_BYTES',
         run: (context) => makeBackup(context),
      },
   ],
   list_backups: [
      {
         label: 'the most rows the budget holds, cut',
         budget: 'BACKUP_LIST_MAX_BYTES',
         run: async (context) => {
            for (let index = 0; index < LIST_FIXTURE_BACKUPS; index += 1) {
               await makeBackup(context, `MOCK_NOTE_${String(index).padStart(2, '0')}_${'n'.repeat(187)}`);
            }
            /** @type {{ content: { text: string }[] }} The listing of every backup made above. */
            const result = await callBackupTool(context.client, 'list_backups', { limit: 50 });
            // A listing that is not cut measures fewer rows than the budget holds, so it does not stand for the case.
            if (JSON.parse(result.content[0].text).cut !== true) {
               throw new Error(`list_backups kept every row of ${LIST_FIXTURE_BACKUPS} backups, so nothing was cut`);
            }
            return result;
         },
      },
   ],
   restore_backup: [
      {
         label: 'twenty long rows',
         budget: 'RESTORE_RESULT_MAX_BYTES',
         run: async (context) => {
            /** @type {string} The backup file to restore. */
            const { file } = JSON.parse((await makeBackup(context)).content[0].text);
            context.setGmHandler(restoreHandler());
            return callBackupTool(context.client, 'restore_backup', { file });
         },
      },
   ],
   delete_backup: [
      {
         label: 'trashed ack',
         budget: 'BACKUP_DELETE_MAX_BYTES',
         run: async (context) => {
            /** @type {string} The backup file to recycle. */
            const { file } = JSON.parse((await makeBackup(context)).content[0].text);
            return callBackupTool(context.client, 'delete_backup', { file });
         },
      },
   ],
   create_documents: [
      {
         label: 'ack of 50 created documents',
         budget: 'ACK_BATCH_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck(mockAckRows(50)));
            return client.callTool({
               name: 'create_documents',
               arguments: mockCreateArguments(),
            });
         },
      },
      {
         label: 'failure with 30 validation failures',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'VALIDATION_FAILED',
                  message: 'Validation failed: 30 invalid fields in 1 of 1 item; nothing was written.',
                  failures: Array.from({ length: 10 }, (_, index) => ({
                     path: `[0].system.MOCK_FIELD_${index}`,
                     message: 'MOCK_BAD_VALUE '.repeat(10),
                  })),
                  failureCount: 30,
               },
            });
            return client.callTool({
               name: 'create_documents',
               arguments: mockCreateArguments(),
            });
         },
      },
      {
         label: 'failure with an oversized message',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'OP_FAILED',
                  message: 'MOCK_FAILURE '.repeat(200),
               },
            });
            return client.callTool({
               name: 'create_documents',
               arguments: mockCreateArguments(),
            });
         },
      },
   ],
   update_documents: [
      {
         label: 'ack of 50 updated documents',
         budget: 'ACK_BATCH_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(
               okAck(
                  Array.from({ length: 50 }, (_, index) => ({
                     uuid: `Actor.MOCKACTOR${String(index).padStart(8, '0')}`,
                     changed: [
                        'system.hp',
                        'name',
                     ],
                  })),
               ),
            );
            return client.callTool({
               name: 'update_documents',
               arguments: {
                  updates: [
                     {
                        uuid: 'Actor.MOCKACTOR00000000',
                        path: 'name',
                        value: '"MOCK_NAME"',
                     },
                  ],
               },
            });
         },
      },
   ],
   delete_documents: [
      {
         label: 'ack of 50 deleted documents',
         budget: 'ACK_BATCH_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck(mockAckRows(50)));
            return client.callTool({
               name: 'delete_documents',
               arguments: { uuids: ['Actor.MOCKACTOR00000000'] },
            });
         },
      },
      {
         label: 'dry run preview of a cascade, cut to the default cap',
         budget: 'RESULT_HARD_CAP_DEFAULT_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(
               okAck({
                  dryRun: true,
                  rows: Array.from({ length: 70 }, (_, index) => [
                     `Actor.MOCKACTOR00000000.Item.MOCKITEM${String(index).padStart(9, '0')}`,
                     `MOCK_ITEM_${index}`,
                     'weapon',
                  ]),
                  total: 603,
                  cut: true,
               }),
            );
            return client.callTool({
               name: 'delete_documents',
               arguments: {
                  uuids: ['Actor.MOCKACTOR00000000'],
                  dryRun: true,
               },
            });
         },
      },
   ],
   replace_document: [
      {
         label: 'ack of a replaced document with many changed fields',
         budget: 'ACK_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(
               okAck({
                  uuid: 'Actor.MOCKACTOR00000000',
                  changed: Array.from({ length: 40 }, (_, index) => `mockField${index}`),
               }),
            );
            return client.callTool({
               name: 'replace_document',
               arguments: {
                  uuid: 'Actor.MOCKACTOR00000000',
                  data: '{"name":"MOCK_NAME","type":"npc"}',
               },
            });
         },
      },
   ],
   batch: [
      {
         label: 'ack of a 50-document batch',
         budget: 'ACK_BATCH_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(
               okAck({
                  created: mockAckRows(20),
                  updated: Array.from({ length: 15 }, (_, index) => ({
                     uuid: `Actor.MOCKACTOR${String(index).padStart(8, '0')}`,
                     changed: [
                        'system.hp',
                        'name',
                     ],
                  })),
                  deleted: mockAckRows(15),
               }),
            );
            return client.callTool({
               name: 'batch',
               arguments: { deletes: ['Actor.MOCKACTOR00000000'] },
            });
         },
      },
   ],
   list_document_types: [
      {
         label: 'document classes with the subtypes of a typical system',
         budget: 'DOCUMENT_TYPES_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck(mockDocumentTypes()));
            return client.callTool({
               name: 'list_document_types',
               arguments: {},
            });
         },
      },
   ],
   get_document: [
      {
         label: 'compact view of an actor with 40 embedded item tuples',
         budget: 'COMPACT_VIEW_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck(mockCompactView()));
            return client.callTool({
               name: 'get_document',
               arguments: { uuid: 'Actor.MOCKACTOR0000001' },
            });
         },
      },
      {
         label: 'unchanged ack',
         budget: 'ACK_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({ unchanged: true }));
            return client.callTool({
               name: 'get_document',
               arguments: {
                  uuid: 'Actor.MOCKACTOR0000001',
                  ifChanged: 'a1b2c3d4e5f607',
               },
            });
         },
      },
      {
         label: 'ten-path slice of an actor',
         budget: 'PROJECTION_BYTES_PER_10_FIELDS',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               values: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
                  `system.attribute.mock${index}.baseValue`,
                  index,
               ])),
               missing: [],
               version: 'a1b2c3d4e5f607',
            }));
            return client.callTool({
               name: 'get_document',
               arguments: {
                  uuid: 'Actor.MOCKACTOR0000001',
                  paths: ['system.attribute'],
               },
            });
         },
      },
      {
         label: 'full export over the default cap becomes a handle',
         budget: 'ACK_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck(makeBigDocument()));
            return client.callTool({
               name: 'get_document',
               arguments: {
                  uuid: 'Actor.MOCKACTOR0000001',
                  mode: 'full',
               },
            });
         },
      },
      {
         label: 'full export of 12 KB with the largest per-call cap stays inline',
         budget: 'RESULT_HARD_CAP_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               uuid: 'Actor.MOCKACTOR0000001',
               name: 'MOCK_ACTOR',
               notes: 'n'.repeat(12000),
            }));
            return client.callTool({
               name: 'get_document',
               arguments: {
                  uuid: 'Actor.MOCKACTOR0000001',
                  mode: 'full',
                  maxBytes: getBudget('RESULT_HARD_CAP_MAX_BYTES').value,
               },
            });
         },
      },
      {
         label: 'document not found',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'DOC_NOT_FOUND',
                  message: `No document 'Actor.MOCKACTOR0000009'.`,
               },
            });
            return client.callTool({
               name: 'get_document',
               arguments: { uuid: 'Actor.MOCKACTOR0000009' },
            });
         },
      },
   ],
   search_documents: [
      {
         label: 'page of 20 rows with a cursor',
         budget: 'SEARCH_PAGE_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               rows: Array.from({ length: 20 }, (_, index) => [
                  `Compendium.mock.items.Item.MOCKITEM${String(index).padStart(8, '0')}`,
                  `MOCK_ITEM_${String(index).padStart(3, '0')}_${'x'.repeat(20)}`,
                  'weapon',
               ]),
               total: 113,
               nextCursor: 'W' + 'c'.repeat(120),
            }));
            return client.callTool({
               name: 'search_documents',
               arguments: { documentName: 'Item' },
            });
         },
      },
      {
         label: 'empty page',
         budget: 'ACK_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               rows: [],
               total: 0,
            }));
            return client.callTool({
               name: 'search_documents',
               arguments: {
                  documentName: 'Item',
                  query: 'none',
               },
            });
         },
      },
      {
         label: 'invalid cursor',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'CURSOR_INVALID',
                  message: 'The cursor is not valid; search again without it.',
               },
            });
            return client.callTool({
               name: 'search_documents',
               arguments: {
                  documentName: 'Item',
                  cursor: 'MOCK',
               },
            });
         },
      },
   ],
   describe_schema: [
      {
         label: 'blank example of 5 KB with the outlines',
         budget: 'DESCRIBE_SCHEMA_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               documentName: 'Actor',
               subtype: 'mock',
               example: { notes: 'n'.repeat(5000) },
               outline: Array.from({ length: 30 }, (_, index) => [
                  `field${index}`,
                  'StringField',
               ]),
               systemOutline: Array.from({ length: 12 }, (_, index) => [
                  `system${index}`,
                  'SchemaField',
               ]),
            }));
            return client.callTool({
               name: 'describe_schema',
               arguments: {
                  documentName: 'Actor',
                  subtype: 'mock',
               },
            });
         },
      },
      {
         label: 'path with constraints',
         budget: 'DESCRIBE_SCHEMA_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               documentName: 'Actor',
               subtype: 'mock',
               path: 'system.attribute',
               example: { body: { baseValue: 1 } },
               schema: {
                  class: 'SchemaField',
                  fields: { body: {
                     class: 'NumberField',
                     integer: true,
                     min: 0,
                     max: 99,
                  } },
               },
            }));
            return client.callTool({
               name: 'describe_schema',
               arguments: {
                  documentName: 'Actor',
                  path: 'system.attribute',
               },
            });
         },
      },
      {
         label: 'path not found',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'PATH_NOT_FOUND',
                  message: `There is no field 'nope' here.`,
               },
            });
            return client.callTool({
               name: 'describe_schema',
               arguments: {
                  documentName: 'Actor',
                  path: 'nope',
               },
            });
         },
      },
   ],
   open_sheet: [
      {
         label: 'opened on a user\'s client with a 100-byte app id',
         budget: 'SHEET_RESULT_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               ok: true,
               appId: 'M'.repeat(100),
            }));
            return client.callTool({
               name: 'open_sheet',
               arguments: {
                  uuid: 'Actor.MOCKACTOR0000001',
                  userId: 'MOCKUSER00000001',
               },
            });
         },
      },
      {
         label: 'user not connected',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'USER_OFFLINE',
                  message: 'The user MOCK_USER_A is not connected, so no client can show the sheet. '.padEnd(200, '.'),
               },
            });
            return client.callTool({
               name: 'open_sheet',
               arguments: {
                  uuid: 'Actor.MOCKACTOR0000001',
                  userId: 'MOCKUSER00000001',
               },
            });
         },
      },
   ],
   close_sheet: [
      {
         label: 'closed on a user\'s client',
         budget: 'SHEET_RESULT_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               ok: true,
               closed: true,
            }));
            return client.callTool({
               name: 'close_sheet',
               arguments: {
                  uuid: 'Actor.MOCKACTOR0000001',
                  userId: 'MOCKUSER00000001',
               },
            });
         },
      },
   ],
   roll: [
      {
         label: 'roll cut to its budget',
         budget: 'ROLL_RESULT_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               total: 512,
               formula: '140d6+40d10+20d20kh10',
               dice: [
                  [
                     6,
                     Array.from({ length: 140 }, (_, index) => (index % 6) + 1),
                  ],
                  [
                     10,
                     Array.from({ length: 40 }, (_, index) => (index % 9) + 1),
                  ],
                  [
                     20,
                     Array.from({ length: 10 }, (_, index) => index + 10),
                     Array.from({ length: 10 }, (_, index) => index + 1),
                  ],
               ],
               cut: true,
            }));
            return client.callTool({
               name: 'roll',
               arguments: { formula: '140d6+40d10+20d20kh10' },
            });
         },
      },
   ],
   draw_table: [
      {
         label: 'draw of several long results',
         budget: 'DRAW_RESULT_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               total: 7,
               results: Array.from({ length: 4 }, (_, index) => ({
                  name: `MOCK_RESULT_${index}`,
                  text: `MOCK result text ${index}: ${'t'.repeat(120)}`,
                  uuid: `RollTable.MOCKTABLE0000001.TableResult.MOCKRESULT00000${index}`,
               })),
               count: 4,
            }));
            return client.callTool({
               name: 'draw_table',
               arguments: { uuid: 'RollTable.MOCKTABLE0000001' },
            });
         },
      },
      {
         label: 'nothing drawable',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'TABLE_EMPTY',
                  message: 'The table has no result left to draw in the range of its formula.',
               },
            });
            return client.callTool({
               name: 'draw_table',
               arguments: { uuid: 'RollTable.MOCKTABLE0000001' },
            });
         },
      },
   ],
   execute_macro: [
      {
         label: 'small value',
         budget: 'RESULT_HARD_CAP_DEFAULT_BYTES',
         run: async ({ client, setGmAck }) => {
            setGmAck(okAck({
               type: 'script',
               value: 5,
            }));
            /** @type {{ isError?: boolean, content: { text: string }[] }} The result of the call. */
            const result = await client.callTool({
               name: 'execute_macro',
               arguments: { uuid: 'Macro.MOCKMACRO0000001' },
            });
            // An error here is the sidecar's gate denial, which would measure a refusal instead of a macro result.
            if (result.isError) {
               throw new Error(`execute_macro did not reach the fake GM: ${result.content[0].text}`);
            }
            return result;
         },
      },
      {
         label: 'a 12 KB value becomes a handle',
         budget: 'ACK_MAX_BYTES',
         run: async ({ client, setGmAck }) => {
            setGmAck(okAck({
               type: 'script',
               value: 'v'.repeat(12000),
            }));
            /** @type {{ isError?: boolean, content: { text: string }[] }} The result of the call. */
            const result = await client.callTool({
               name: 'execute_macro',
               arguments: { uuid: 'Macro.MOCKMACRO0000001' },
            });
            // Only a result the fake GM returned is over the cap, so only it is stored behind a handle.
            if (result.isError || typeof JSON.parse(result.content[0].text).handle !== 'string') {
               throw new Error(`execute_macro returned no handle: ${result.content[0].text}`);
            }
            return result;
         },
      },
   ],
   create_pack: [
      {
         label: 'dry run with a 64-character name and a label cut to fit',
         budget: 'ACK_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck(withFittedLabel({
               dryRun: true,
               id: `world.${'n'.repeat(64)}`,
               type: 'JournalEntry',
            })));
            return client.callTool({
               name: 'create_pack',
               arguments: {
                  label: 'L'.repeat(128),
                  type: 'JournalEntry',
                  name: 'n'.repeat(64),
                  dryRun: true,
               },
            });
         },
      },
   ],
   delete_pack: [
      {
         label: 'dry run with the largest count and a long label',
         budget: 'ACK_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck(withFittedLabel({
               dryRun: true,
               id: `world.${'n'.repeat(64)}`,
               type: 'JournalEntry',
               documents: Number.MAX_SAFE_INTEGER,
            })));
            return client.callTool({
               name: 'delete_pack',
               arguments: {
                  id: `world.${'n'.repeat(64)}`,
                  dryRun: true,
               },
            });
         },
      },
      {
         label: 'locked pack',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'PACK_LOCKED',
                  message: 'The pack is locked; unlock it in Foundry first.',
               },
            });
            return client.callTool({
               name: 'delete_pack',
               arguments: { id: `world.${'n'.repeat(64)}` },
            });
         },
      },
   ],
   read_handle: [
      {
         label: 'window at the largest per-call cap',
         budget: 'RESULT_HARD_CAP_MAX_BYTES',
         run: async ({ client }) => {
            const big = await client.callTool({
               name: HELPER_TOOL_NAME,
               arguments: {},
            });
            return client.callTool({
               name: 'read_handle',
               arguments: {
                  handle: JSON.parse(big.content[0].text).handle,
                  maxBytes: getBudget('RESULT_HARD_CAP_MAX_BYTES').value,
               },
            });
         },
      },
      {
         label: 'default window of a stored result',
         budget: 'RESULT_HARD_CAP_DEFAULT_BYTES',
         run: async ({ client }) => {
            const big = await client.callTool({
               name: HELPER_TOOL_NAME,
               arguments: {},
            });
            return client.callTool({
               name: 'read_handle',
               arguments: { handle: JSON.parse(big.content[0].text).handle },
            });
         },
      },
      {
         label: 'paths window cut at the cap',
         budget: 'RESULT_HARD_CAP_DEFAULT_BYTES',
         run: async ({ client }) => {
            const big = await client.callTool({
               name: HELPER_TOOL_NAME,
               arguments: {},
            });
            return client.callTool({
               name: 'read_handle',
               arguments: {
                  handle: JSON.parse(big.content[0].text).handle,
                  paths: ['items'],
               },
            });
         },
      },
   ],
   [HELPER_TOOL_NAME]: [
      {
         label: 'result over the cap becomes a handle',
         budget: 'ACK_MAX_BYTES',
         run: ({ client }) => client.callTool({
            name: HELPER_TOOL_NAME,
            arguments: {},
         }),
      },
   ],
};

/**
 * Build the script definition of a synthetic tool a fake GM client registers through `bridge:registry`.
 * @param {string} name - The tool name.
 * @param {object} [overrides] - Fields replacing the defaults.
 * @returns {object} A definition a fake GM client can send in a registry event.
 */
export function registryEntry(name, overrides = {}) {
   return script(name, {
      description: `Synthetic registry tool ${name}.`,
      inputSchema: {
         type: 'object',
         properties: { text: { type: 'string' } },
      },
      ...overrides,
   });
}

/**
 * Build the default backup store options of a harness: a new scratch root, whose `bin` directory is the recycle bin.
 * @returns {import('../../server/backups.ts').BackupStoreOptions} The root and the recycle bin stand-in.
 */
function defaultBackupOptions() {
   /** @type {string} The scratch root that holds `.wiretap/backups` and the bin. */
   const root = scratchRoot('harness');
   return {
      root,
      trash: fakeTrash(path.join(root, 'bin')),
   };
}

/**
 * Start the sidecar bridge with a fake GM client, an MCP server and a connected SDK client. The server lists the
 * sidecar built-ins (`read_handle` and the four backup tools), the test-local helper tool, `extraTools`, and the
 * scripts the fake GM client registers: the shipped scripts and those in `registry` before the session starts, and
 * later ones through the returned `registerTools`.
 * @param {object} [options] - What to register.
 * @param {import('../../server/mcp.ts').ToolRegistration[]} [options.tools] - Tools registered after the helper tool.
 * @param {string} [options.instructions] - The server instructions text; the production text when absent.
 * @param {object[]} [options.registry] - Script definitions the fake GM client sends beside the shipped scripts,
 * before the SDK client connects.
 * @param {import('../../server/backups.ts').BackupStoreOptions} [options.backups] - The backup store of the sidecar
 * and of the MCP server under test; default a new scratch root whose recycle bin is `fakeTrash(<root>/bin)`.
 * @returns {Promise<{ client: Client, gm: import('socket.io-client').Socket, setGmAck: Function,
 * setGmHandler: Function, registerTools: Function, nextToolListChange: Function, close: Function }>} The client, the
 * fake GM socket, the controls for the fake GM client's answers (`setGmAck(ack)` answers with a fixed ack and drops
 * any handler; `setGmHandler(handler)` answers with the ack the handler resolves, after whatever it emits on the GM
 * socket), `registerTools(entries)` (sends a registry of the shipped scripts plus the entries and resolves with its
 * ack, which counts the shipped scripts too), `nextToolListChange()` (resolves when the client receives its next
 * `notifications/tools/list_changed`, rejects after one second) and the teardown.
 */
export async function startHarness({ tools = [], instructions, registry, backups } = {}) {
   /** @type {Array<() => unknown>} Teardown steps for what has been started, in start order. */
   const teardown = [];
   /**
    * Stop everything started so far, newest first; one failing step does not stop the others.
    * @returns {Promise<void>}
    */
   const close = async () => {
      for (const step of teardown.reverse()) {
         try {
            await step();
         } catch {
            // Best-effort: the remaining steps still run.
         }
      }
      teardown.length = 0;
   };
   try {
      /** @type {import('../../server/backups.ts').BackupStoreOptions} The backup store options of both servers. */
      const backupOptions = backups ?? defaultBackupOptions();
      /** @type {ReturnType<typeof createWiretapServer>} The sidecar providing the Socket.IO bridge. */
      const server = createWiretapServer(0, await reservePort(), 'mcp-only', { backups: backupOptions });
      teardown.push(() => server.dispose());
      await server.ready;
      /** @type {GmAck} The ack the fake GM client answers invocations with when no handler is set. */
      let gmAck = okAck({});
      /** @type {GmHandler | undefined} The handler that answers invocations instead of `gmAck`. */
      let gmHandler;
      /** @type {import('socket.io-client').Socket} The fake GM client. */
      const gm = ioClient(`http://127.0.0.1:${server.io.httpServer.address().port}`);
      teardown.push(() => gm.close());
      gm.on(BRIDGE_INVOKE, (request, ack) => {
         if (gmHandler === undefined) {
            ack(gmAck);
            return;
         }
         // A failing handler answers with its message, so the fixture fails at once instead of waiting out the call.
         gmHandler(request, gm).then(ack, (error) => ack({
            ok: false,
            error: {
               code: 'OP_FAILED',
               message: String(error),
            },
         }));
      });
      await new Promise((resolve) => gm.on('connect', resolve));
      await gm.emitWithAck(BRIDGE_IDENTIFY, {
         protocolVersion: PROTOCOL_VERSION,
         userId: 'u1',
         userName: 'GM',
         isGM: true,
         kind: 'human',
         dom: true,
         // The macro gate is open so the `execute_macro` fixtures reach the fake GM instead of the sidecar's denial.
         gateState: { allowMacroExecution: true },
      });
      await gm.emitWithAck(BRIDGE_REGISTRY, registryPayload([
         ...shippedScripts(),
         ...(registry ?? []),
      ]));
      /** @type {ReturnType<typeof startMcpServer>} The MCP server under test. */
      const mcp = startMcpServer(server.bridge, 0, {
         tools: [
            makeHelperTool(),
            ...tools,
         ],
         instructions,
         sessions: {
            listChangedQuietMs: 10,
            listChangedMaxWaitMs: 50,
         },
         backups: backupOptions,
      });
      teardown.push(() => mcp.close());
      await mcp.ready;
      /** @type {Client} The real MCP SDK client. */
      const client = new Client({
         name: 'test',
         version: '0.0.0',
      });
      /** @type {Array<() => void>} Resolvers of the callers waiting for the next tool list change. */
      const waiters = [];
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
         for (const resolve of waiters.splice(0)) {
            resolve();
         }
      });
      teardown.push(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port()}/mcp`)));
      return {
         client,
         gm,
         setGmAck: (ack) => {
            gmAck = ack;
            gmHandler = undefined;
         },
         setGmHandler: (handler) => {
            gmHandler = handler;
         },
         registerTools: (entries) => gm.emitWithAck(
            BRIDGE_REGISTRY,
            registryPayload([
               ...shippedScripts(),
               ...entries,
            ]),
         ),
         nextToolListChange: () => new Promise((resolve, reject) => {
            waiters.push(resolve);
            setTimeout(() => reject(new Error('no tools/list_changed within 1000 ms')), 1000).unref();
         }),
         close,
      };
   } catch (error) {
      await close();
      throw error;
   }
}

/**
 * List the distinct tool names that text refers to as `mcp__wiretap__<tool>`.
 * @param {string} text - Skill or instruction text.
 * @returns {string[]} The distinct tool names, in order of first mention.
 */
export function findToolMentions(text) {
   return [...new Set([...text.matchAll(TOOL_MENTION_PATTERN)].map((match) => match[1]))];
}

/**
 * Read the text of every Markdown file under a skills directory. A missing directory holds no skills.
 * @param {string} root - The skills directory.
 * @returns {{ file: string, text: string }[]} The files and their text.
 */
export function readSkillFiles(root) {
   if (!fs.existsSync(root)) {
      return [];
   }
   /** @type {{ file: string, text: string }[]} The files found so far. */
   const found = [];
   for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      /** @type {string} The entry's full path. */
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
         found.push(...readSkillFiles(full));
      } else if (entry.name.endsWith('.md')) {
         found.push({
            file: full,
            text: fs.readFileSync(full, 'utf8'),
         });
      }
   }
   return found;
}

/**
 * Create a function that records a breach of a named budget as a failure when the budget is hard and as a warning when
 * it is warn.
 * @param {string[]} failures - Receives hard breaches.
 * @param {string[]} warnings - Receives warn breaches.
 * @returns {Function} A recorder taking (budgetName, actual, subject, what); it records nothing within the budget.
 */
function makeBreachRecorder(failures, warnings) {
   return (budgetName, actual, subject, what) => {
      /** @type {Readonly<import('../../shared/budgets.js').Budget>} The budget being checked. */
      const budget = getBudget(budgetName);
      if (actual <= budget.value) {
         return;
      }
      /** @type {string} The unit suffix; a count has none. */
      const unit = budget.unit === 'count' ? '' : ` ${budget.unit}`;
      /** @type {string} The breach text. */
      const message = `${subject}: ${what} is ${actual}${unit}, at most ${budget.value}${unit} (${budgetName})`;
      (budget.severity === 'hard' ? failures : warnings).push(message);
   };
}

/**
 * Measure a server and report every budget breach: per-tool name, definition and description sizes, the tool count and
 * total definition size, a fixture for every listed tool, each fixture result against its budget, and every tool
 * mentioned by the server instructions or a shipped skill.
 * @param {object} options - What to check.
 * @param {Client} options.client - The SDK client connected to the server under test.
 * @param {(ack: GmAck) => void} options.setGmAck - Sets the fake GM client's answer.
 * @param {(handler: GmHandler) => void} options.setGmHandler - Sets the handler that answers the fake GM client's
 * invocations.
 * @param {Record<string, FixtureCase[]>} options.fixtures - The fixtures keyed by tool name.
 * @param {string} [options.skillsRoot] - The shipped skills directory; a missing directory holds no skills.
 * @param {string[]} [options.helperTools] - Test-local tools that are measured per tool but do not count toward the
 * tool-count and total-size budgets. Every other listed tool counts, including extra tools a test registers to
 * exercise a budget.
 * @param {boolean | string[]} [options.runFixtures] - Which fixtures to run and measure: true every one, false none,
 * or the fixtures of the named tools only. A listed tool without a fixture is reported either way. Default true.
 * @returns {Promise<BudgetReport>} The measured breaches and sizes.
 */
export async function collectReport({
   client,
   setGmAck,
   setGmHandler,
   fixtures,
   skillsRoot = DEFAULT_SKILLS_ROOT,
   helperTools = [HELPER_TOOL_NAME],
   runFixtures = true,
}) {
   /** @type {BudgetReport} The report being built. */
   const report = {
      failures: [],
      warnings: [],
      listing: [],
      totals: {
         count: 0,
         definitionBytes: 0,
      },
      helperTotals: {
         count: 0,
         definitionBytes: 0,
      },
      fixtureRuns: [],
   };
   /** @type {(budgetName: string, actual: number, subject: string, what: string) => void} Breach recorder. */
   const breach = makeBreachRecorder(report.failures, report.warnings);
   /** @type {{ tools: Array<{ name: string }> }} The tools the session lists. */
   const { tools } = await client.listTools();
   for (const tool of tools) {
      /** @type {string} The label of this tool in messages. */
      const subject = `tool "${tool.name}"`;
      /** @type {number} The UTF-8 size of the listed definition. */
      const definitionBytes = Buffer.byteLength(JSON.stringify({
         name: tool.name,
         description: tool.description,
         inputSchema: tool.inputSchema,
      }));
      report.listing.push({
         name: tool.name,
         nameChars: tool.name.length,
         descriptionChars: tool.description.length,
         definitionBytes,
      });
      /** @type {{ count: number, definitionBytes: number }} The totals this tool adds to. */
      const totals = helperTools.includes(tool.name) ? report.helperTotals : report.totals;
      totals.count += 1;
      totals.definitionBytes += definitionBytes;
      breach('CORE_TOOL_NAME_MAX_CHARS', tool.name.length, subject, 'name');
      breach('DEFINITION_MAX_BYTES', definitionBytes, subject, 'definition');
      breach('DESCRIPTION_MAX_CHARS', tool.description.length, subject, 'description');
      breach('DESCRIPTION_TARGET_CHARS', tool.description.length, subject, 'description');
   }
   breach('ALWAYS_LISTED_TOOLS_MAX', report.totals.count, 'tool list', 'tool count');
   breach('ALL_DEFINITIONS_MAX_BYTES', report.totals.definitionBytes, 'tool list', 'total definition size');
   /** @type {FixtureContext} What the fixtures receive. */
   const context = {
      client,
      setGmAck,
      setGmHandler,
   };
   for (const tool of tools) {
      /** @type {FixtureCase[] | undefined} This tool's fixture. */
      const cases = fixtures[tool.name];
      if (cases === undefined || cases.length === 0) {
         report.failures.push(`tool "${tool.name}": no representative-result fixture`);
         continue;
      }
      if (runFixtures === false || (Array.isArray(runFixtures) && !runFixtures.includes(tool.name))) {
         continue;
      }
      for (const fixtureCase of cases) {
         /** @type {string} The label of this case in messages. */
         const subject = `tool "${tool.name}" fixture "${fixtureCase.label}"`;
         try {
            /** @type {number} The size of the result the real enforcer path returned. */
            const bytes = textBytes(await fixtureCase.run(context));
            report.fixtureRuns.push({
               tool: tool.name,
               label: fixtureCase.label,
               budget: fixtureCase.budget,
               bytes,
               limit: getBudget(fixtureCase.budget).value,
            });
            breach(fixtureCase.budget, bytes, subject, 'result');
         } catch (error) {
            report.failures.push(`${subject}: threw ${error instanceof Error ? error.message : String(error)}`);
         }
      }
   }
   /** @type {Set<string>} The listed tool names. */
   const names = new Set(tools.map((tool) => tool.name));
   /** @type {string} The server instructions, empty when there are none. */
   const instructions = client.getInstructions() ?? '';
   breach('INSTRUCTIONS_MAX_CHARS', instructions.length, 'server instructions', 'length');
   /** @type {{ source: string, text: string }[]} Every text that may name tools. */
   const sources = [
      {
         source: 'server instructions',
         text: instructions,
      },
      ...readSkillFiles(skillsRoot).map((skill) => ({
         source: `skill ${path.relative(skillsRoot, skill.file)}`,
         text: skill.text,
      })),
   ];
   for (const { source, text } of sources) {
      for (const mention of findToolMentions(text)) {
         if (!names.has(mention)) {
            report.failures.push(`${source}: mentions unknown tool "${mention}"`);
         }
      }
   }
   return report;
}
