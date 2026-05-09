const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8005);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const PROGRESS_FILE = path.resolve(process.env.PROGRESS_FILE || path.join(DATA_DIR, "online-progress.json"));
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES || 1024 * 1024);
const CLIENT_PING_INTERVAL_MS = Number(process.env.CLIENT_PING_INTERVAL_MS || 25000);
const ROOM_IDLE_TTL_MS = Number(process.env.ROOM_IDLE_TTL_MS || 6 * 60 * 60 * 1000);
const ROOM_CLEANUP_INTERVAL_MS = Number(process.env.ROOM_CLEANUP_INTERVAL_MS || 60 * 1000);

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

function createEmptyProgress() {
  return {
    completedLevels: [],
    history: [],
    updatedAt: null,
  };
}

function loadProgressStore() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch (error) {
    return {};
  }
}

function atomicWriteJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempFile, filePath);
}

let progressStore = loadProgressStore();
const rooms = new Map();
const clients = new Map();

function saveProgressStore() {
  atomicWriteJson(PROGRESS_FILE, progressStore);
}

function cloneProgress(code) {
  const progress = progressStore[code] || createEmptyProgress();
  return {
    completedLevels: [...(progress.completedLevels || [])],
    history: [...(progress.history || [])],
    updatedAt: progress.updatedAt || null,
  };
}

function ensureProgress(code) {
  if (!progressStore[code]) {
    progressStore[code] = createEmptyProgress();
  }
  return progressStore[code];
}

function randomId(length = 12) {
  return crypto.randomBytes(length).toString("hex");
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

function sanitiseName(value) {
  const base = String(value || "").trim().slice(0, 16);
  if (base) {
    return base;
  }

  return `Player-${Math.floor(Math.random() * 9000 + 1000)}`;
}

function normaliseRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function touchRoom(room) {
  room.updatedAt = Date.now();
}

function createRoom(code) {
  return {
    code,
    hostId: null,
    players: new Map(),
    selectedTempleId: null,
    selectedLevelId: null,
    game: {
      status: "lobby",
      nonce: null,
      startedAt: null,
    },
    progress: cloneProgress(code),
    updatedAt: Date.now(),
  };
}

function getOrCreateRoom(code) {
  const roomCode = normaliseRoomCode(code);
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, createRoom(roomCode));
  }
  const room = rooms.get(roomCode);
  touchRoom(room);
  return room;
}

function serialiseRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    selectedTempleId: room.selectedTempleId,
    selectedLevelId: room.selectedLevelId,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      role: player.role || null,
      joinedAt: player.joinedAt,
    })),
    game: {
      status: room.game.status,
      nonce: room.game.nonce,
      startedAt: room.game.startedAt,
    },
    progress: {
      completedLevels: [...room.progress.completedLevels],
      history: [...room.progress.history],
      updatedAt: room.progress.updatedAt,
    },
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
  }

  if (removeRoomIfEmpty(room)) {
    return;
  }

  if (room.players.size < 2 && room.game.status === "playing") {
    room.game = {
      status: "lobby",
      nonce: null,
      startedAt: null,
    };
    broadcastRoom(room, {
      type: "return_to_room",
      reason: reason === "disconnect" ? "player_left" : reason,
    });
  }

  emitRoomState(room);
}

function joinRoom(client, code, name) {
  const roomCode = normaliseRoomCode(code);
  if (!roomCode) {
    fail(client, "Invalid room code.");
    return;
  }

  detachClientFromRoom(client, "switch_room");

  const room = getOrCreateRoom(roomCode);

  if (room.players.size >= 2 && !room.players.has(client.id)) {
    fail(client, "Room is full. Only 2 players are allowed.");
    return;
  }

  room.progress = cloneProgress(room.code);
  room.players.set(client.id, {
    id: client.id,
    name: sanitiseName(name),
    role: null,
    joinedAt: nowIso(),
    client,
  });
  client.roomCode = room.code;

  if (!room.hostId || !room.players.has(room.hostId)) {
    room.hostId = client.id;
  }

  emitRoomState(room);
}

function updateRoomProgress(room, entry) {
  const key = `${entry.templeId}:${entry.levelId}`;
  const progress = ensureProgress(room.code);

  if (!progress.completedLevels.includes(key)) {
    progress.completedLevels.push(key);
  }

  progress.history.push({
    key,
    success: entry.success !== false,
    finishedAt: nowIso(),
  });
  progress.updatedAt = nowIso();
  room.progress = cloneProgress(room.code);
  touchRoom(room);
  saveProgressStore();
}

