const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const { createDatabase } = require("./lib/database");
const {
  createManifestResponse,
  listAllLevelKeys,
  loadGameManifest,
  resolveLevelKey,
} = require("./lib/game-manifest");

const ROOT = __dirname;
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8005);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, "fireboy-online.sqlite"));
const LEGACY_ACCOUNTS_FILE = path.resolve(
  process.env.ACCOUNTS_FILE || path.join(ROOT, "accounts.json"),
);
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES || 1024 * 1024);
const CLIENT_PING_INTERVAL_MS = Number(process.env.CLIENT_PING_INTERVAL_MS || 25000);
const ROOM_IDLE_TTL_MS = Number(process.env.ROOM_IDLE_TTL_MS || 6 * 60 * 60 * 1000);
const ROOM_CLEANUP_INTERVAL_MS = Number(process.env.ROOM_CLEANUP_INTERVAL_MS || 60 * 1000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 60 * 1000);
const ACCOUNT_REGEX = /^[A-Za-z0-9]{4,8}$/;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".fnt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".manifest": "application/manifest+json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function nowIso() {
  return new Date().toISOString();
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function randomId(length = 16) {
  return crypto.randomBytes(length).toString("hex");
}

function normaliseUsername(username) {
  return String(username || "").trim();
}

function validateCredentials(username, password) {
  const cleanUsername = normaliseUsername(username);
  const cleanPassword = String(password || "");

  if (!ACCOUNT_REGEX.test(cleanUsername)) {
    return "Username must be 4-8 letters or digits.";
  }
  if (cleanPassword.length < 6) {
    return "Password must be at least 6 characters.";
  }
  return null;
}

function hashPassword(password, salt) {
  const passwordSalt = salt || crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync(password, passwordSalt, 64).toString("hex");
  return {
    salt: passwordSalt,
    hash: passwordHash,
  };
}

function verifyPassword(password, userRecord) {
  const expected = Buffer.from(userRecord.password_hash, "hex");
  const actual = Buffer.from(hashPassword(password, userRecord.password_salt).hash, "hex");
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .reduce((map, chunk) => {
      const [rawKey, ...rest] = chunk.split("=");
      const key = String(rawKey || "").trim();
      if (!key) {
        return map;
      }
      map[key] = decodeURIComponent(rest.join("=").trim());
      return map;
    }, {});
}

function parseQueryValue(urlString, key) {
  const url = new URL(urlString, "http://localhost");
  return url.searchParams.get(key);
}

function setSessionCookie(response, token) {
  response.setHeader("Set-Cookie", [
    `fb5_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000,
    )}`,
  ]);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", [
    "fb5_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  ]);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_MESSAGE_BYTES) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

const manifest = loadGameManifest(ROOT);
const database = createDatabase({
  rootDir: ROOT,
  dbFile: DB_FILE,
  legacyAccountsFile: LEGACY_ACCOUNTS_FILE,
  manifest,
});

function getSessionTokenFromRequest(request) {
  const auth = request.headers.authorization || "";
  const bearerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (bearerToken) {
    return bearerToken;
  }
  const cookies = parseCookies(request.headers.cookie || "");
  return cookies.fb5_session || "";
}

function getSessionFromRequest(request) {
  const token = getSessionTokenFromRequest(request);
  if (!token) {
    return null;
  }
  return database.getSession(token, Date.now());
}

function getUserFromRequest(request) {
  const session = getSessionFromRequest(request);
  if (!session) {
    return null;
  }
  return database.getUserById(session.user_id);
}

function createRoom(code, hostUser) {
  const hostPlayerId = `user:${hostUser.id}`;
  return {
    code,
    hostId: hostPlayerId,
    hostUsername: hostUser.username,
    players: new Map(),
    selectedTempleId: null,
    selectedLevelId: null,
    game: {
      status: "lobby",
      nonce: null,
      startedAt: null,
      startedAtMs: null,
    },
    lastSnapshot: null,
    updatedAt: Date.now(),
  };
}

const rooms = new Map();
const clients = new Map();

function touchRoom(room) {
  room.updatedAt = Date.now();
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error("Unable to allocate room code");
}

function normaliseRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function createPlayerId(user) {
  return `user:${user.id}`;
}

function getOnlineHostProgress(room) {
  if (!room || !room.hostId) {
    return database.createEmptyProgress();
  }
  const hostPlayer = room.players.get(room.hostId);
  if (!hostPlayer) {
    return database.createEmptyProgress();
  }
  return database.getProgress(hostPlayer.userId, "online_host");
}

function serialiseRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    hostUsername: room.hostUsername,
    selectedTempleId: room.selectedTempleId,
    selectedLevelId: room.selectedLevelId,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      username: player.username,
      role: player.role || null,
      joinedAt: player.joinedAt,
      connected: !player.disconnectedAt,
    })),
    game: {
      status: room.game.status,
      nonce: room.game.nonce,
      startedAt: room.game.startedAt,
    },
    progressOnlineHost: getOnlineHostProgress(room),
  };
}

