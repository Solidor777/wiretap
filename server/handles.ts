import { randomBytes } from 'node:crypto';
import { getBudget } from '../shared/budgets.js';
import { resolvePaths } from '../shared/docPath.js';

// Total accounted bytes the store holds across all owners (1 MB is 1,000,000 bytes, as in the 1 KB = 1000 B budgets).
export const HANDLE_STORE_MAX_BYTES: number = 64_000_000;

// Milliseconds a handle may go unread before it expires (30 minutes).
export const HANDLE_IDLE_MS: number = 30 * 60 * 1000;

// Bytes added to every entry's accounted size for its map slot, entry object and handle id.
export const HANDLE_ENTRY_OVERHEAD_BYTES: number = 256;

// Number of random bytes behind one handle id (128 bits, unguessable; base64url gives 22 characters).
const HANDLE_ID_BYTES: number = 16;

/**
 * A short, bounded failure. Store codes are HANDLE_NOT_FOUND, HANDLE_TOO_LARGE, HANDLE_NOT_JSON, HANDLE_BAD_RANGE and
 * HANDLE_WINDOW_TOO_SMALL; path-grammar errors keep their own PATH_* codes.
 */
export interface HandleError {
   code: string;
   message: string;
}

/** A stored value. */
export interface PutSuccess {
   ok: true;
   handle: string;
   /** UTF-8 bytes of the stored text. */
   bytes: number;
}

/** A refused operation. */
export interface Failure {
   ok: false;
   error: HandleError;
}

/** The outcome of storing a value. */
export type PutResult = PutSuccess | Failure;

/** A window of a stored value; `offset`, `length` and `total` count UTF-16 code units of the viewed text. */
export interface SliceSuccess {
   ok: true;
   text: string;
   /** First unit of the window; one less than the requested offset when that offset fell inside a surrogate pair. */
   offset: number;
   length: number;
   /** Units in the viewed text; for a `paths` read, units in the view after it was cut to the window bound. */
   total: number;
   /** Present (true) when a `paths` result was longer than the window bound and the view holds only its start. */
   truncated?: true;
}

/** The outcome of reading a window. */
export type SliceResult = SliceSuccess | Failure;

/** What `slice` reads. */
export interface SliceOptions {
   /** Document paths resolved over the stored JSON; the viewed text becomes `{"values":…,"missing":…}`. */
   paths?: string[];
   /** First UTF-16 code unit of the viewed text to return (default 0). */
   offset?: number;
   /** Most UTF-16 code units to return (default: as many as fit in `maxBytes`). */
   length?: number;
   /** UTF-8 byte bound of the returned text (default 8,000, never more than 16,000). */
   maxBytes?: number;
}

/** Injectable store settings. */
export interface HandleStoreOptions {
   /** Clock in milliseconds, monotonic (default `performance.now()`). */
   now?: () => number;
   /** Total accounted byte capacity (default `HANDLE_STORE_MAX_BYTES`). */
   maxTotalBytes?: number;
   /** Idle milliseconds before a handle expires (default `HANDLE_IDLE_MS`). */
   idleMs?: number;
   /** Largest value in UTF-8 bytes (default: the `HANDLE_ENTRY_MAX_BYTES` budget). */
   maxEntryBytes?: number;
   /** Most handles held at once (default: the `HANDLE_MAX_COUNT` budget). */
   maxCount?: number;
}

/** A per-owner, in-memory store of large results addressed by opaque handles. */
export interface HandleStore {
   /** Store a value for an owner; refuses a value over the entry or total limit. */
   put: (ownerKey: string, text: string) => PutResult;
   /** Read a window of a stored value; only the owner that stored it can read it. */
   slice: (ownerKey: string, handle: unknown, options?: SliceOptions) => SliceResult;
   /** Release every handle an owner holds; returns how many were released. Other owners' handles are untouched. */
   releaseOwner: (ownerKey: string) => number;
   /** The entry count and accounted bytes currently held. */
   stats: () => HandleStats;
}

/** The entry count and accounted bytes of a store. */
export interface HandleStats {
   entries: number;
   bytes: number;
}

/** JSON text produced up to a unit limit. */
export interface BoundedText {
   /** The first units of the JSON text, at most the limit. */
   text: string;
   /** Whether the complete JSON text is longer than the limit. */
   truncated: boolean;
}

/** One stored value. */
interface HandleEntry {
   ownerKey: string;
   text: string;
   /** Accounted bytes: the larger of the UTF-8 and UTF-16 size, plus the per-entry overhead. */
   bytes: number;
   /** Clock reading of the last use; non-decreasing in map order because a use re-inserts the entry last. */
   lastAccess: number;
}

