'use strict';

/**
 * Persistence for the conversational Trusted application.
 *
 * The questionnaire is a state machine that has to survive a restart, so the
 * current step, the assigned audition piece and every answer so far live in
 * SQLite rather than in memory. Voiceovers are kept on disk beside it, because
 * the ticket channel is purged on submission and Discord CDN URLs expire.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDefaultDatabasePath, openSharedDatabase, closeSharedDatabase } = require('./storage');

const APPLICATION_STATUS = {
  inProgress: 'in_progress',
  review: 'review',
  submitted: 'submitted',
};

let database = null;
let databaseFilePath = null;

function getMediaRoot() {
  return process.env.APPLICATION_MEDIA_PATH || path.join(__dirname, 'data', 'applications');
}

/**
 * The application used to be called the Actor application. Rename the tables in
 * place rather than starting fresh, so in-progress applications and active
 * cooldowns survive the rename. A fresh database skips this entirely.
 */
function migrateLegacyActorTables(db) {
  const tableExists = (name) => Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );

  const renames = [
    ['actor_applications', 'trusted_applications'],
    ['actor_application_blocks', 'trusted_application_blocks'],
  ];

  for (const [legacyName, currentName] of renames) {
    if (tableExists(legacyName) && !tableExists(currentName)) {
      db.exec(`ALTER TABLE ${legacyName} RENAME TO ${currentName}`);
      console.log(`Renamed ${legacyName} to ${currentName}.`);
    }
  }

  // SQLite carries indexes across a table rename but keeps their old names, so
  // drop the stale ones and let the schema below recreate them.
  db.exec(`
    DROP INDEX IF EXISTS actor_applications_status;
    DROP INDEX IF EXISTS actor_applications_applicant;
  `);
}