function sendMessage(client, message) {
  if (!client || client.closed || client.ws.readyState !== client.ws.OPEN) {
    return;
  }
  client.ws.send(JSON.stringify(message));
}

function broadcastRoom(room, message, options = {}) {
  const skipPlayerId = options.skipPlayerId || null;
  touchRoom(room);
  room.players.forEach((player) => {
    if (player.id === skipPlayerId || !player.client || player.disconnectedAt) {
      return;
    }
    sendMessage(player.client, message);
  });
}

function emitRoomState(room) {
  broadcastRoom(room, {
    type: "room_state",
    room: serialiseRoom(room),
  });
}

function fail(client, message) {
  sendMessage(client, {
    type: "error",
    message,
  });
}

function findPlayerRoom(client) {
  if (!client.roomCode) {
    return null;
  }
  return rooms.get(client.roomCode) || null;
}

function findRoomByPlayerId(playerId) {
  for (const room of rooms.values()) {
    if (room.players.has(playerId)) {
      return room;
    }
  }
  return null;
}

function removeRoomIfEmpty(room) {
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return true;
  }
  return false;
}

function attachClientToExistingPlayer(client, room, player) {
  if (player.client && player.client !== client) {
    player.client.roomCode = null;
    player.client.closed = true;
    try {
      player.client.ws.close(1000, "replaced");
    } catch (error) {}
    clients.delete(player.client.id);
  }

  player.client = client;
  player.disconnectedAt = null;
  client.user = {
    id: player.userId,
    username: player.username,
  };
  client.playerId = player.id;
  client.roomCode = room.code;
}

function leaveRoom(client, reason = "left", options = {}) {
  const room = options.room || findPlayerRoom(client);
  if (!room || !client.playerId) {
    client.roomCode = null;
    return;
  }

  const player = room.players.get(client.playerId);
  if (!player) {
    client.roomCode = null;
    return;
  }

  if (player.client === client) {
    player.client = null;
  }

  room.players.delete(player.id);
  client.roomCode = null;

  if (room.hostId === player.id) {
    const nextConnectedHost = Array.from(room.players.values()).find((candidate) => !candidate.disconnectedAt);
    const nextHost = nextConnectedHost || Array.from(room.players.values())[0] || null;
    room.hostId = nextHost ? nextHost.id : null;
    room.hostUsername = nextHost ? nextHost.username : room.hostUsername;
  }

  if (removeRoomIfEmpty(room)) {
    return;
  }

  if (room.players.size < 2 && room.game.status === "playing") {
    room.game = {
      status: "lobby",
      nonce: null,
      startedAt: null,
      startedAtMs: null,
    };
    room.lastSnapshot = null;
    broadcastRoom(room, {
      type: "return_to_room",
      reason,
    });
  }

  touchRoom(room);
  emitRoomState(room);
}

