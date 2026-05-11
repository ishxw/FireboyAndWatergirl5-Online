const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8060);

function request(path, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const requestOptions = {
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method,
      headers: Object.assign(
        {},
        data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
        headers,
      ),
    };

    const req = http.request(requestOptions, (res) => {
      let chunks = "";
      res.on("data", (chunk) => {
        chunks += chunk;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: chunks,
        });
      });
    });

    req.on("error", reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function waitFor(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket message."));
    }, timeoutMs);

    function onMessage(raw) {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    }

    ws.on("message", onMessage);
  });
}

async function registerUser(username, password) {
  const response = await request("/api/register", "POST", { username, password });
  if (response.status !== 200) {
    throw new Error(`Register failed for ${username}: ${response.body}`);
  }
  return (response.headers["set-cookie"] || [])[0] || "";
}

async function main() {
  console.log("health");
  const health = await request("/healthz");
  if (health.status !== 200) {
    throw new Error(`Health check failed: ${health.status} ${health.body}`);
  }

  console.log("register");
  const cookieA = await registerUser(`smk${Date.now()}`.slice(-8), "secret1");
  const cookieB = await registerUser(`skg${Date.now()}`.slice(-8), "secret1");

  console.log("auth-me");
  const me = await request("/api/auth/me", "GET", null, { Cookie: cookieA });
  if (me.status !== 200) {
    throw new Error(`Auth me failed: ${me.status} ${me.body}`);
  }

  console.log("mark");
  const mark = await request(
    "/api/progress/mark-complete",
    "POST",
    { mode: "single", templeId: "fire", levelId: "2" },
    { Cookie: cookieA },
  );
  if (mark.status !== 200) {
    throw new Error(`Mark complete failed: ${mark.status} ${mark.body}`);
  }

  console.log("ws-connect");
  const wsA = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookieA } });
  const wsB = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookieB } });

  await Promise.all([
    waitFor(wsA, (message) => message.type === "authenticated"),
    waitFor(wsB, (message) => message.type === "authenticated"),
  ]);

  console.log("create-room");
  wsA.send(JSON.stringify({ type: "create_room" }));
  const created = await waitFor(wsA, (message) => message.type === "room_state" && message.room && message.room.code);
  const roomCode = created.room.code;

  console.log("join-room");
  wsB.send(JSON.stringify({ type: "join_room", roomCode }));
  await Promise.all([
    waitFor(wsA, (message) => message.type === "room_state" && message.room.players.length === 2),
    waitFor(wsB, (message) => message.type === "room_state" && message.room.players.length === 2),
  ]);

  console.log("roles");
  wsA.send(JSON.stringify({ type: "select_role", role: "fb" }));
  await waitFor(wsA, (message) => message.type === "room_state");
  wsB.send(JSON.stringify({ type: "select_role", role: "wg" }));
  await Promise.all([
    waitFor(wsA, (message) => message.type === "room_state" && message.room.players.some((player) => player.role === "wg")),
    waitFor(wsB, (message) => message.type === "room_state" && message.room.players.some((player) => player.role === "fb")),
  ]);

  console.log("select-level");
  wsA.send(JSON.stringify({ type: "select_level", templeId: "fire", levelId: "2" }));
  await waitFor(wsA, (message) => message.type === "room_state" && message.room.selectedTempleId === "fire");

  console.log("start-level");
  wsA.send(JSON.stringify({ type: "start_level" }));
  const startedA = await waitFor(wsA, (message) => message.type === "start_level");
  await waitFor(wsB, (message) => message.type === "start_level");

  const nonce = startedA.room.game.nonce;
  console.log("snapshot");
  wsA.send(
    JSON.stringify({
      type: "snapshot",
      nonce,
      elapsedMs: 3210,
      bodies: [{ id: "player-fb:1", x: 1, y: 2, vx: 0, vy: 0, angle: 0, av: 0 }],
      players: {
        fb: { dying: false, dead: false, isDead: false, visible: true },
        wg: { dying: false, dead: false, isDead: false, visible: true },
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  wsA.close();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log("reconnect");
  const wsA2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookieA } });
  await waitFor(wsA2, (message) => message.type === "authenticated");
  const resumed = await waitFor(wsA2, (message) => message.type === "start_level" && message.resumed === true, 10000);

  if (!resumed.snapshot || resumed.snapshot.elapsedMs !== 3210) {
    throw new Error(`Resume snapshot mismatch: ${JSON.stringify(resumed)}`);
  }

  wsA2.close();
  wsB.close();
  console.log("smoke-ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
