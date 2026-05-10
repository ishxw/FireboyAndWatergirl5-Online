const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8005);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const ACCOUNTS_FILE = path.resolve(process.env.ACCOUNTS_FILE || path.join(DATA_DIR, "accounts.json"));
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES || 1024 * 1024);
const CLIENT_PING_INTERVAL_MS = Number(process.env.CLIENT_PING_INTERVAL_MS || 25000);
const ROOM_IDLE_TTL_MS = Number(process.env.ROOM_IDLE_TTL_MS || 6 * 60 * 60 * 1000);
const ROOM_CLEANUP_INTERVAL_MS = Number(process.env.ROOM_CLEANUP_INTERVAL_MS || 60 * 1000);
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

function atomicWriteJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempFile, filePath);
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function createEmptyProgress() {
  return {
    completedLevels: [],
    updatedAt: null,
  };
}

function createEmptyAccountsStore() {
  return {
    users: {},
  };
}

function normaliseLegacyProgress(progress) {
  if (!progress) {
    return createEmptyProgress();
  }
  return {
    completedLevels: Array.isArray(progress.completedLevels) ? [...progress.completedLevels] : [],
    updatedAt: progress.updatedAt || null,
  };
}

function ensureUserProgressShape(userRecord) {
  if (!userRecord.progress_single) {
    userRecord.progress_single = normaliseLegacyProgress(userRecord.progress);
  } else {
    userRecord.progress_single = normaliseLegacyProgress(userRecord.progress_single);
  }

  if (!userRecord.progress_online_host) {
    userRecord.progress_online_host = createEmptyProgress();
  } else {
    userRecord.progress_online_host = normaliseLegacyProgress(userRecord.progress_online_host);
  }

  delete userRecord.progress;
}

function loadAccountsStore() {
  try {
    const store = readJsonFile(ACCOUNTS_FILE);
    Object.values(store.users || {}).forEach(ensureUserProgressShape);
    return store;
  } catch (error) {
    return createEmptyAccountsStore();
  }
}

let accountsStore = loadAccountsStore();
const sessions = new Map();
const rooms = new Map();
const clients = new Map();

function saveAccountsStore() {
  atomicWriteJson(ACCOUNTS_FILE, accountsStore);
}

function randomId(length = 16) {
  return crypto.randomBytes(length).toString("hex");
}

function normaliseUsername(username) {
  return String(username || "").trim();
}

function usernameKey(username) {
  return normaliseUsername(username).toLowerCase();
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
  const expected = Buffer.from(userRecord.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, userRecord.passwordSalt).hash, "hex");
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

function cloneProgress(progress) {
  return progress == null ? null : JSON.parse(JSON.stringify(progress));
}

function getUserRecord(username) {
  const user = accountsStore.users[usernameKey(username)] || null;
  if (user) {
    ensureUserProgressShape(user);
  }
  return user;
}

function createSession(username) {
  const token = randomId(24);
  sessions.set(token, {
    username,
    createdAt: Date.now(),
  });
  return token;
}

function getSessionFromRequest(request) {
  const auth = request.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return null;
  }
  return sessions.get(token) || null;
}

function createRoom(code, hostUsername) {
  return {
    code,
    hostId: null,
    hostUsername,
    players: new Map(),
    selectedTempleId: null,
    selectedLevelId: null,
    game: {
      status: "lobby",
      nonce: null,
      startedAt: null,
      startedAtMs: null,
    },
    updatedAt: Date.now(),
  };
}

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

function getOnlineHostProgress(room) {
  const host = room?.hostUsername ? getUserRecord(room.hostUsername) : null;
  return cloneProgress(host?.progress_online_host || createEmptyProgress());
}

function serialiseRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    hostUsername: room.hostUsername,
    selectedTempleId: room.selectedTempleId,
    selectedLevelId: room.selectedLevelId,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      username: player.username,
      role: player.role || null,
      joinedAt: player.joinedAt,
    })),
    game: {
      status: room.game.status,
      nonce: room.game.nonce,
      startedAt: room.game.startedAt,
    },
    progressOnlineHost: getOnlineHostProgress(room),
  };
}

function findPlayerRoom(client) {
  if (!client.roomCode) {
    return null;
  }
  return rooms.get(client.roomCode) || null;
}

