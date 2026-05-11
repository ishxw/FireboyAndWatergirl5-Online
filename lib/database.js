const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createEmptyProgress() {
  return {
    completedLevels: [],
    gameComplete: false,
    gameTotalComplete: false,
    updatedAt: null,
  };
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function normaliseLegacyProgress(progress, manifest) {
  if (!progress) {
    return createEmptyProgress();
  }

  const completedSet = new Set();

  if (Array.isArray(progress.completedLevels)) {
    progress.completedLevels.forEach((key) => {
      const stringKey = String(key || "");
      if (manifest.byKey.has(stringKey)) {
        completedSet.add(stringKey);
      }
    });
  }

  if (Array.isArray(progress.temples)) {
    progress.temples.forEach((temple) => {
      const templeId = String(temple?.id || "");
      const templeEntry = manifest.byTemple.get(templeId);
      if (!templeEntry || !Array.isArray(temple?.levels)) {
        return;
      }
      temple.levels.forEach((level) => {
        const levelId = String(level?.id || "");
        if (level?.best && templeEntry.levelsById.has(levelId)) {
          completedSet.add(`${templeId}:${levelId}`);
        }
      });
    });
  }

  const completedLevels = Array.from(completedSet).sort();
  const totalLevels = manifest.completedLevels.length;

  return {
    completedLevels,
    gameComplete: progress.gameComplete === true || (totalLevels > 0 && completedLevels.length >= totalLevels),
    gameTotalComplete: progress.gameTotalComplete === true || (totalLevels > 0 && completedLevels.length >= totalLevels),
    updatedAt: progress.updatedAt || null,
  };
}

function buildProgressFromRow(row, manifest) {
  if (!row) {
    return createEmptyProgress();
  }

  const completedLevels = safeJsonParse(row.completed_levels_json, [])
    .map((key) => String(key || ""))
    .filter((key) => manifest.byKey.has(key));

  const uniqueCompletedLevels = Array.from(new Set(completedLevels)).sort();
  const totalLevels = manifest.completedLevels.length;

  return {
    completedLevels: uniqueCompletedLevels,
    gameComplete: row.game_complete === 1 || (totalLevels > 0 && uniqueCompletedLevels.length >= totalLevels),
    gameTotalComplete: row.game_total_complete === 1 || (totalLevels > 0 && uniqueCompletedLevels.length >= totalLevels),
    updatedAt: row.updated_at || null,
  };
}

function createDatabase(options) {
  const rootDir = options.rootDir;
  const dbFile = options.dbFile;
  const legacyAccountsFile = options.legacyAccountsFile;
  const manifest = options.manifest;

  ensureDirectory(path.dirname(dbFile));
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS progress (
      user_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      completed_levels_json TEXT NOT NULL,
      game_complete INTEGER NOT NULL DEFAULT 0,
      game_total_complete INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (user_id, mode),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CHECK (mode IN ('single', 'online_host'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const statements = {
    countUsers: db.prepare("SELECT COUNT(*) AS count FROM users"),
    insertUser: db.prepare(`
      INSERT INTO users (username, username_key, password_salt, password_hash, created_at, updated_at)
      VALUES (@username, @username_key, @password_salt, @password_hash, @created_at, @updated_at)
    `),
    getUserByUsernameKey: db.prepare("SELECT * FROM users WHERE username_key = ?"),
    getUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
    upsertProgress: db.prepare(`
      INSERT INTO progress (user_id, mode, completed_levels_json, game_complete, game_total_complete, updated_at)
      VALUES (@user_id, @mode, @completed_levels_json, @game_complete, @game_total_complete, @updated_at)
      ON CONFLICT(user_id, mode) DO UPDATE SET
        completed_levels_json = excluded.completed_levels_json,
        game_complete = excluded.game_complete,
        game_total_complete = excluded.game_total_complete,
        updated_at = excluded.updated_at
    `),
    getProgressRow: db.prepare("SELECT * FROM progress WHERE user_id = ? AND mode = ?"),
    deleteProgress: db.prepare("DELETE FROM progress WHERE user_id = ? AND mode = ?"),
    insertSession: db.prepare(`
      INSERT INTO sessions (token, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `),
    getSessionByToken: db.prepare(`
      SELECT sessions.token, sessions.user_id, sessions.created_at, sessions.expires_at,
             users.id AS id, users.username AS username, users.username_key AS username_key
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ?
    `),
    deleteSessionByToken: db.prepare("DELETE FROM sessions WHERE token = ?"),
    deleteSessionsByUserId: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  };

  const writeProgressTransaction = db.transaction((userId, mode, progress) => {
    statements.upsertProgress.run({
      user_id: userId,
      mode,
      completed_levels_json: JSON.stringify(progress.completedLevels),
      game_complete: progress.gameComplete ? 1 : 0,
      game_total_complete: progress.gameTotalComplete ? 1 : 0,
      updated_at: progress.updatedAt,
    });
  });

  const migrateLegacyAccounts = db.transaction(() => {
    if (!fs.existsSync(legacyAccountsFile)) {
      return;
    }

    const raw = fs.readFileSync(legacyAccountsFile, "utf8").replace(/^\uFEFF/, "");
    const legacy = safeJsonParse(raw, { users: {} });
    const users = legacy && legacy.users && typeof legacy.users === "object" ? legacy.users : {};

    Object.keys(users).forEach((usernameKey) => {
      const legacyUser = users[usernameKey];
      if (!legacyUser || !legacyUser.username || !legacyUser.passwordSalt || !legacyUser.passwordHash) {
        return;
      }

      const existing = statements.getUserByUsernameKey.get(String(legacyUser.username).toLowerCase());
      if (existing) {
        return;
      }

      const now = legacyUser.updatedAt || legacyUser.createdAt || new Date().toISOString();
      const result = statements.insertUser.run({
        username: String(legacyUser.username),
        username_key: String(legacyUser.username).toLowerCase(),
        password_salt: String(legacyUser.passwordSalt),
        password_hash: String(legacyUser.passwordHash),
        created_at: legacyUser.createdAt || now,
        updated_at: now,
      });

      const singleProgress = normaliseLegacyProgress(
        legacyUser.progress_single || legacyUser.progress,
        manifest,
      );
      const onlineProgress = normaliseLegacyProgress(legacyUser.progress_online_host, manifest);

      writeProgressTransaction(result.lastInsertRowid, "single", singleProgress);
      writeProgressTransaction(result.lastInsertRowid, "online_host", onlineProgress);
    });
  });

  if (statements.countUsers.get().count === 0) {
    migrateLegacyAccounts();
  }

  function getUserByUsername(username) {
    return statements.getUserByUsernameKey.get(String(username || "").trim().toLowerCase()) || null;
  }

  function getUserById(userId) {
    return statements.getUserById.get(userId) || null;
  }

  function createUser(userRecord) {
    const result = statements.insertUser.run({
      username: userRecord.username,
      username_key: userRecord.username_key,
      password_salt: userRecord.password_salt,
      password_hash: userRecord.password_hash,
      created_at: userRecord.created_at,
      updated_at: userRecord.updated_at,
    });

    writeProgressTransaction(result.lastInsertRowid, "single", createEmptyProgress());
    writeProgressTransaction(result.lastInsertRowid, "online_host", createEmptyProgress());

    return getUserById(result.lastInsertRowid);
  }

  function getProgress(userId, mode) {
    return buildProgressFromRow(statements.getProgressRow.get(userId, mode), manifest);
  }

  function writeProgress(userId, mode, progress) {
    writeProgressTransaction(userId, mode, progress);
    return getProgress(userId, mode);
  }

  function resetProgress(userId, mode) {
    const next = createEmptyProgress();
    next.updatedAt = new Date().toISOString();
    return writeProgress(userId, mode, next);
  }

  function completeAllProgress(userId, mode) {
    const next = {
      completedLevels: manifest.completedLevels.slice(),
      gameComplete: true,
      gameTotalComplete: true,
      updatedAt: new Date().toISOString(),
    };
    return writeProgress(userId, mode, next);
  }

  function markLevelComplete(userId, mode, templeId, levelId, filename) {
    const levelKey = require("./game-manifest").resolveLevelKey(manifest, templeId, levelId, filename);
    if (!levelKey) {
      return null;
    }

    const current = getProgress(userId, mode);
    const nextSet = new Set(current.completedLevels);
    nextSet.add(levelKey);

    const completedLevels = Array.from(nextSet).sort();
    const totalLevels = manifest.completedLevels.length;
    const next = {
      completedLevels,
      gameComplete: totalLevels > 0 && completedLevels.length >= totalLevels,
      gameTotalComplete: totalLevels > 0 && completedLevels.length >= totalLevels,
      updatedAt: new Date().toISOString(),
    };

    return writeProgress(userId, mode, next);
  }

  function createSession(token, userId, createdAtMs, expiresAtMs) {
    statements.insertSession.run(token, userId, createdAtMs, expiresAtMs);
  }

  function getSession(token, nowMs) {
    const row = statements.getSessionByToken.get(token);
    if (!row) {
      return null;
    }
    if (row.expires_at <= nowMs) {
      statements.deleteSessionByToken.run(token);
      return null;
    }
    return row;
  }

  function deleteSession(token) {
    statements.deleteSessionByToken.run(token);
  }

  function deleteExpiredSessions(nowMs) {
    statements.deleteExpiredSessions.run(nowMs);
  }

  function getAuthPayload(user) {
    return {
      user: {
        id: user.id,
        username: user.username,
      },
      progressSingle: getProgress(user.id, "single"),
      progressOnlineHost: getProgress(user.id, "online_host"),
    };
  }

  return {
    close: () => db.close(),
    createEmptyProgress,
    createSession,
    createUser,
    db,
    dbFile,
    deleteExpiredSessions,
    deleteSession,
    getAuthPayload,
    getProgress,
    getSession,
    getUserById,
    getUserByUsername,
    markLevelComplete,
    resetProgress,
    completeAllProgress,
    writeProgress,
  };
}

module.exports = {
  createDatabase,
  createEmptyProgress,
  normaliseLegacyProgress,
};