function disconnectClient(client, reason = "disconnect") {
  const room = findPlayerRoom(client);
  if (!room || !client.playerId) {
    client.roomCode = null;
    return;
  }

  const player = room.players.get(client.playerId);
  if (!player || player.client !== client) {
    client.roomCode = null;
    return;
  }

  player.client = null;
  player.disconnectedAt = Date.now();
  client.roomCode = null;
  touchRoom(room);
  emitRoomState(room);
}

function joinRoom(client, code) {
  if (!client.user || !client.playerId) {
    fail(client, "Please log in first.");
    return;
  }

  const roomCode = normaliseRoomCode(code);
  if (!roomCode) {
    fail(client, "Please enter a valid room code.");
    return;
  }

  const currentRoom = findPlayerRoom(client);
  if (currentRoom) {
    leaveRoom(client, "switch_room", { room: currentRoom });
  }

  const room = rooms.get(roomCode);
  if (!room) {
    fail(client, "房间不存在");
    return;
  }

  if (room.players.has(client.playerId)) {
    const existingPlayer = room.players.get(client.playerId);
    attachClientToExistingPlayer(client, room, existingPlayer);
    touchRoom(room);
    emitRoomState(room);
    if (room.game.status === "playing" && room.selectedTempleId && room.selectedLevelId) {
      sendMessage(client, {
        type: "start_level",
        room: serialiseRoom(room),
        elapsedMs: Math.max(0, Date.now() - (room.game.startedAtMs || Date.now())),
        snapshot: room.lastSnapshot,
        resumed: true,
      });
    }
    return;
  }

  if (room.players.size >= 2) {
    fail(client, "Room is full.");
    return;
  }

  room.players.set(client.playerId, {
    id: client.playerId,
    userId: client.user.id,
    username: client.user.username,
    role: null,
    joinedAt: nowIso(),
    disconnectedAt: null,
    client,
  });
  client.roomCode = room.code;

  if (!room.hostId || !room.players.has(room.hostId)) {
    room.hostId = client.playerId;
    room.hostUsername = client.user.username;
  }

  touchRoom(room);
  emitRoomState(room);
}

function resumePlayerRoom(client) {
  if (!client.playerId) {
    sendMessage(client, { type: "room_state", room: null });
    return;
  }

  const room = findRoomByPlayerId(client.playerId);
  if (!room) {
    sendMessage(client, { type: "room_state", room: null });
    return;
  }

  const player = room.players.get(client.playerId);
  if (!player) {
    sendMessage(client, { type: "room_state", room: null });
    return;
  }

  if (player.disconnectedAt && player.disconnectedAt + RECONNECT_GRACE_MS < Date.now()) {
    room.players.delete(player.id);
    removeRoomIfEmpty(room);
    sendMessage(client, { type: "room_state", room: null });
    return;
  }

  attachClientToExistingPlayer(client, room, player);
  touchRoom(room);
  sendMessage(client, {
    type: "room_state",
    room: serialiseRoom(room),
  });

  if (room.game.status === "playing" && room.selectedTempleId && room.selectedLevelId) {
    sendMessage(client, {
      type: "start_level",
      room: serialiseRoom(room),
      elapsedMs: Math.max(0, Date.now() - (room.game.startedAtMs || Date.now())),
      snapshot: room.lastSnapshot,
      resumed: true,
    });
  }

  emitRoomState(room);
}

function createClient(ws, request) {
  const user = getUserFromRequest(request);
  const playerId = user ? createPlayerId(user) : null;
  return {
    id: randomId(6),
    ws,
    request,
    closed: false,
    roomCode: null,
    user,
    playerId,
    isAlive: true,
    connectedAt: Date.now(),
  };
}

function getModeFromRequest(requestUrl, bodyMode) {
  const rawMode = String(bodyMode || parseQueryValue(requestUrl, "mode") || "single");
  return rawMode === "online_host" ? "online_host" : "single";
}

function requireUser(request, response) {
  const user = getUserFromRequest(request);
  if (!user) {
    writeJson(response, 401, { ok: false, message: "Not logged in." });
    return null;
  }
  return user;
}

