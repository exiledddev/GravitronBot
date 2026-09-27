'use strict';

/**
 * Shared SQLite connection.
 *
 * Every persistent feature in the bot stores its tables in one database file.
 * Opening a second connection to the same file works under WAL but invites
 * SQLITE_BUSY and gives each module its own statement cache for no benefit, so
 * connections are memoised per resolved path instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DEFAULT_DATABASE_PATH = path.join(__dirname, 'data', 'northstar-utils.sqlite');

const openDatabases = new Map();

function getDefaultDatabasePath() {
  // TEMPORARY_ROLE_DB_PATH predates this file holding more than temporary roles;
  // it stays supported so existing deployments keep working.
  return process.env.NORTHSTAR_DB_PATH || process.env.TEMPORARY_ROLE_DB_PATH || DEFAULT_DATABASE_PATH;
}

function openSharedDatabase(databasePath = getDefaultDatabasePath()) {
  const entry = openDatabases.get(databasePath);
  if (entry && entry.database.open) {
    entry.references += 1;
    return entry.database;
  }

  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  openDatabases.set(databasePath, { database, references: 1 });

  return database;
}

/**
 * Release one module's hold on the connection. The handle is only really closed
 * once every module that opened it has let go, so one store closing can never
 * pull the connection out from under another.
 */
function closeSharedDatabase(databasePath = getDefaultDatabasePath()) {
  const entry = openDatabases.get(databasePath);
  if (!entry) {
    return;
  }

  entry.references -= 1;
  if (entry.references > 0) {
    return;
  }

  if (entry.database.open) {
    entry.database.close();
  }
  openDatabases.delete(databasePath);
}

module.exports = {
  DEFAULT_DATABASE_PATH,
  getDefaultDatabasePath,
  openSharedDatabase,
  closeSharedDatabase,
};
