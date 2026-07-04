import type { PluginContext } from './index.js';

/**
 * A mock PluginContext for unit-testing a plugin without a running TREK
 * (#plugins, M6). It enforces the SAME permission model: calling a capability
 * your plugin wasn't granted throws PERMISSION_DENIED — so a test can prove your
 * plugin degrades gracefully. Data access returns configured fixtures; the db is
 * a lightweight recorder (configure results, or use an integration test for real
 * SQL).
 */

export interface MockHostOptions {
  grants?: string[];
  config?: Record<string, unknown>;
  /** Fixtures keyed by trip id; `members` gates access like the real host. */
  trips?: Record<number, { members: number[]; data?: unknown; places?: unknown[]; reservations?: unknown[] }>;
  users?: Record<number, unknown>;
  /** Optional canned db.query results, keyed by the exact sql string. */
  queryResults?: Record<string, unknown[]>;
}

export interface MockHost {
  ctx: PluginContext;
  /** Everything the plugin did, for assertions. */
  calls: { method: string; args: unknown[] }[];
  logs: { level: string; msg: string }[];
  broadcasts: { kind: 'trip' | 'user'; target: number; event: string; data: unknown }[];
}

class PermissionDenied extends Error {}

export function createMockHost(opts: MockHostOptions = {}): MockHost {
  const grants = new Set(opts.grants ?? []);
  const calls: MockHost['calls'] = [];
  const logs: MockHost['logs'] = [];
  const broadcasts: MockHost['broadcasts'] = [];

  const need = (perm: string, method: string) => {
    calls.push({ method, args: [] });
    if (!grants.has(perm)) throw new PermissionDenied(`PERMISSION_DENIED: ${method} requires ${perm}`);
  };
  const assertMember = (tripId: number, asUserId: number) => {
    const t = opts.trips?.[tripId];
    if (!t || !t.members.includes(asUserId)) throw new Error(`RESOURCE_FORBIDDEN: no access to trip ${tripId}`);
    return t;
  };

  const ctx: PluginContext = {
    id: 'mock-plugin',
    config: Object.freeze({ ...(opts.config ?? {}) }),
    db: {
      async query(sql) {
        need('db:own', 'db.query');
        return (opts.queryResults?.[sql] ?? []) as never[];
      },
      async exec() {
        need('db:own', 'db.exec');
        return { changes: 0 };
      },
      async migrate() {
        need('db:own', 'db.migrate');
        return { applied: true };
      },
    },
    trips: {
      async getById(tripId, asUserId) {
        need('db:read:trips', 'trips.getById');
        return assertMember(tripId, asUserId).data ?? null;
      },
      async getPlaces(tripId, asUserId) {
        need('db:read:trips', 'trips.getPlaces');
        return assertMember(tripId, asUserId).places ?? [];
      },
      async getReservations(tripId, asUserId) {
        need('db:read:trips', 'trips.getReservations');
        return assertMember(tripId, asUserId).reservations ?? [];
      },
    },
    users: {
      async getById(id) {
        need('db:read:users', 'users.getById');
        return opts.users?.[id] ?? null;
      },
    },
    ws: {
      async broadcastToTrip(tripId, event, data) {
        need('ws:broadcast:trip', 'ws.broadcastToTrip');
        broadcasts.push({ kind: 'trip', target: tripId, event, data });
      },
      async broadcastToUser(userId, event, data) {
        need('ws:broadcast:user', 'ws.broadcastToUser');
        broadcasts.push({ kind: 'user', target: userId, event, data });
      },
    },
    log: {
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
      error: (msg) => logs.push({ level: 'error', msg }),
    },
  };

  return { ctx, calls, logs, broadcasts };
}