function sendFrame(socket, payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;

  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(data.length / 2 ** 32), 2);
    header.writeUInt32BE(data.length >>> 0, 6);
  }

  socket.write(Buffer.concat([header, data]));
}

function sendMessage(client, message) {
  if (!client.socket.destroyed) {
    sendFrame(client.socket, JSON.stringify(message));
  }
}

function broadcastRoom(room, message, options = {}) {
  const skipClientId = options.skipClientId || null;
  touchRoom(room);
  for (const player of room.players.values()) {
    if (player.id === skipClientId) {
      continue;
    }
    sendMessage(player.client, message);
  }
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

function removeRoomIfEmpty(room) {
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return true;
  }
  return false;
}

function detachClientFromRoom(client, reason = "left") {
  const room = findPlayerRoom(client);
  if (!room) {
    client.roomCode = null;
    return;
  }

  room.players.delete(client.id);
  client.roomCode = null;
  touchRoom(room);

  if (room.hostId === client.id) {
    room.hostId = room.players.size > 0 ? [...room.players.keys()][0] : null;
    room.hostUsername = room.hostId ? room.players.get(room.hostId)?.username || room.hostUsername : room.hostUsername;
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
    broadcastRoom(room, {
      type: "return_to_room",
      reason: reason === "disconnect" ? "player_left" : reason,
    });
  }

  emitRoomState(room);
}

function joinRoom(client, code) {
  if (!client.user) {
    fail(client, "Please log in first.");
    return;
  }

  const roomCode = normaliseRoomCode(code);
  if (!roomCode) {
    fail(client, "Please enter a valid room code.");
    return;
  }

  detachClientFromRoom(client, "switch_room");

  const room = rooms.get(roomCode);
  if (!room) {
    fail(client, "房间不存在");
    return;
  }
  if (room.players.size >= 2 && !room.players.has(client.id)) {
    fail(client, "Room is full.");
    return;
  }

  room.players.set(client.id, {
    id: client.id,
    username: client.user.username,
    role: null,
    joinedAt: nowIso(),
    client,
  });
  client.roomCode = room.code;

  if (!room.hostId || !room.players.has(room.hostId)) {
    room.hostId = client.id;
    room.hostUsername = client.user.username;
  }

  emitRoomState(room);
}

function updateHostOnlineProgress(room, updater) {
  const host = room?.hostUsername ? getUserRecord(room.hostUsername) : null;
  if (!host) {
    return null;
  }

  ensureUserProgressShape(host);
  const next = cloneProgress(host.progress_online_host) || createEmptyProgress();
  updater(next);
  next.updatedAt = nowIso();
  host.progress_online_host = next;
  host.updatedAt = nowIso();
  saveAccountsStore();
  return next;
}

