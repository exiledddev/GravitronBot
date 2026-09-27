'use strict';

/**
 * Persistence for actor project ("scene") tickets.
 *
 * A scene ticket needs to remember two things a Discord channel cannot: the
 * details it was opened with, and who is cast in which part. Channel topics cap
 * at 1024 characters, so a cast list cannot live there - it goes in SQLite,
 * alongside the temporary role store, through the shared connection.
 */

const { getDefaultDatabasePath, openSharedDatabase, closeSharedDatabase } = require('./storage');

let database = null;
let databaseFilePath = null;

function initializeSceneStore(databasePath = getDefaultDatabasePath()) {
  if (database) {
    return database;
  }

  databaseFilePath = databasePath;
  database = openSharedDatabase(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS scenes (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      episode TEXT NOT NULL,
      deadline TEXT,
      director_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      script_file_name TEXT
    );

    CREATE TABLE IF NOT EXISTS scene_cast (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_name TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS scene_cast_member
      ON scene_cast (channel_id, user_id);
    CREATE INDEX IF NOT EXISTS scene_cast_channel
      ON scene_cast (channel_id);
  `);

  return database;
}

function requireDatabase() {
  if (!database) {
    throw new Error('Scene store has not been initialized.');
  }

  return database;
}

function isSceneStoreReady() {
  return database !== null;
}

function createScene({ channelId, guildId, name, episode, deadline, directorId, createdBy, scriptFileName }) {
  const db = requireDatabase();

  if (!channelId || !guildId || !name || !episode || !directorId || !createdBy) {
    throw new Error('createScene requires channelId, guildId, name, episode, directorId and createdBy.');
  }

  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO scenes (channel_id, guild_id, name, episode, deadline, director_id, created_by, created_at, script_file_name)
    VALUES (@channelId, @guildId, @name, @episode, @deadline, @directorId, @createdBy, @createdAt, @scriptFileName)
    ON CONFLICT (channel_id) DO UPDATE SET
      name = excluded.name,
      episode = excluded.episode,
      deadline = excluded.deadline,
      director_id = excluded.director_id,
      script_file_name = excluded.script_file_name
  `).run({
    channelId,
    guildId,
    name,
    episode,
    deadline: deadline || null,
    directorId,
    createdBy,
    createdAt,
    scriptFileName: scriptFileName || null,
  });

  return getScene(channelId);
}

function getScene(channelId) {
  return requireDatabase().prepare('SELECT * FROM scenes WHERE channel_id = ?').get(channelId) || null;
}

function isSceneChannelId(channelId) {
  return getScene(channelId) !== null;
}

/**
 * Cast a member in a part, or update the part they already hold.
 *
 * The unique index on (channel_id, user_id) makes a recast an update rather than
 * a second row, so a person can never appear twice in one scene's cast.
 */
function setCastMember({ channelId, guildId, userId, roleName, addedBy }) {
  const db = requireDatabase();

  if (!channelId || !guildId || !userId || !roleName || !addedBy) {
    throw new Error('setCastMember requires channelId, guildId, userId, roleName and addedBy.');
  }

  const existing = getCastMember(channelId, userId);

  db.prepare(`
    INSERT INTO scene_cast (channel_id, guild_id, user_id, role_name, added_by, added_at)
    VALUES (@channelId, @guildId, @userId, @roleName, @addedBy, @addedAt)
    ON CONFLICT (channel_id, user_id) DO UPDATE SET
      role_name = excluded.role_name,
      added_by = excluded.added_by,
      added_at = excluded.added_at
  `).run({
    channelId,
    guildId,
    userId,
    roleName,
    addedBy,
    addedAt: new Date().toISOString(),
  });

  return { record: getCastMember(channelId, userId), wasUpdate: existing !== null, previousRoleName: existing?.role_name ?? null };
}

function getCastMember(channelId, userId) {
  return requireDatabase()
    .prepare('SELECT * FROM scene_cast WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId) || null;
}

function removeCastMember(channelId, userId) {
  const existing = getCastMember(channelId, userId);
  if (!existing) {
    return null;
  }

  requireDatabase()
    .prepare('DELETE FROM scene_cast WHERE channel_id = ? AND user_id = ?')
    .run(channelId, userId);

  return existing;
}

function listCast(channelId) {
  return requireDatabase()
    .prepare('SELECT * FROM scene_cast WHERE channel_id = ? ORDER BY added_at ASC, id ASC')
    .all(channelId);
}

function countCast(channelId) {
  return requireDatabase()
    .prepare('SELECT COUNT(*) AS total FROM scene_cast WHERE channel_id = ?')
    .get(channelId).total;
}

/**
 * Drop a scene and its cast together, so deleting a ticket channel never leaves
 * orphaned rows behind.
 */
function deleteSceneData(channelId) {
  const db = requireDatabase();

  const removeAll = db.transaction((id) => {
    const castRemoved = db.prepare('DELETE FROM scene_cast WHERE channel_id = ?').run(id).changes;
    const sceneRemoved = db.prepare('DELETE FROM scenes WHERE channel_id = ?').run(id).changes;
    return { castRemoved, sceneRemoved };
  });

  return removeAll(channelId);
}

function listScenes(guildId) {
  const db = requireDatabase();

  return guildId ?
    db.prepare('SELECT * FROM scenes WHERE guild_id = ? ORDER BY created_at DESC').all(guildId) :
    db.prepare('SELECT * FROM scenes ORDER BY created_at DESC').all();
}

function closeSceneStore() {
  if (database) {
    closeSharedDatabase(databaseFilePath);
    database = null;
    databaseFilePath = null;
  }
}

module.exports = {
  initializeSceneStore,
  isSceneStoreReady,
  createScene,
  getScene,
  isSceneChannelId,
  setCastMember,
  getCastMember,
  removeCastMember,
  listCast,
  countCast,
  deleteSceneData,
  listScenes,
  closeSceneStore,
};