function resetRoomProgress(room) {
  progressStore[room.code] = createEmptyProgress();
  room.progress = cloneProgress(room.code);
  touchRoom(room);
  saveProgressStore();
}

function handleRoomMessage(client, message) {
  const room = findPlayerRoom(client);

  if (!room) {
    fail(client, "Join a room first.");
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
      };

      for (const roomPlayer of room.players.values()) {
        roomPlayer.role = null;
      }

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
      };

      emitRoomState(room);
      broadcastRoom(room, {
        type: "start_level",
        room: serialiseRoom(room),
      });
      return;
    }

    case "reset_room_progress": {
      if (client.id !== room.hostId) {
        fail(client, "Only the host can reset online progress.");
        return;
      }

      resetRoomProgress(room);
      emitRoomState(room);
      return;
    }

    case "retry_level": {
      if (!room.selectedTempleId || !room.selectedLevelId) {
        fail(client, "There is no selected level to retry.");
        return;
      }

      room.game = {
        status: "playing",
        nonce: randomId(8),
        startedAt: nowIso(),
      };

      emitRoomState(room);
      broadcastRoom(room, {
        type: "start_level",
        room: serialiseRoom(room),
      });
      return;
    }

    case "return_to_room": {
      room.game = {
        status: "lobby",
        nonce: null,
        startedAt: null,
      };

      emitRoomState(room);
      broadcastRoom(room, {
        type: "return_to_room",
        reason: "manual",
      });
      return;
    }

    case "input": {
      if (room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }

      broadcastRoom(
        room,
        {
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
        },
        { skipClientId: client.id },
      );
      return;
    }

    case "snapshot": {
      if (client.id !== room.hostId || room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }

      broadcastRoom(
        room,
        {
          type: "level_snapshot",
          nonce: message.nonce,
          clock: Number(message.clock || 0),
          bodies: Array.isArray(message.bodies) ? message.bodies : [],
        },
        { skipClientId: client.id },
      );
      return;
    }

    case "complete_level": {
      if (client.id !== room.hostId || room.game.status !== "playing" || room.game.nonce !== message.nonce) {
        return;
      }

      updateRoomProgress(room, {
        templeId: room.selectedTempleId,
        levelId: room.selectedLevelId,
        success: true,
      });
      room.game.status = "ended";

      emitRoomState(room);
      broadcastRoom(room, {
        type: "level_complete",
        nonce: message.nonce,
        summary: {
          state: message.summary?.state || null,
          totalDiamonds: message.summary?.totalDiamonds || 0,
        },
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
        summary: {
          state: message.summary?.state || null,
        },
      });
      return;
    }

    default:
      fail(client, `Unknown message type: ${message.type}`);
  }
}

function handleMessage(client, message) {
  switch (message.type) {
    case "create_room": {
      const code = generateRoomCode();
      joinRoom(client, code, message.name);
      return;
    }

    case "join_room": {
      joinRoom(client, message.roomCode, message.name);
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

function createWebSocketClient(socket, request) {
  return {
    id: randomId(6),
    socket,
    request,
    buffer: Buffer.alloc(0),
    roomCode: null,
    connectedAt: nowIso(),
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

function getSafePath(urlPath) {
  const decodedPath = decodeURIComponent((urlPath || "/").split("?")[0] || "/");
  const relativePath = decodedPath === "/" ? "/index.html" : decodedPath;
  const resolvedPath = path.resolve(path.join(ROOT, `.${relativePath}`));

  if (!resolvedPath.startsWith(ROOT)) {
    return null;
  }

  return resolvedPath;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
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
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600",
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
  const pingPayload = Buffer.from(String(Date.now()));

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
      sendFrame(client.socket, pingPayload, 0x9);
    } catch (error) {
      destroyClient(client, "ping_failed");
    }
  }
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      activeRooms: rooms.size,
      activeClients: clients.size,
      progressFile: PROGRESS_FILE,
      timestamp: nowIso(),
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

  const client = createWebSocketClient(socket, request);
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
  ensureDirectory(path.dirname(PROGRESS_FILE));
  console.log(`[server] listening on http://127.0.0.1:${PORT}/index.html`);
  console.log(`[server] health check on http://127.0.0.1:${PORT}/healthz`);
  console.log(`[server] progress file: ${PROGRESS_FILE}`);
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