function handleRoomMessage(client, message) {
  const room = findPlayerRoom(client);
  if (!room) {
    fail(client, "Join or create a room first.");
    return;
  }

  const player = room.players.get(client.playerId);
  if (!player) {
    fail(client, "Room state is invalid. Rejoin the room.");
    return;
  }

  touchRoom(room);

  switch (message.type) {
    case "select_level": {
      if (client.playerId !== room.hostId) {
        fail(client, "Only the host can choose a level.");
        return;
      }

      const levelKey = resolveLevelKey(manifest, message.templeId, message.levelId, message.filename);
      if (!levelKey) {
        fail(client, "Invalid level selection.");
        return;
      }

      const [templeId, levelId] = levelKey.split(":");
      room.selectedTempleId = templeId;
      room.selectedLevelId = levelId;
      room.game = {
        status: "lobby",
        nonce: null,
        startedAt: null,
        startedAtMs: null,
      };
      room.lastSnapshot = null;
      emitRoomState(room);
      return;
    }

    case "select_role": {
      const nextRole = message.role == null ? null : String(message.role);
      if (nextRole !== null && nextRole !== "fb" && nextRole !== "wg") {
        fail(client, "Invalid role.");
        return;
      }

      if (nextRole) {
        for (const other of room.players.values()) {
          if (other.id !== client.playerId && other.role === nextRole) {
            fail(client, "That role is already taken.");
            return;
          }
        }
      }

      player.role = nextRole;
      emitRoomState(room);
      return;
    }

    case "start_level":
    case "retry_level": {
      if (client.playerId !== room.hostId) {
        fail(client, "Only the host can start the level.");
        return;
      }
      if (room.players.size !== 2) {
        fail(client, "Online mode requires 2 players.");
        return;
      }
      if (!room.selectedTempleId || !room.selectedLevelId) {
        fail(client, "Choose a level first.");
        return;
      }

      const roles = Array.from(room.players.values()).map((currentPlayer) => currentPlayer.role);
      if (!(roles.includes("fb") && roles.includes("wg"))) {
        fail(client, "Both players must choose different roles.");
        return;
      }

      room.game = {
        status: "playing",
        nonce: randomId(8),
        startedAt: nowIso(),
        startedAtMs: Date.now(),
      };
      room.lastSnapshot = null;
      emitRoomState(room);
      broadcastRoom(room, {
        type: "start_level",
        room: serialiseRoom(room),
        elapsedMs: 0,
      });
      return;
    }

    case "return_to_room": {
      room.game = {
        status: "lobby",
        nonce: null,
        startedAt: null,
        startedAtMs: null,
      };
      room.lastSnapshot = null;
      room.selectedTempleId = null;
      room.selectedLevelId = null;
      emitRoomState(room);
      broadcastRoom(room, {
        type: "return_to_room",
        reason: "manual",
      });
      return;
    }

    case "continue_levels": {
      if (client.playerId !== room.hostId) {
        fail(client, "Only the host can continue level selection.");
        return;
      }

      room.game = {
        status: "lobby",
        nonce: null,
        startedAt: null,
        startedAtMs: null,
      };
      room.lastSnapshot = null;
      room.selectedLevelId = null;
      emitRoomState(room);
      broadcastRoom(room, {
        type: "return_to_room",
        reason: "continue_levels",
      }, { skipPlayerId: room.hostId });
      return;
    }

    case "input": {
      if (room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }
      broadcastRoom(room, {
        type: "player_input",
        playerId: client.playerId,
        role: player.role,
        nonce: message.nonce,
        seq: Number(message.seq || 0),
        state: {
          left: !!message.state?.left,
          right: !!message.state?.right,
          up: !!message.state?.up,
        },
      }, { skipPlayerId: client.playerId });
      return;
    }

    case "snapshot": {
      if (client.playerId !== room.hostId || room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }
      room.lastSnapshot = {
        elapsedMs: Math.max(0, Number(message.elapsedMs || 0)),
        bodies: Array.isArray(message.bodies) ? message.bodies : [],
        players: message.players || null,
      };
      broadcastRoom(room, {
        type: "level_snapshot",
        nonce: message.nonce,
        elapsedMs: room.lastSnapshot.elapsedMs,
        bodies: room.lastSnapshot.bodies,
        players: room.lastSnapshot.players,
      }, { skipPlayerId: client.playerId });
      return;
    }

    case "level_complete": {
      if (client.playerId !== room.hostId || room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }

      const hostPlayer = room.players.get(room.hostId);
      const progress = database.markLevelComplete(
        hostPlayer.userId,
        "online_host",
        room.selectedTempleId,
        room.selectedLevelId,
      );
      if (!progress) {
        fail(client, "Unable to persist level completion.");
        return;
      }

      room.game.status = "ended";
      emitRoomState(room);
      broadcastRoom(room, {
        type: "online_finish_animation",
        nonce: message.nonce,
      }, { skipPlayerId: room.hostId });
      broadcastRoom(room, {
        type: "level_complete",
        nonce: message.nonce,
        payload: message.payload || null,
        progress,
      });
      return;
    }

    case "level_failed": {
      if (client.playerId !== room.hostId || room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }
      room.game.status = "ended";
      emitRoomState(room);
      broadcastRoom(room, {
        type: "level_failed",
        nonce: message.nonce,
        payload: message.payload || null,
      });
      return;
    }

    default:
      fail(client, `Unknown message type: ${message.type}`);
  }
}

