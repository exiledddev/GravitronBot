'use strict';

/**
 * Reusable persistent temporary-role service.
 *
 * Role grants are stored in SQLite so an expiration survives a restart, a crash
 * or a redeploy: the stored `expires_at` is the authoritative expiration time and
 * is never recalculated from process uptime.
 *
 * The service is deliberately generic - it knows nothing about Media Ranks - so
 * any future temporary role can reuse it via grantTemporaryRole().
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_DATABASE_PATH = path.join(__dirname, 'data', 'northstar-utils.sqlite');
const DEFAULT_EXPIRATION_INTERVAL_MS = 60 * 1000;

let database = null;
let expirationTimer = null;
let isProcessingExpirations = false;

function getDatabasePath() {
  return process.env.TEMPORARY_ROLE_DB_PATH || DEFAULT_DATABASE_PATH;
}

function initializeTemporaryRoleStore(databasePath = getDatabasePath()) {
  if (database) {
    return database;
  }

  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS temporary_media_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      notified_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS temporary_media_roles_assignment
      ON temporary_media_roles (guild_id, user_id, role_id);
    CREATE INDEX IF NOT EXISTS temporary_media_roles_expires_at
      ON temporary_media_roles (expires_at);
  `);

  // Migration path for stores created before notified_at existed.
  const columns = database.prepare('PRAGMA table_info(temporary_media_roles)').all().map((column) => column.name);
  if (!columns.includes('notified_at')) {
    database.exec('ALTER TABLE temporary_media_roles ADD COLUMN notified_at TEXT');
  }

  return database;
}

function requireDatabase() {
  if (!database) {
    throw new Error('Temporary role store has not been initialized.');
  }

  return database;
}

function isTemporaryRoleStoreReady() {
  return database !== null;
}

/**
 * Grant (or renew) a temporary role assignment.
 *
 * Renewing an assignment for the same guild/user/role overwrites the existing
 * record, so expiration stays deterministic and no conflicting active records
 * are left behind for the same assignment.
 */
function grantTemporaryRole({ guildId, userId, roleId, durationMs }) {
  const db = requireDatabase();

  if (!guildId || !userId || !roleId) {
    throw new Error('grantTemporaryRole requires guildId, userId and roleId.');
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('grantTemporaryRole requires a positive durationMs.');
  }

  const grantedAt = new Date();
  const expiresAt = new Date(grantedAt.getTime() + durationMs);

  db.prepare(`
    INSERT INTO temporary_media_roles (guild_id, user_id, role_id, granted_at, expires_at, notified_at)
    VALUES (@guildId, @userId, @roleId, @grantedAt, @expiresAt, NULL)
    ON CONFLICT (guild_id, user_id, role_id) DO UPDATE SET
      granted_at = excluded.granted_at,
      expires_at = excluded.expires_at,
      notified_at = NULL
  `).run({
    guildId,
    userId,
    roleId,
    grantedAt: grantedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return { guildId, userId, roleId, grantedAt, expiresAt };
}

function getActiveTemporaryRole({ guildId, userId, roleId }) {
  return requireDatabase().prepare(`
    SELECT * FROM temporary_media_roles
    WHERE guild_id = ? AND user_id = ? AND role_id = ?
  `).get(guildId, userId, roleId) || null;
}

function listExpiredTemporaryRoles(now = new Date()) {
  return requireDatabase().prepare(`
    SELECT * FROM temporary_media_roles
    WHERE expires_at <= ?
    ORDER BY expires_at ASC
  `).all(now.toISOString());
}

function listTemporaryRoles() {
  return requireDatabase().prepare('SELECT * FROM temporary_media_roles ORDER BY expires_at ASC').all();
}

function markTemporaryRoleNotified(id, notifiedAt = new Date()) {
  requireDatabase()
    .prepare('UPDATE temporary_media_roles SET notified_at = ? WHERE id = ?')
    .run(notifiedAt.toISOString(), id);
}

function deleteTemporaryRole(id) {
  requireDatabase().prepare('DELETE FROM temporary_media_roles WHERE id = ?').run(id);
}

async function resolveGuild(client, guildId) {
  const cached = client.guilds.cache.get(guildId);
  if (cached) {
    return cached;
  }

  try {
    return await client.guilds.fetch(guildId);
  } catch (error) {
    return null;
  }
}

/**
 * Process every assignment whose expiration time has passed.
 *
 * Each record is handled independently: one failure never aborts the batch, and
 * a record is only deleted once its role has actually been dealt with, so a
 * transient Discord outage simply retries on the next run.
 */
async function processExpiredTemporaryRoles({ client, notify } = {}) {
  if (!isTemporaryRoleStoreReady() || isProcessingExpirations) {
    return { processed: 0, skipped: 0, failed: 0 };
  }

  isProcessingExpirations = true;
  const summary = { processed: 0, skipped: 0, failed: 0 };

  try {
    const expiredRecords = listExpiredTemporaryRoles();

    for (const record of expiredRecords) {
      try {
        const guild = await resolveGuild(client, record.guild_id);
        if (!guild) {
          // The guild may only be temporarily unreachable, so keep the record.
          summary.skipped += 1;
          continue;
        }

        let member = null;
        try {
          member = await guild.members.fetch(record.user_id);
        } catch (error) {
          member = null;
        }

        if (!member) {
          // Member left the guild: clean up without attempting a DM.
          deleteTemporaryRole(record.id);
          summary.processed += 1;
          continue;
        }

        if (member.roles.cache.has(record.role_id)) {
          await member.roles.remove(record.role_id, 'Temporary role expired.');
        }

        if (!record.notified_at && typeof notify === 'function') {
          try {
            await notify({ member, guild, roleId: record.role_id, record });
          } catch (error) {
            console.error(`Failed to notify ${record.user_id} about an expired temporary role:`, error);
          }

          // Marked even when the DM failed (for example closed DMs) so the
          // notification is never retried in a loop.
          markTemporaryRoleNotified(record.id);
        }

        deleteTemporaryRole(record.id);
        summary.processed += 1;
      } catch (error) {
        // Leave the record in place so the next run retries it.
        summary.failed += 1;
        console.error(`Failed to process expired temporary role record ${record.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Failed to process expired temporary roles:', error);
  } finally {
    isProcessingExpirations = false;
  }

  return summary;
}

function startTemporaryRoleExpirationWorker({ client, notify, intervalMs = DEFAULT_EXPIRATION_INTERVAL_MS } = {}) {
  stopTemporaryRoleExpirationWorker();

  expirationTimer = setInterval(() => {
    processExpiredTemporaryRoles({ client, notify }).catch((error) => {
      console.error('Temporary role expiration worker run failed:', error);
    });
  }, intervalMs);

  return expirationTimer;
}

function stopTemporaryRoleExpirationWorker() {
  if (expirationTimer) {
    clearInterval(expirationTimer);
    expirationTimer = null;
  }
}

function closeTemporaryRoleStore() {
  stopTemporaryRoleExpirationWorker();

  if (database) {
    database.close();
    database = null;
  }
}

module.exports = {
  DEFAULT_EXPIRATION_INTERVAL_MS,
  initializeTemporaryRoleStore,
  isTemporaryRoleStoreReady,
  grantTemporaryRole,
  getActiveTemporaryRole,
  listTemporaryRoles,
  listExpiredTemporaryRoles,
  markTemporaryRoleNotified,
  deleteTemporaryRole,
  processExpiredTemporaryRoles,
  startTemporaryRoleExpirationWorker,
  stopTemporaryRoleExpirationWorker,
  closeTemporaryRoleStore,
};