/** An array being written by `boundedStringify`. */
interface ArrayFrame {
   kind: 'array';
   items: unknown[];
   index: number;
}

/** An object being written by `boundedStringify`. */
interface ObjectFrame {
   kind: 'object';
   source: Record<string, unknown>;
   keys: string[];
   index: number;
}

/**
 * Build a failed result.
 * @param {string} code - The error code.
 * @param {string} message - The short message.
 * @returns {Failure} The failure.
 */
function fail(code: string, message: string): Failure {
   return {
      ok: false,
      error: {
         code,
         message,
      },
   };
}

/**
 * The failure for every handle that cannot be read: unknown, expired, evicted or owned by another session. One answer
 * for all four so a caller cannot probe which handles exist.
 * @returns {Failure} The failure.
 */
function notFound(): Failure {
   return fail('HANDLE_NOT_FOUND', 'Handle not found or expired.');
}

/**
 * The failure for a window that cannot hold even the next character.
 * @returns {Failure} The failure.
 */
function windowTooSmall(): Failure {
   return fail('HANDLE_WINDOW_TOO_SMALL', 'maxBytes is too small for the next character; raise it.');
}

/**
 * Check that a value is a non-negative integer.
 * @param {unknown} value - The candidate.
 * @returns {boolean} Whether it is.
 */