function handleMessage(client, message) {
  if (!message || typeof message.type !== "string") {
    fail(client, "Invalid message payload.");
    return;
  }

  switch (message.type) {
    case "authenticate": {
      if (!client.user) {
        fail(client, "Login expired. Please log in again.");
        return;
      }
      sendMessage(client, {
        type: "authenticated",
        user: {
          id: client.user.id,
          username: client.user.username,
        },
        playerId: client.playerId,
      });
      resumePlayerRoom(client);
      return;
    }

    case "create_room": {
      if (!client.user) {
        fail(client, "Please log in first.");
        return;
      }
      const existingRoom = findPlayerRoom(client);
      if (existingRoom) {
        leaveRoom(client, "switch_room", { room: existingRoom });
      }
      const code = generateRoomCode();
      const room = createRoom(code, client.user);
      rooms.set(code, room);
      room.players.set(client.playerId, {
        id: client.playerId,
        userId: client.user.id,
        username: client.user.username,
        role: null,
        joinedAt: nowIso(),
        disconnectedAt: null,
        client,
      });
      client.roomCode = room.code;
      emitRoomState(room);
      return;
    }

    case "join_room":
      joinRoom(client, message.roomCode);
      return;

    case "leave_room":
      leaveRoom(client, "left");
      sendMessage(client, { type: "room_state", room: null });
      return;

    default:
      handleRoomMessage(client, message);
  }
}

async function handleRegister(request, response) {
  try {
    const body = await readJsonBody(request);
    const username = normaliseUsername(body.username);
    const password = String(body.password || "");
    const error = validateCredentials(username, password);

    if (error) {
      writeJson(response, 400, { ok: false, message: error });
      return;
    }
    if (database.getUserByUsername(username)) {
      writeJson(response, 400, { ok: false, message: "Account already exists." });
      return;
    }

    const now = nowIso();
    const passwordState = hashPassword(password);
    const user = database.createUser({
      username,
      username_key: username.toLowerCase(),
      password_salt: passwordState.salt,
      password_hash: passwordState.hash,
      created_at: now,
      updated_at: now,
    });

    const token = randomId(24);
    const createdAtMs = Date.now();
    database.createSession(token, user.id, createdAtMs, createdAtMs + SESSION_TTL_MS);
    setSessionCookie(response, token);

    writeJson(response, 200, {
      ok: true,
      ...database.getAuthPayload(user),
    });
  } catch (error) {
    writeJson(response, 400, { ok: false, message: "Invalid register request." });
  }
}

