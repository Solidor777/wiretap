import { getBudget } from '../shared/budgets.js';
import { describeCause } from './logText.ts';

// Milliseconds an MCP session may go without a request before it expires (30 minutes).
export const MCP_SESSION_IDLE_MS: number = 30 * 60 * 1000;

// Milliseconds between idle-expiry sweeps; a session expires at the first sweep at or after its idle limit.
export const MCP_SESSION_SWEEP_MS: number = 60 * 1000;

// Milliseconds of quiet after the last registry or endpoint change before sessions are told the tool list changed.
export const LIST_CHANGED_QUIET_MS: number = 200;

// Longest wait in milliseconds from the first change of a burst to the notification, however long the changes
// continue.
export const LIST_CHANGED_MAX_WAIT_MS: number = 1000;

/** The timer functions the session manager and debouncer schedule with. */
export interface SessionTimers {
   setTimeout: (callback: () => void, ms: number) => unknown;
   clearTimeout: (handle: unknown) => void;
   setInterval: (callback: () => void, ms: number) => unknown;
   clearInterval: (handle: unknown) => void;
}

/** What the session manager needs to know about a session. */
export interface ManagedSession {
   /** The session id. */
   id: string;
   /** Ends the session's transport and server; its failure is logged and never stops the manager. */
   close: () => Promise<void> | void;
}

/** Injectable settings of the session manager. */
export interface SessionManagerOptions {
   /** Most sessions held at once (default: the `MCP_SESSIONS_MAX` budget). */
   maxSessions?: number;
   /** Idle milliseconds before a session expires (default `MCP_SESSION_IDLE_MS`). */
   idleMs?: number;
   /** Milliseconds between expiry sweeps (default `MCP_SESSION_SWEEP_MS`). */
   sweepMs?: number;
   /** Monotonic clock in milliseconds (default `performance.now()`). */
   now?: () => number;
   /** Timer functions (default: the global timers, looked up at call time). */
   timers?: SessionTimers;
   /** Called synchronously, once, when a session leaves the manager and before its `close`. */
   onEnd?: (id: string) => void;
   /** Receives one sidecar log line (default: `console.log`). */
   log?: (line: string) => void;
}

/** The set of live sessions with idle expiry and a size cap. */
export interface SessionManager {
   /**
    * Hold a session. Returns false, holding nothing and closing nothing, when the cap is reached; a disposed manager
    * closes the session at once and returns false. No held session is ever ended to make room: the idle sweep frees
    * slots.
    */
   add: (session: ManagedSession) => boolean;
   /** Look a session up without counting it as activity. */
   get: (id: string) => ManagedSession | undefined;
   /** Record a request on a session, restarting its idle clock; ignored for an unknown id. */
   touch: (id: string) => void;
   /** Remove a session, run the end hook and close it; resolves once closed. A repeat or unknown id is a no-op. */
   end: (id: string) => Promise<void>;
   /** The number of sessions held. */
   size: () => number;
   /** Whether the held sessions plus `reserved` pending ones have reached the cap. */
   isFull: (reserved?: number) => boolean;
   /** Every held session in least-recently-active-first order. */
   list: () => ManagedSession[];
   /** End every session, which stops the sweep; sessions added afterwards are closed at once. */
   dispose: () => void;
}

/** One held session and its last activity. */
interface SessionEntry {
   session: ManagedSession;
   /** Clock reading of the last request; non-decreasing in map order because `touch` re-inserts the entry last. */
   lastActivity: number;
}

/** Injectable settings of the debouncer. */
export interface DebouncerOptions {
   /** Quiet milliseconds after the latest trigger before `run` fires. */
   quietMs: number;
   /** Longest milliseconds from the first trigger of a burst to `run`, however long the triggers continue. */
   maxWaitMs: number;
   /** The action to debounce. */
   run: () => void;
   /** Monotonic clock in milliseconds (default `performance.now()`). */
   now?: () => number;
   /** Timer functions (default: the global timers, looked up at call time). */
   timers?: SessionTimers;
}

/** A trailing debouncer with a maximum wait. */
export interface Debouncer {
   /** Note a change; `run` fires once after the burst of triggers ends. */
   trigger: () => void;
   /** Drop a pending run and its timer. */
   cancel: () => void;
}