function handleRoomMessage(client, message) {
  const room = findPlayerRoom(client);
  if (!room) {
    fail(client, "Join or create a room first.");
    return;
  }

  const player = room.players.get(client.id);
  if (!player) {
    fail(client, "Room state is invalid. Rejoin the room.");
    return;
  }

  touchRoom(room);

  switch (message.type) {
    case "select_level": {
      if (client.id !== room.hostId) {
        fail(client, "Only the host can choose a level.");
        return;
      }

      room.selectedTempleId = String(message.templeId || "");
      room.selectedLevelId = String(message.levelId || "");
      room.game = {
        status: "lobby",
        nonce: null,
        startedAt: null,
        startedAtMs: null,
      };
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
          if (other.id !== client.id && other.role === nextRole) {
            fail(client, "That role is already taken.");
            return;
          }
        }
      }

      player.role = nextRole;
      emitRoomState(room);
      return;
    }

    case "start_level": {
      if (client.id !== room.hostId) {
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

      const roles = [...room.players.values()].map((currentPlayer) => currentPlayer.role);
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
      emitRoomState(room);
      broadcastRoom(room, {
        type: "start_level",
        room: serialiseRoom(room),
        elapsedMs: 0,
      });
      return;
    }

    case "retry_level": {
      if (client.id !== room.hostId) {
        fail(client, "Only the host can retry.");
        return;
      }
      if (!room.selectedTempleId || !room.selectedLevelId) {
        fail(client, "No level selected.");
        return;
      }

      room.game = {
        status: "playing",
        nonce: randomId(8),
        startedAt: nowIso(),
        startedAtMs: Date.now(),
      };
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
      if (client.id !== room.hostId) {
        fail(client, "Only the host can continue level selection.");
        return;
      }

      room.game = {
        status: "lobby",
        nonce: null,
        startedAt: null,
        startedAtMs: null,
      };
      room.selectedLevelId = null;
      emitRoomState(room);
      broadcastRoom(room, {
        type: "return_to_room",
        reason: "continue_levels",
      }, { skipClientId: room.hostId });
      return;
    }

    case "input": {
      if (room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }
      broadcastRoom(room, {
        type: "player_input",
        clientId: client.id,
        role: player.role,
        nonce: message.nonce,
        seq: Number(message.seq || 0),
        state: {
          left: !!message.state?.left,
          right: !!message.state?.right,
          up: !!message.state?.up,
        },
      }, { skipClientId: client.id });
      return;
    }

    case "snapshot": {
      if (client.id !== room.hostId || room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }
      broadcastRoom(room, {
        type: "level_snapshot",
        nonce: message.nonce,
        elapsedMs: Math.max(0, Date.now() - (room.game.startedAtMs || Date.now())),
        bodies: Array.isArray(message.bodies) ? message.bodies : [],
        players: message.players || null,
      });
      return;
    }

    case "complete_level":
    case "level_complete": {
      if (client.id !== room.hostId || room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }

      updateHostOnlineProgress(room, (progress) => {
        const key = `${room.selectedTempleId}:${room.selectedLevelId}`;
        if (!progress.completedLevels.includes(key)) {
          progress.completedLevels.push(key);
        }
      });

      room.game.status = "ended";
      emitRoomState(room);
      broadcastRoom(room, {
        type: "online_finish_animation",
        nonce: message.nonce,
      }, { skipClientId: room.hostId });
      broadcastRoom(room, {
        type: "level_complete",
        nonce: message.nonce,
        payload: message.payload || null,
      });
      return;
    }

    case "level_failed": {
      if (client.id !== room.hostId || room.game.status !== "playing" || room.game.nonce !== message.nonce) {
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
  switch (message.type) {
    case "authenticate": {
      const token = String(message.token || "");
      const session = sessions.get(token);
      if (!session) {
        fail(client, "Login expired. Please log in again.");
        return;
      }
      const user = getUserRecord(session.username);
      if (!user) {
        fail(client, "Account does not exist.");
        return;
      }
      client.user = {
        username: user.username,
      };
      sendMessage(client, {
        type: "authenticated",
        user: {
          username: user.username,
        },
      });
      return;
    }

    case "create_room": {
      if (!client.user) {
        fail(client, "Please log in first.");
        return;
      }
      const code = generateRoomCode();
      const room = createRoom(code, client.user.username);
      rooms.set(code, room);
      joinRoom(client, code);
      return;
    }

    case "join_room": {
      joinRoom(client, message.roomCode);
      return;
    }

    case "leave_room": {
      detachClientFromRoom(client, "left");
      return;
    }

    default:
      handleRoomMessage(client, message);
  }
}

function decodeFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) === 0x80;
  let length = secondByte & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) {
      return null;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return null;
    }
    const high = buffer.readUInt32BE(2);
    const low = buffer.readUInt32BE(6);
    length = high * 2 ** 32 + low;
    offset = 10;
  }

  const maskSize = masked ? 4 : 0;
  if (length > MAX_MESSAGE_BYTES) {
    throw new Error("WebSocket payload too large.");
  }
  if (buffer.length < offset + maskSize + length) {
    return null;
  }

  let payload;
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    const dataStart = offset + 4;
    payload = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[dataStart + index] ^ mask[index % 4];
    }
    offset = dataStart + length;
  } else {
    payload = buffer.subarray(offset, offset + length);
    offset += length;
  }

  return {
    opcode,
    bytesConsumed: offset,
    payload,
  };
}

function createWebSocketClient(socket) {
  return {
    id: randomId(6),
    socket,
    buffer: Buffer.alloc(0),
    roomCode: null,
    user: null,
    lastSeenAt: Date.now(),
    lastPongAt: Date.now(),
    isAlive: true,
  };
}

function closeSocket(client) {
  if (client.socket.destroyed) {
    return;
  }
  try {
    sendFrame(client.socket, Buffer.alloc(0), 0x8);
    client.socket.end();
  } catch (error) {
    client.socket.destroy();
  }
}