async function handleLogin(request, response) {
  try {
    const body = await readJsonBody(request);
    const username = normaliseUsername(body.username);
    const password = String(body.password || "");
    const user = database.getUserByUsername(username);

    if (!user || !verifyPassword(password, user)) {
      writeJson(response, 401, { ok: false, message: "Invalid username or password." });
      return;
    }

    const token = randomId(24);
    const createdAtMs = Date.now();
    database.createSession(token, user.id, createdAtMs, createdAtMs + SESSION_TTL_MS);
    setSessionCookie(response, token);

    writeJson(response, 200, {
      ok: true,
      ...database.getAuthPayload(user),
    });
  } catch (error) {
    writeJson(response, 400, { ok: false, message: "Invalid login request." });
  }
}

function handleMe(request, response) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  writeJson(response, 200, {
    ok: true,
    ...database.getAuthPayload(user),
  });
}

function handleLogout(request, response) {
  const sessionToken = getSessionTokenFromRequest(request);
  if (sessionToken) {
    database.deleteSession(sessionToken);
  }
  clearSessionCookie(response);
  writeJson(response, 200, { ok: true });
}

async function handleProgressMarkComplete(request, response) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  try {
    const body = await readJsonBody(request);
    const mode = getModeFromRequest(request.url, body.mode);
    const progress = database.markLevelComplete(
      user.id,
      mode,
      body.templeId,
      body.levelId,
      body.filename,
    );

    if (!progress) {
      writeJson(response, 400, { ok: false, message: "Invalid level identifier." });
      return;
    }

    writeJson(response, 200, { ok: true, progress });
  } catch (error) {
    writeJson(response, 400, { ok: false, message: "Progress update failed." });
  }
}

function handleProgressReset(request, response) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const mode = getModeFromRequest(request.url);
  const progress = database.resetProgress(user.id, mode);
  writeJson(response, 200, { ok: true, progress });
}

function handleProgressCompleteAll(request, response) {
  const user = requireUser(request, response);
  if (!user) {
    return;
  }

  const mode = getModeFromRequest(request.url);
  const progress = database.completeAllProgress(user.id, mode);
  writeJson(response, 200, { ok: true, progress });
}

function handleGameManifest(request, response) {
  writeJson(response, 200, createManifestResponse(manifest));
}

function getSafePath(urlPath) {
  const decodedPath = decodeURIComponent((urlPath || "/").split("?")[0] || "/");
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, resolvedPath);

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(`..${path.sep}`) ||
    relative === ""
  ) {
    return decodedPath === "/" ? path.join(ROOT, "index.html") : null;
  }

  return resolvedPath;
}