// The global timers, looked up at call time so test fake timers installed later are honoured. The handles are
// unreferenced: a pending sweep or notification never keeps the process alive.
const DEFAULT_TIMERS: SessionTimers = {
   setTimeout: (callback, ms) => {
      const handle: ReturnType<typeof setTimeout> = setTimeout(callback, ms);
      handle.unref?.();
      return handle;
   },
   clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
   setInterval: (callback, ms) => {
      const handle: ReturnType<typeof setInterval> = setInterval(callback, ms);
      handle.unref?.();
      return handle;
   },
   clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Create the session manager. Idle rule: a session's idle clock restarts only on `touch`, which the HTTP layer calls
 * for every request that carries the session id (POST, the GET that opens the event stream, DELETE, and so a client
 * `ping`). An open event stream refreshes nothing by itself and the server writes no keepalive of its own, so a client
 * that holds a stream open but sends nothing expires after the idle limit. One interval runs only while a session
 * exists; no per-session timer exists.
 * @param {SessionManagerOptions} [options] - Cap, idle limit, sweep period, clock, timers, end hook and logger.
 * @returns {SessionManager} An empty manager.
 */
export function createSessionManager(options: SessionManagerOptions = {}): SessionManager {
   // The session cap.
   const maxSessions: number = options.maxSessions ?? getBudget('MCP_SESSIONS_MAX').value;
   // The idle limit in milliseconds.
   const idleMs: number = options.idleMs ?? MCP_SESSION_IDLE_MS;
   // The sweep period in milliseconds.
   const sweepMs: number = options.sweepMs ?? MCP_SESSION_SWEEP_MS;
   // The monotonic clock; the wall clock can jump, which would expire or revive sessions.
   const now: () => number = options.now ?? ((): number => performance.now());
   // The timer functions.
   const timers: SessionTimers = options.timers ?? DEFAULT_TIMERS;
   // The sidecar log sink.
   const log: (line: string) => void = options.log ?? ((line) => console.log(line));
   // Held sessions, least recently active first.
   const sessions: Map<string, SessionEntry> = new Map();
   // The sweep interval handle while one runs.
   let sweep: unknown;
   // Whether the sweep interval is running (a handle may be any value, including a falsy one).
   let sweeping: boolean = false;
   // Set by `dispose`; a session added afterwards is closed at once.
   let disposed: boolean = false;

   /**
    * Stop the sweep interval if it runs.
    * @returns {void}
    */
   function stopSweep(): void {
      if (sweeping) {
         timers.clearInterval(sweep);
         sweeping = false;
      }
   }

   /**
    * Close a session; a failure is logged, never thrown.
    * @param {ManagedSession} session - The session.
    * @returns {Promise<void>} Resolves when the session is closed; never rejects.
    */
   async function closeLogged(session: ManagedSession): Promise<void> {
      try {
         await session.close();
      } catch (cause) {
         log(`Wiretap sidecar | MCP session ${session.id} close failed: ${describeCause(cause)}`);
      }
   }

   /**
    * Remove a session, run the end hook and close it.
    * @param {string} id - The session id.
    * @returns {Promise<void>} Resolves when the session is closed; never rejects.
    */
   async function end(id: string): Promise<void> {
      // The session being ended.
      const entry: SessionEntry | undefined = sessions.get(id);
      if (!entry) {
         return;
      }
      sessions.delete(id);
      if (sessions.size === 0) {
         stopSweep();
      }
      try {
         options.onEnd?.(id);
      } catch (cause) {
         log(`Wiretap sidecar | MCP session ${id} end hook failed: ${describeCause(cause)}`);
      }
      await closeLogged(entry.session);
   }

   /**
    * End every session idle for `idleMs` or longer. Walks from the least recently active and stops at the first live
    * one, since every later session was active at least as recently.
    * @returns {void}
    */
   function expireIdle(): void {
      // The current time.
      const current: number = now();
      // The ids to end, collected first because `end` changes the map.
      const expired: string[] = [];
      for (const [id, entry] of sessions) {
         if (current - entry.lastActivity < idleMs) {
            break;
         }
         expired.push(id);
      }
      for (const id of expired) {
         log(`Wiretap sidecar | MCP session ${id} expired after ${idleMs} ms idle`);
         void end(id);
      }
   }

   return {
      add(session: ManagedSession): boolean {
         if (disposed) {
            void closeLogged(session);
            return false;
         }
         if (sessions.size >= maxSessions) {
            return false;
         }
         sessions.set(session.id, {
            session,
            lastActivity: now(),
         });
         if (!sweeping) {
            sweep = timers.setInterval(expireIdle, sweepMs);
            sweeping = true;
         }
         return true;
      },

      get(id: string): ManagedSession | undefined {
         return sessions.get(id)?.session;
      },

      touch(id: string): void {
         // The entry to move to the most recently active end.
         const entry: SessionEntry | undefined = sessions.get(id);
         if (entry) {
            sessions.delete(id);
            entry.lastActivity = now();
            sessions.set(id, entry);
         }
      },

      end,

      size(): number {
         return sessions.size;
      },

      isFull(reserved: number = 0): boolean {
         return sessions.size + reserved >= maxSessions;
      },

      list(): ManagedSession[] {
         return [...sessions.values()].map((entry) => entry.session);
      },

      dispose(): void {
         disposed = true;
         // Ending the last session stops the sweep, and no sweep runs while there is none.
         for (const id of [...sessions.keys()]) {
            void end(id);
         }
      },
   };
}

/**
 * Create a trailing debouncer with a maximum wait: each trigger restarts the quiet period, but `run` still fires
 * `maxWaitMs` after the first trigger of a burst, so a client that keeps changing its registry is notified at least
 * that often. At most one timer exists, and none while no run is pending.
 * @param {DebouncerOptions} options - Quiet period, maximum wait, action, clock and timers.
 * @returns {Debouncer} The debouncer.
 */
export function createDebouncer(options: DebouncerOptions): Debouncer {
   // The monotonic clock.
   const now: () => number = options.now ?? ((): number => performance.now());
   // The timer functions.
   const timers: SessionTimers = options.timers ?? DEFAULT_TIMERS;
   // The pending timer handle, valid while `pending` is true.
   let timer: unknown;
   // Whether a run is scheduled.
   let pending: boolean = false;
   // Clock reading of the first trigger of the current burst.
   let burstStart: number = 0;

   /**
    * Fire the action; a trigger made by the action starts a new burst.
    * @returns {void}
    */
   function fire(): void {
      pending = false;
      options.run();
   }

   return {
      trigger(): void {
         // The current time.
         const current: number = now();
         if (pending) {
            timers.clearTimeout(timer);
         } else {
            pending = true;
            burstStart = current;
         }
         timer = timers.setTimeout(fire, Math.min(options.quietMs, burstStart + options.maxWaitMs - current));
      },

      cancel(): void {
         if (pending) {
            timers.clearTimeout(timer);
            pending = false;
         }
      },
   };
}