function initializeApplicationStore(databasePath = getDefaultDatabasePath()) {
  if (database) {
    return database;
  }

  databaseFilePath = databasePath;
  database = openSharedDatabase(databasePath);
  migrateLegacyActorTables(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS trusted_applications (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      applicant_id TEXT NOT NULL,
      applicant_tag TEXT NOT NULL,
      reference TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step INTEGER,
      editing_step INTEGER,
      audition_key TEXT NOT NULL,
      answers TEXT NOT NULL,
      prompt_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reminded_at TEXT,
      submitted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS trusted_applications_status
      ON trusted_applications (status);
    CREATE INDEX IF NOT EXISTS trusted_applications_applicant
      ON trusted_applications (guild_id, applicant_id);

    CREATE TABLE IF NOT EXISTS trusted_application_blocks (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reason TEXT,
      blocked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
  `);

  return database;
}

function requireDatabase() {
  if (!database) {
    throw new Error('Application store has not been initialized.');
  }

  return database;
}

function isApplicationStoreReady() {
  return database !== null;
}

function hydrate(row) {
  if (!row) {
    return null;
  }

  let answers = {};
  try {
    answers = JSON.parse(row.answers);
  } catch (error) {
    console.error(`Corrupt answers JSON on application ${row.channel_id}, treating as empty:`, error);
  }

  return { ...row, answers };
}

function createApplication({ channelId, guildId, applicantId, applicantTag, reference, auditionKey }) {
  const db = requireDatabase();

  if (!channelId || !guildId || !applicantId || !reference || !auditionKey) {
    throw new Error('createApplication requires channelId, guildId, applicantId, reference and auditionKey.');
  }

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO trusted_applications (
      channel_id, guild_id, applicant_id, applicant_tag, reference, status,
      current_step, editing_step, audition_key, answers, prompt_message_id,
      created_at, updated_at, reminded_at, submitted_at
    ) VALUES (
      @channelId, @guildId, @applicantId, @applicantTag, @reference, @status,
      0, NULL, @auditionKey, '{}', NULL,
      @now, @now, NULL, NULL
    )
    ON CONFLICT (channel_id) DO UPDATE SET
      applicant_id = excluded.applicant_id,
      applicant_tag = excluded.applicant_tag,
      reference = excluded.reference,
      status = excluded.status,
      current_step = 0,
      editing_step = NULL,
      audition_key = excluded.audition_key,
      answers = '{}',
      prompt_message_id = NULL,
      updated_at = excluded.updated_at
  `).run({
    channelId,
    guildId,
    applicantId,
    applicantTag: applicantTag || 'Unknown',
    reference,
    status: APPLICATION_STATUS.inProgress,
    auditionKey,
    now,
  });

  return getApplication(channelId);
}

function getApplication(channelId) {
  return hydrate(requireDatabase().prepare('SELECT * FROM trusted_applications WHERE channel_id = ?').get(channelId));
}

function listApplications(status) {
  const db = requireDatabase();
  const rows = status ?
    db.prepare('SELECT * FROM trusted_applications WHERE status = ? ORDER BY created_at ASC').all(status) :
    db.prepare('SELECT * FROM trusted_applications ORDER BY created_at ASC').all();

  return rows.map(hydrate);
}

/**
 * Record one answer and move to the next step in a single write, so a crash can
 * never leave an answer saved against the wrong question.
 */
function recordAnswer({ channelId, questionKey, answer, nextStep, status }) {
  const db = requireDatabase();
  const existing = getApplication(channelId);
  if (!existing) {
    return null;
  }

  const answers = { ...existing.answers, [questionKey]: answer };

  db.prepare(`
    UPDATE trusted_applications
    SET answers = @answers,
        current_step = @nextStep,
        editing_step = NULL,
        status = @status,
        prompt_message_id = NULL,
        reminded_at = NULL,
        updated_at = @now
    WHERE channel_id = @channelId
  `).run({
    channelId,
    answers: JSON.stringify(answers),
    nextStep: nextStep ?? null,
    status: status || existing.status,
    now: new Date().toISOString(),
  });

  return getApplication(channelId);
}

function setApplicationState(channelId, { status, currentStep, editingStep, promptMessageId, remindedAt, submittedAt }) {
  const db = requireDatabase();
  const existing = getApplication(channelId);
  if (!existing) {
    return null;
  }

  db.prepare(`
    UPDATE trusted_applications
    SET status = @status,
        current_step = @currentStep,
        editing_step = @editingStep,
        prompt_message_id = @promptMessageId,
        reminded_at = @remindedAt,
        submitted_at = @submittedAt,
        updated_at = @now
    WHERE channel_id = @channelId
  `).run({
    channelId,
    status: status ?? existing.status,
    currentStep: currentStep === undefined ? existing.current_step : currentStep,
    editingStep: editingStep === undefined ? existing.editing_step : editingStep,
    promptMessageId: promptMessageId === undefined ? existing.prompt_message_id : promptMessageId,
    remindedAt: remindedAt === undefined ? existing.reminded_at : remindedAt,
    submittedAt: submittedAt === undefined ? existing.submitted_at : submittedAt,
    now: new Date().toISOString(),
  });

  return getApplication(channelId);
}

function deleteApplication(channelId) {
  const removed = requireDatabase()
    .prepare('DELETE FROM trusted_applications WHERE channel_id = ?')
    .run(channelId).changes;

  removeApplicationMedia(channelId);
  return removed;
}

// ---------------------------------------------------------------- media files

function getApplicationMediaDir(channelId) {
  return path.join(getMediaRoot(), String(channelId));
}

function saveApplicationMedia(channelId, slot, buffer, fileName) {
  const dir = getApplicationMediaDir(channelId);
  fs.mkdirSync(dir, { recursive: true });

  // The slot owns the name on disk so a re-answer overwrites cleanly; the
  // original filename is kept in the answer record for display.
  const extension = path.extname(String(fileName || '')).slice(0, 10).replace(/[^.A-Za-z0-9]/g, '') || '.bin';
  const target = path.join(dir, `${slot}${extension}`);

  for (const existing of listApplicationMediaFiles(channelId)) {
    if (path.basename(existing, path.extname(existing)) === slot) {
      fs.rmSync(existing, { force: true });
    }
  }

  fs.writeFileSync(target, buffer);
  return target;
}

function listApplicationMediaFiles(channelId) {
  const dir = getApplicationMediaDir(channelId);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}

function readApplicationMedia(channelId, slot) {
  for (const filePath of listApplicationMediaFiles(channelId)) {
    if (path.basename(filePath, path.extname(filePath)) === slot) {
      return { buffer: fs.readFileSync(filePath), filePath };
    }
  }

  return null;
}

function removeApplicationMedia(channelId) {
  const dir = getApplicationMediaDir(channelId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------- re-apply cooldown

function blockApplicant({ guildId, userId, reason, durationMs }) {
  const db = requireDatabase();

  if (!guildId || !userId || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('blockApplicant requires guildId, userId and a positive durationMs.');
  }

  const blockedAt = new Date();
  const expiresAt = new Date(blockedAt.getTime() + durationMs);

  db.prepare(`
    INSERT INTO trusted_application_blocks (guild_id, user_id, reason, blocked_at, expires_at)
    VALUES (@guildId, @userId, @reason, @blockedAt, @expiresAt)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      reason = excluded.reason,
      blocked_at = excluded.blocked_at,
      expires_at = excluded.expires_at
  `).run({
    guildId,
    userId,
    reason: reason || null,
    blockedAt: blockedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return { guildId, userId, blockedAt, expiresAt };
}

/**
 * Returns the active block, or null. Expired rows are cleared on read so the
 * table never needs a sweeper.
 */
function getApplicantBlock(guildId, userId) {
  const db = requireDatabase();
  const row = db.prepare('SELECT * FROM trusted_application_blocks WHERE guild_id = ? AND user_id = ?').get(guildId, userId);

  if (!row) {
    return null;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM trusted_application_blocks WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
    return null;
  }

  return row;
}

function clearApplicantBlock(guildId, userId) {
  return requireDatabase()
    .prepare('DELETE FROM trusted_application_blocks WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId).changes;
}

function closeApplicationStore() {
  if (database) {
    closeSharedDatabase(databaseFilePath);
    database = null;
    databaseFilePath = null;
  }
}

module.exports = {
  APPLICATION_STATUS,
  initializeApplicationStore,
  isApplicationStoreReady,
  createApplication,
  getApplication,
  listApplications,
  recordAnswer,
  setApplicationState,
  deleteApplication,
  getApplicationMediaDir,
  saveApplicationMedia,
  readApplicationMedia,
  listApplicationMediaFiles,
  removeApplicationMedia,
  blockApplicant,
  getApplicantBlock,
  clearApplicantBlock,
  closeApplicationStore,
};