function serveStaticFile(request, response) {
  const safePath = getSafePath(request.url || "/");
  if (!safePath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.stat(safePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const extension = path.extname(safePath).toLowerCase();
    const noStoreExtensions = new Set([".html", ".js", ".css"]);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": noStoreExtensions.has(extension) ? "no-store" : "public, max-age=3600",
    });

    fs.createReadStream(safePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      activeRooms: rooms.size,
      activeClients: clients.size,
      accounts: Number(database.db.prepare("SELECT COUNT(*) AS count FROM users").get().count),
      dbFile: DB_FILE,
      levels: listAllLevelKeys(manifest).length,
      timestamp: nowIso(),
    });
    return;
  }

  if (request.method === "GET" && request.url === "/api/auth/me") {
    handleMe(request, response);
    return;
  }

  if (request.method === "GET" && request.url === "/api/game-manifest") {
    handleGameManifest(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/register") {
    handleRegister(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/login") {
    handleLogin(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/logout") {
    handleLogout(request, response);
    return;
  }

  if (request.method === "POST" && request.url.startsWith("/api/progress/reset")) {
    handleProgressReset(request, response);
    return;
  }

  if (request.method === "POST" && request.url.startsWith("/api/progress/complete-all")) {
    handleProgressCompleteAll(request, response);
    return;
  }

  if (request.method === "POST" && request.url === "/api/progress/mark-complete") {
    handleProgressMarkComplete(request, response);
    return;
  }

  if (request.method === "POST" && request.url.startsWith("/api/progress/save")) {
    writeJson(response, 410, {
      ok: false,
      message: "Raw progress save is disabled. Use server-authoritative progress endpoints instead.",
    });
    return;
  }

  if (request.method !== "GET") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  serveStaticFile(request, response);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

wss.on("connection", (ws, request) => {
  const client = createClient(ws, request);
  clients.set(client.id, client);

  sendMessage(client, {
    type: "welcome",
  });

  if (client.user) {
    sendMessage(client, {
      type: "authenticated",
      user: {
        id: client.user.id,
        username: client.user.username,
      },
      playerId: client.playerId,
    });
    resumePlayerRoom(client);
  } else {
    sendMessage(client, {
      type: "room_state",
      room: null,
    });
  }

  ws.on("pong", () => {
    client.isAlive = true;
  });

  ws.on("message", (payload, isBinary) => {
    if (isBinary) {
      fail(client, "Binary payloads are not supported.");
      return;
    }

    try {
      const message = JSON.parse(String(payload));
      handleMessage(client, message);
    } catch (error) {
      fail(client, "Invalid message payload.");
    }
  });

  ws.on("close", () => {
    client.closed = true;
    clients.delete(client.id);
    disconnectClient(client, "disconnect");
  });

  ws.on("error", () => {
    client.closed = true;
    clients.delete(client.id);
    disconnectClient(client, "disconnect");
  });
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

function cleanupDisconnectedPlayers() {
  const now = Date.now();

  rooms.forEach((room) => {
    room.players.forEach((player) => {
      if (!player.disconnectedAt || player.disconnectedAt + RECONNECT_GRACE_MS > now) {
        return;
      }

      const disconnectingHost = room.hostId === player.id;
      room.players.delete(player.id);

      if (disconnectingHost) {
        const nextHost = Array.from(room.players.values())[0] || null;
        room.hostId = nextHost ? nextHost.id : null;
        room.hostUsername = nextHost ? nextHost.username : room.hostUsername;
      }
    });

    if (room.players.size < 2 && room.game.status === "playing") {
      room.game = {
        status: "lobby",
        nonce: null,
        startedAt: null,
        startedAtMs: null,
      };
      room.lastSnapshot = null;
      broadcastRoom(room, {
        type: "return_to_room",
        reason: "player_left",
      });
    }

    if (room.players.size === 0 || room.updatedAt < now - ROOM_IDLE_TTL_MS) {
      rooms.delete(room.code);
      return;
    }

    emitRoomState(room);
  });
}

function cleanupState() {
  cleanupDisconnectedPlayers();
  database.deleteExpiredSessions(Date.now());
}

function pingClients() {
  clients.forEach((client) => {
    if (client.closed) {
      clients.delete(client.id);
      return;
    }
    if (!client.isAlive) {
      try {
        client.ws.terminate();
      } catch (error) {}
      clients.delete(client.id);
      disconnectClient(client, "ping_timeout");
      return;
    }
    client.isAlive = false;
    try {
      client.ws.ping();
    } catch (error) {
      clients.delete(client.id);
      disconnectClient(client, "ping_failed");
    }
  });
}

server.listen(PORT, HOST, () => {
  ensureDirectory(path.dirname(DB_FILE));
  console.log(`[server] listening on http://127.0.0.1:${PORT}/index.html`);
  console.log(`[server] health check on http://127.0.0.1:${PORT}/healthz`);
  console.log(`[server] database file: ${DB_FILE}`);
  console.log(`[server] reconnect grace: ${RECONNECT_GRACE_MS}ms`);
});

setInterval(cleanupState, ROOM_CLEANUP_INTERVAL_MS).unref();
setInterval(pingClients, CLIENT_PING_INTERVAL_MS).unref();

function shutdown() {
  clients.forEach((client) => {
    try {
      client.ws.close(1001, "server_shutdown");
    } catch (error) {}
  });
  try {
    database.close();
  } catch (error) {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