function isNonNegativeInteger(value: unknown): value is number {
   return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Check whether a UTF-16 code unit is a high (leading) surrogate.
 * @param {number} unit - The code unit.
 * @returns {boolean} Whether it is one.
 */
function isHighSurrogate(unit: number): boolean {
   return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Check whether a UTF-16 code unit is a low (trailing) surrogate.
 * @param {number} unit - The code unit.
 * @returns {boolean} Whether it is one.
 */
function isLowSurrogate(unit: number): boolean {
   return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Serialize JSON data like `JSON.stringify` but stop as soon as the output is longer than the limit, so the cost is
 * proportional to the limit and not to the size of the value. Iterative, so nesting depth cannot overflow the stack.
 * INVARIANT: the value is plain JSON data as produced by `JSON.parse` (no `toJSON`, `undefined`, functions or BigInt).
 * @param {unknown} value - The JSON data.
 * @param {number} maxUnits - The most UTF-16 code units of output to return.
 * @returns {BoundedText} The first `maxUnits` units of the output and whether the output was longer.
 */
export function boundedStringify(value: unknown, maxUnits: number): BoundedText {
   // The pieces of output written so far.
   const pieces: string[] = [];
   // Units written so far.
   let written: number = 0;
   // The containers being written, innermost last.
   const stack: (ArrayFrame | ObjectFrame)[] = [];

   /**
    * Append output.
    * @param {string} piece - The text to append.
    * @returns {void}
    */
   function emit(piece: string): void {
      pieces.push(piece);
      written += piece.length;
   }

   /**
    * Write a scalar, or open a container and push its frame.
    * @param {unknown} item - The value to write.
    * @returns {void}
    */
   function begin(item: unknown): void {
      if (Array.isArray(item)) {
         emit('[');
         stack.push({
            kind: 'array',
            items: item,
            index: 0,
         });
      } else if (typeof item === 'object' && item !== null) {
         emit('{');
         stack.push({
            kind: 'object',
            source: item as Record<string, unknown>,
            keys: Object.keys(item),
            index: 0,
         });
      } else if (typeof item === 'string' && item.length > maxUnits - written + 1) {
         // A string past the limit is cut first; its encoding still overflows, and the cut never reaches the output.
         emit(JSON.stringify(item.slice(0, Math.max(maxUnits - written + 1, 0))));
      } else {
         emit(JSON.stringify(item));
      }
   }

   begin(value);
   while (stack.length > 0 && written <= maxUnits) {
      // The container being written.
      const frame: ArrayFrame | ObjectFrame = stack[stack.length - 1];
      // The number of members in it.
      const size: number = frame.kind === 'array' ? frame.items.length : frame.keys.length;
      if (frame.index >= size) {
         emit(frame.kind === 'array' ? ']' : '}');
         stack.pop();
         continue;
      }
      if (frame.index > 0) {
         emit(',');
      }
      if (frame.kind === 'array') {
         begin(frame.items[frame.index]);
      } else {
         // The key of this member.
         const key: string = frame.keys[frame.index];
         emit(`${JSON.stringify(key)}:`);
         begin(frame.source[key]);
      }
      frame.index += 1;
   }
   // The output so far, joined once.
   const text: string = pieces.join('');
   return text.length > maxUnits
      ? {
           text: text.slice(0, maxUnits),
           truncated: true,
        }
      : {
           text,
           truncated: false,
        };
}

/**
 * Create a handle store. Values live in memory only. Each entry is accounted as the larger of its UTF-8 and UTF-16
 * size plus a fixed overhead; the oldest-used handles are evicted when the accounted capacity or the handle count is
 * exceeded, and a handle unread for the idle limit expires. A handle is readable only by the owner key that stored it.
 * The store has no timers; expired entries are released on the next `put` or `slice`.
 * @param {HandleStoreOptions} [options] - Clock, capacity, entry limit, count limit and idle limit overrides.
 * @returns {HandleStore} An empty store.
 */
export function createHandleStore(options: HandleStoreOptions = {}): HandleStore {
   // The monotonic clock; the wall clock can jump, which would expire or revive handles.
   const now: () => number = options.now ?? ((): number => performance.now());
   // The byte capacity across all owners.
   const maxTotalBytes: number = options.maxTotalBytes ?? HANDLE_STORE_MAX_BYTES;
   // The idle limit in milliseconds.
   const idleMs: number = options.idleMs ?? HANDLE_IDLE_MS;
   // The largest single value in UTF-8 bytes.
   const maxEntryBytes: number = options.maxEntryBytes ?? getBudget('HANDLE_ENTRY_MAX_BYTES').value;
   // The most handles held at once.
   const maxCount: number = options.maxCount ?? getBudget('HANDLE_MAX_COUNT').value;
   // The default window bound.
   const defaultMaxBytes: number = getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value;
   // The largest window bound a caller may ask for.
   const largestMaxBytes: number = getBudget('RESULT_HARD_CAP_MAX_BYTES').value;
   // Entries in least-recently-used-first order: a use re-inserts its entry at the end, so map order is `lastAccess`
   // order and expiry only ever needs to look at the front.
   const entries: Map<string, HandleEntry> = new Map();
   // Total accounted bytes of the stored entries.
   let totalBytes: number = 0;

   /**
    * Remove one entry and release its bytes.
    * @param {string} handle - The handle.
    * @returns {void}
    */
   function drop(handle: string): void {
      // The entry being released.
      const entry: HandleEntry | undefined = entries.get(handle);
      if (entry) {
         totalBytes -= entry.bytes;
         entries.delete(handle);
      }
   }

   /**
    * Release every entry idle for `idleMs` or longer. Walks the map from the oldest use and stops at the first live
    * entry, since every later entry was used at least as recently.
    * @returns {void}
    */
   function purgeExpired(): void {
      // The current time.
      const current: number = now();
      for (const [handle, entry] of entries) {
         if (current - entry.lastAccess < idleMs) {
            break;
         }
         drop(handle);
      }
   }

   /**
    * Mark an entry as just used and move it to the most-recently-used end.
    * @param {string} handle - The handle.
    * @param {HandleEntry} entry - Its entry.
    * @returns {void}
    */
   function touch(handle: string, entry: HandleEntry): void {
      entries.delete(handle);
      entry.lastAccess = now();
      entries.set(handle, entry);
   }

   return {
      put(ownerKey: string, text: string): PutResult {
         // The UTF-8 size of the value.
         const bytes: number = Buffer.byteLength(text, 'utf8');
         if (bytes > maxEntryBytes) {
            return fail(
               'HANDLE_TOO_LARGE',
               `Result of ${bytes} bytes exceeds the ${maxEntryBytes} byte handle limit.`,
            );
         }
         // The accounted size: V8 may hold the text as two bytes per unit, so the larger of the two sizes counts.
         const accounted: number = Math.max(bytes, 2 * text.length) + HANDLE_ENTRY_OVERHEAD_BYTES;
         if (accounted > maxTotalBytes) {
            return fail(
               'HANDLE_TOO_LARGE',
               `Result of ${bytes} bytes exceeds the ${maxTotalBytes} byte handle store.`,
            );
         }
         purgeExpired();
         while (entries.size > 0 && (entries.size >= maxCount || totalBytes + accounted > maxTotalBytes)) {
            // The least recently used handle.
            const oldest: IteratorResult<string> = entries.keys().next();
            if (oldest.done) {
               break;
            }
            drop(oldest.value);
         }
         // The new opaque id.
         const handle: string = randomBytes(HANDLE_ID_BYTES).toString('base64url');
         entries.set(handle, {
            ownerKey,
            text,
            bytes: accounted,
            lastAccess: now(),
         });
         totalBytes += accounted;
         return {
            ok: true,
            handle,
            bytes,
         };
      },

      slice(ownerKey: string, handle: unknown, sliceOptions: SliceOptions = {}): SliceResult {
         purgeExpired();
         // The entry, when the handle exists.
         const entry: HandleEntry | undefined = typeof handle === 'string' ? entries.get(handle) : undefined;
         if (typeof handle !== 'string' || !entry || entry.ownerKey !== ownerKey) {
            return notFound();
         }
         // The requested window start.
         const offset: unknown = sliceOptions.offset ?? 0;
         // The requested window length, when given.
         const length: unknown = sliceOptions.length;
         if (!isNonNegativeInteger(offset)) {
            return fail('HANDLE_BAD_RANGE', 'offset must be a non-negative integer.');
         }
         if (length !== undefined && (!isNonNegativeInteger(length) || length < 1)) {
            return fail('HANDLE_BAD_RANGE', 'length must be a positive integer.');
         }
         // The byte bound of the window.
         const maxBytes: number =
            typeof sliceOptions.maxBytes === 'number' && Number.isFinite(sliceOptions.maxBytes)
               ? Math.min(sliceOptions.maxBytes, largestMaxBytes)
               : defaultMaxBytes;
         // The text the window is cut from.
         let view: string = entry.text;
         // Whether a paths result was cut at the window bound.
         let truncated: boolean = false;
         if (sliceOptions.paths !== undefined) {
            let parsed: unknown;
            try {
               parsed = JSON.parse(entry.text);
            } catch {
               return fail('HANDLE_NOT_JSON', 'The stored result is not JSON; read it with offset and length.');
            }
            // The path lookups over the parsed document.
            const resolved: ReturnType<typeof resolvePaths> = resolvePaths(parsed, sliceOptions.paths);
            if (!resolved.ok) {
               return {
                  ok: false,
                  error: resolved.error,
               };
            }
            // The paths result written only as far as one window can reach; one unit is at least one UTF-8 byte.
            const bounded: BoundedText = boundedStringify(
               {
                  values: resolved.values,
                  missing: resolved.missing,
               },
               maxBytes,
            );
            view = bounded.text;
            truncated = bounded.truncated;
            if (truncated && view.length > 0 && isHighSurrogate(view.charCodeAt(view.length - 1))) {
               view = view.slice(0, -1);
            }
            if (truncated && view.length === 0) {
               return windowTooSmall();
            }
         }
         if (offset > view.length) {
            return fail('HANDLE_BAD_RANGE', `offset ${offset} is past the end (total ${view.length}).`);
         }
         // The window start; an offset inside a surrogate pair moves back to the pair's first unit.
         const start: number =
            offset > 0 &&
            offset < view.length &&
            isLowSurrogate(view.charCodeAt(offset)) &&
            isHighSurrogate(view.charCodeAt(offset - 1))
               ? offset - 1
               : offset;
         // Where the requested length ends the window.
         const limit: number = Math.min(view.length, start + (length ?? Infinity));
         // The window end and the UTF-8 bytes used so far. The scan costs at most maxBytes + 1 steps because every
         // unit takes at least one byte, so a read is O(maxBytes) however long the entry is.
         let end: number = start;
         let used: number = 0;
         while (end < limit) {
            // The unit at the scan position.
            const unit: number = view.charCodeAt(end);
            // Whether it opens a surrogate pair.
            const pair: boolean =
               isHighSurrogate(unit) && end + 1 < view.length && isLowSurrogate(view.charCodeAt(end + 1));
            // UTF-8 bytes of this character: 1, 2 or 3 for one unit (a lone surrogate encodes as three), 4 for a pair.
            const width: number = pair ? 4 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
            if (used + width > maxBytes) {
               break;
            }
            // Units of this character.
            const units: number = pair ? 2 : 1;
            if (end + units > limit && end > start) {
               break;
            }
            used += width;
            end += units;
         }
         if (end === start && start < view.length) {
            return windowTooSmall();
         }
         touch(handle, entry);
         const result: SliceSuccess = {
            ok: true,
            text: view.slice(start, end),
            offset: start,
            length: end - start,
            total: view.length,
         };
         if (truncated) {
            result.truncated = true;
         }
         return result;
      },

      releaseOwner(ownerKey: string): number {
         // The handles of this owner, collected first because `drop` changes the map during iteration.
         const owned: string[] = [];
         for (const [handle, entry] of entries) {
            if (entry.ownerKey === ownerKey) {
               owned.push(handle);
            }
         }
         for (const handle of owned) {
            drop(handle);
         }
         return owned.length;
      },

      stats(): HandleStats {
         return {
            entries: entries.size,
            bytes: totalBytes,
         };
      },
   };
}