function destroyClient(client, reason = "disconnect") {
  detachClientFromRoom(client, reason);
  clients.delete(client.id);
  closeSocket(client);
}

function handleSocketData(client, chunk) {
  client.lastSeenAt = Date.now();
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (true) {
    let frame;
    try {
      frame = decodeFrame(client.buffer);
    } catch (error) {
      destroyClient(client, "bad_frame");
      return;
    }

    if (!frame) {
      return;
    }

    client.buffer = client.buffer.subarray(frame.bytesConsumed);

    if (frame.opcode === 0x8) {
      destroyClient(client, "close_frame");
      return;
    }
    if (frame.opcode === 0x9) {
      sendFrame(client.socket, frame.payload, 0x0a);
      continue;
    }
    if (frame.opcode === 0x0a) {
      client.isAlive = true;
      client.lastPongAt = Date.now();
      continue;
    }
    if (frame.opcode !== 0x1) {
      continue;
    }

    try {
      const message = JSON.parse(frame.payload.toString("utf8"));
      handleMessage(client, message);
    } catch (error) {
      fail(client, "Invalid message payload.");
    }
  }
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

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function getSafePath(urlPath) {
  const decodedPath = decodeURIComponent((urlPath || "/").split("?")[0] || "/");
  const relativePath = decodedPath === "/" ? "/index.html" : decodedPath;
  const resolvedPath = path.resolve(path.join(ROOT, `.${relativePath}`));
  if (!resolvedPath.startsWith(ROOT)) {
    return null;
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

function cleanupIdleRooms() {
  const cutoff = Date.now() - ROOM_IDLE_TTL_MS;
  for (const room of rooms.values()) {
    if (room.players.size === 0 || room.updatedAt < cutoff) {
      rooms.delete(room.code);
    }
  }
}

function pingClients() {
  const payload = Buffer.from(String(Date.now()));
  for (const client of clients.values()) {
    if (client.socket.destroyed) {
      destroyClient(client, "socket_destroyed");
      continue;
    }
    if (!client.isAlive && Date.now() - client.lastPongAt > CLIENT_PING_INTERVAL_MS * 2) {
      destroyClient(client, "ping_timeout");
      continue;
    }
    client.isAlive = false;
    try {
      sendFrame(client.socket, payload, 0x9);
    } catch (error) {
      destroyClient(client, "ping_failed");
    }
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
    if (getUserRecord(username)) {
      writeJson(response, 400, { ok: false, message: "Account already exists." });
      return;
    }

    const passwordState = hashPassword(password);
    accountsStore.users[usernameKey(username)] = {
      username,
      passwordSalt: passwordState.salt,
      passwordHash: passwordState.hash,
      progress_single: createEmptyProgress(),
      progress_online_host: createEmptyProgress(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    saveAccountsStore();

    const token = createSession(username);
    writeJson(response, 200, {
      ok: true,
      token,
      user: { username },
      progressSingle: createEmptyProgress(),
      progressOnlineHost: createEmptyProgress(),
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
    const user = getUserRecord(username);

    if (!user || !verifyPassword(password, user)) {
      writeJson(response, 401, { ok: false, message: "Invalid username or password." });
      return;
    }

    const token = createSession(user.username);
    writeJson(response, 200, {
      ok: true,
      token,
      user: { username: user.username },
      progressSingle: cloneProgress(user.progress_single),
      progressOnlineHost: cloneProgress(user.progress_online_host),
    });
  } catch (error) {
    writeJson(response, 400, { ok: false, message: "Invalid login request." });
  }
}

function handleMe(request, response) {
  const session = getSessionFromRequest(request);
  if (!session) {
    writeJson(response, 401, { ok: false, message: "Not logged in." });
    return;
  }

  const user = getUserRecord(session.username);
  if (!user) {
    writeJson(response, 401, { ok: false, message: "Account does not exist." });
    return;
  }

  writeJson(response, 200, {
    ok: true,
    user: { username: user.username },
    progressSingle: cloneProgress(user.progress_single),
    progressOnlineHost: cloneProgress(user.progress_online_host),
  });
}

async function handleProgressSave(request, response) {
  const session = getSessionFromRequest(request);
  if (!session) {
    writeJson(response, 401, { ok: false, message: "Not logged in." });
    return;
  }

  const user = getUserRecord(session.username);
  if (!user) {
    writeJson(response, 401, { ok: false, message: "Account does not exist." });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const mode = String(body.mode || "single");
    if (mode === "online_host") {
      user.progress_online_host = cloneProgress(body.progress || createEmptyProgress());
    } else {
      user.progress_single = cloneProgress(body.progress || createEmptyProgress());
    }
    user.updatedAt = nowIso();
    saveAccountsStore();
    writeJson(response, 200, { ok: true });
  } catch (error) {
    writeJson(response, 400, { ok: false, message: "Progress save failed." });
  }
}

function getModeFromUrl(url) {
  return String((url.split("?")[1] || "").includes("mode=online_host") ? "online_host" : "single");
}

function handleProgressReset(request, response) {
  const session = getSessionFromRequest(request);
  if (!session) {
    writeJson(response, 401, { ok: false, message: "Not logged in." });
    return;
  }

  const user = getUserRecord(session.username);
  if (!user) {
    writeJson(response, 401, { ok: false, message: "Account does not exist." });
    return;
  }

  const mode = getModeFromUrl(request.url);
  if (mode === "online_host") {
    user.progress_online_host = createEmptyProgress();
  } else {
    user.progress_single = createEmptyProgress();
  }
  user.updatedAt = nowIso();
  saveAccountsStore();
  writeJson(response, 200, { ok: true });
}

function collectAllLevelIds() {
  const gameConfig = readJsonFile(path.join(ROOT, "game.json"));
  const templePaths = Array.isArray(gameConfig.temples) ? gameConfig.temples : [];
  const completedLevels = [];

  templePaths.forEach((templePath) => {
    const temple = readJsonFile(path.join(ROOT, "data", templePath, "temple.json"));
    (temple.levels || []).forEach((level) => {
      completedLevels.push(`${temple.id}:${level.id}`);
    });
  });

  return completedLevels;
}

function handleProgressCompleteAll(request, response) {
  const session = getSessionFromRequest(request);
  if (!session) {
    writeJson(response, 401, { ok: false, message: "Not logged in." });
    return;
  }

  const user = getUserRecord(session.username);
  if (!user) {
    writeJson(response, 401, { ok: false, message: "Account does not exist." });
    return;
  }

  const mode = getModeFromUrl(request.url);
  const nextProgress = {
    completedLevels: collectAllLevelIds(),
    updatedAt: nowIso(),
  };

  if (mode === "online_host") {
    user.progress_online_host = nextProgress;
  } else {
    user.progress_single = nextProgress;
  }
  user.updatedAt = nowIso();
  saveAccountsStore();
  writeJson(response, 200, { ok: true, progress: nextProgress });
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      activeRooms: rooms.size,
      activeClients: clients.size,
      accounts: Object.keys(accountsStore.users).length,
      accountsFile: ACCOUNTS_FILE,
      timestamp: nowIso(),
    });
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

  if (request.method === "GET" && request.url === "/api/auth/me") {
    handleMe(request, response);
    return;
  }

  if (request.method === "POST" && request.url.startsWith("/api/progress/save")) {
    handleProgressSave(request, response);
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

  if (request.method !== "GET") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }

  serveStaticFile(request, response);
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );

  const client = createWebSocketClient(socket);
  clients.set(client.id, client);
  sendMessage(client, {
    type: "welcome",
    clientId: client.id,
  });

  socket.on("data", (chunk) => handleSocketData(client, chunk));
  socket.on("close", () => destroyClient(client, "disconnect"));
  socket.on("error", () => destroyClient(client, "disconnect"));
});

server.listen(PORT, HOST, () => {
  ensureDirectory(path.dirname(ACCOUNTS_FILE));
  console.log(`[server] listening on http://127.0.0.1:${PORT}/index.html`);
  console.log(`[server] health check on http://127.0.0.1:${PORT}/healthz`);
  console.log(`[server] accounts file: ${ACCOUNTS_FILE}`);
});

setInterval(cleanupIdleRooms, ROOM_CLEANUP_INTERVAL_MS).unref();
setInterval(pingClients, CLIENT_PING_INTERVAL_MS).unref();

process.on("SIGINT", () => {
  for (const client of clients.values()) {
    closeSocket(client);
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const client of clients.values()) {
    closeSocket(client);
  }
  process.exit(0);
});
