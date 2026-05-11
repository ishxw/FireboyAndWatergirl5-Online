const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8061);
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function request(pathname, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: pathname,
        method,
        headers: Object.assign(
          {},
          data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
          headers,
        ),
      },
      (res) => {
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
      },
    );
    req.on("error", reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

async function waitForHealth() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const response = await request("/healthz");
      if (response.status === 200) {
        return JSON.parse(response.body);
      }
    } catch (error) {}
    await sleep(250);
  }
  throw new Error("Timed out waiting for test server health check.");
}

async function getCookieHeader(context) {
  const cookies = await context.cookies(BASE);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function waitForState(page, state, timeout = 15000) {
  await page.waitForFunction(
    (expected) => {
      const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
      return game && game.state && game.state.current === expected;
    },
    state,
    { timeout },
  );
}

async function waitForLobby(page, visible, timeout = 15000) {
  await page.waitForFunction(
    (expected) => {
      const root = document.getElementById("lobby-root");
      return !!root && root.classList.contains("visible") === expected;
    },
    visible,
    { timeout },
  );
}

async function registerUser(page, username, password) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill("#username-input", username);
  await page.fill("#password-input", password);
  await page.click("#register-btn");
  await page.waitForSelector("#main-panel:not(.hidden)", { timeout: 15000 });
}

async function loginUser(page, username, password) {
  await page.fill("#username-input", username);
  await page.fill("#password-input", password);
  await page.click("#login-btn");
  await page.waitForSelector("#main-panel:not(.hidden)", { timeout: 15000 });
}

async function logoutUser(page) {
  await page.click("#logout-btn");
  await page.waitForSelector("#auth-panel:not(.hidden)", { timeout: 15000 });
}

async function chooseTemple(page, templeId) {
  await waitForState(page, "menu");
  await page.waitForTimeout(1500);
  const clicked = await page.evaluate((targetTempleId) => {
    const game = window.Phaser.GAMES[0];
    const selector = game.state.states.menu.templeHall.templeSelector;
    const temple =
      selector.icons.find((icon) => icon.data && icon.data.id === targetTempleId) ||
      selector.icons.find((icon) => icon.data);
    if (!temple) {
      throw new Error("Temple icon not found.");
    }
    if (typeof temple.click === "function") {
      temple.click();
      return "icon.click";
    }
    selector.didpan = false;
    selector.templeClicked(temple);
    return "selector.templeClicked";
  }, templeId);
  await page.waitForTimeout(3000);
  try {
    await waitForState(page, "levelMenu", 10000);
  } catch (error) {
    const debug = await page.evaluate(() => {
      const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
      const menu = game?.state?.states?.menu;
      const selector = menu?.templeHall?.templeSelector;
      return {
        currentState: game?.state?.current || null,
        hasSelector: !!selector,
        iconIds: selector?.icons?.map((icon) => icon?.data?.id).filter(Boolean) || [],
        iconMeta:
          selector?.icons?.map((icon) => ({
            id: icon?.data?.id || null,
            hasClick: typeof icon?.click === "function",
            visible: icon?.visible !== false,
            x: icon?.x,
            y: icon?.y,
          })) || [],
        lobbyVisible: document.getElementById("lobby-root")?.classList.contains("visible") || false,
      };
    });
    throw new Error(`Temple selection did not reach levelMenu via ${clicked}: ${JSON.stringify(debug)}`);
  }
}

async function chooseLevel(page, preferredLevelId, excludeLevelId) {
  await page.waitForFunction(() => {
    const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
    if (!game || game.state.current !== "levelMenu") {
      return false;
    }
    if (!game.__onlinePickingLevel) {
      return true;
    }
    return game.__onlineLevelSelectReady === true;
  }, { timeout: 15000 });

  return page.evaluate(
    ({ targetLevelId, skipLevelId }) => {
      const game = window.Phaser.GAMES[0];
      const levelMenu = game.state.states.levelMenu;
      const buttons = levelMenu.buttons.children.filter(
        (child) => child && child.data && child.data.id != null,
      );
      let button =
        buttons.find((child) => String(child.data.id) === String(targetLevelId)) ||
        buttons.find((child) => String(child.data.id) !== String(skipLevelId)) ||
        buttons[0];
      if (!button) {
        throw new Error("No level button available.");
      }
      const levelId = String(button.data.id);
      levelMenu.startLevel(button);
      return levelId;
    },
    { targetLevelId: preferredLevelId, skipLevelId: excludeLevelId },
  );
}

async function startOnlinePickerAndSelectLevel(page, templeId, preferredLevelId, excludeLevelId) {
  await page.click("#start-online-btn");
  await chooseTemple(page, templeId);
  const levelId = await chooseLevel(page, preferredLevelId, excludeLevelId);
  await waitForLobby(page, true);
  await page.waitForFunction(
    () => {
      const roomState = document.getElementById("room-state-text");
      return !!roomState && roomState.textContent.trim().length > 0;
    },
    { timeout: 10000 },
  );
  return levelId;
}

async function forceSuccess(page) {
  await page.waitForFunction(() => {
    const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
    return !!(game && game.level && game.level.loadCompleted);
  }, { timeout: 15000 });
  await page.evaluate(() => {
    const game = window.Phaser.GAMES[0];
    const level = game.level;
    if (!level) {
      throw new Error("Level not loaded.");
    }
    if (level.ui && level.ui.clock) {
      level.ui.clock.stop();
    }
    game.physics.box2d.paused = true;
    level.ended = true;
    game.state.add("endGame", game.require("States/End"));
    game.state.start("endGame", false, false, {
      success: true,
      data: level.levelData,
      state: level.levelState,
    });
  });
  await waitForState(page, "endGame", 10000);
}

async function clickEndContinue(page) {
  await page.evaluate(() => {
    const game = window.Phaser.GAMES[0];
    const endState = game.state.states.endGame;
    if (!endState || !endState.menu || typeof endState.menu.gotoMenu !== "function") {
      throw new Error("End menu continue button is unavailable.");
    }
    endState.menu.gotoMenu();
  });
}

async function quitOnlineLevel(page) {
  await page.waitForFunction(() => {
    const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
    return !!(game && game.level && game.level.loadCompleted);
  }, { timeout: 15000 });
  await page.evaluate(() => {
    const game = window.Phaser.GAMES[0];
    if (!game.level || typeof game.level.quit !== "function") {
      throw new Error("Online level quit is unavailable.");
    }
    game.level.quit();
  });
  await page.waitForTimeout(2000);
}

async function createContext(browser) {
  return browser.newContext({ viewport: { width: 1440, height: 900 } });
}

async function runSinglePlayerFlow(browser) {
  const context = await createContext(browser);
  const page = await context.newPage();
  const username = `s${Date.now().toString().slice(-7)}`;
  const password = "secret1";

  await registerUser(page, username, password);

  const page2 = await context.newPage();
  await page2.goto(BASE, { waitUntil: "networkidle" });
  await page2.waitForTimeout(1500);
  const cookieState = await page2.evaluate(() => ({
    authHidden: document.getElementById("auth-panel").classList.contains("hidden"),
    mainHidden: document.getElementById("main-panel").classList.contains("hidden"),
  }));
  assert(cookieState.authHidden && !cookieState.mainHidden, "Cookie auto-login failed for single-player user.");

  await logoutUser(page);
  await loginUser(page, username, password);

  await page.click("#mode-grid button:nth-child(1)");
  await page.click("#single-start-btn");
  await chooseTemple(page, "fire");
  const singleLevelId = await chooseLevel(page, null, null);
  try {
    await waitForState(page, "level", 15000);
  } catch (error) {
    const debug = await page.evaluate(() => {
      const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
      const levelMenu = game?.state?.states?.levelMenu;
      return {
        currentState: game?.state?.current || null,
        fading: !!game?.state?.fading,
        hasLevel: !!game?.level,
        loadCompleted: game?.level ? !!game.level.loadCompleted : null,
        buttons:
          levelMenu?.buttons?.children?.filter((child) => child && child.data).map((child) => ({
            id: child.data.id,
            visible: child.visible !== false,
          })) || [],
      };
    });
    throw new Error(`Single-player level did not start after selecting ${singleLevelId}: ${JSON.stringify(debug)}`);
  }
  await waitForLobby(page, false);

  await forceSuccess(page);
  await sleep(2000);

  const cookieHeader = await getCookieHeader(context);
  const me = await request("/api/auth/me", "GET", null, { Cookie: cookieHeader });
  const mePayload = JSON.parse(me.body);
  assert(
    mePayload.progressSingle.completedLevels.includes(`fire:${singleLevelId}`),
    `Single-player progress did not persist fire:${singleLevelId}.`,
  );

  await context.close();
}

async function runOnlineFlow(browser) {
  const hostContext = await createContext(browser);
  const guestContext = await createContext(browser);
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const usernameHost = `h${Date.now().toString().slice(-7)}`;
  const usernameGuest = `g${Date.now().toString().slice(-7)}`;
  const password = "secret1";

  await registerUser(host, usernameHost, password);
  await logoutUser(host);
  await loginUser(host, usernameHost, password);

  await registerUser(guest, usernameGuest, password);
  await logoutUser(guest);
  await loginUser(guest, usernameGuest, password);

  await host.click("#mode-grid button:nth-child(2)");
  await guest.click("#mode-grid button:nth-child(2)");

  await host.click("#create-room-btn");
  await host.waitForSelector("#room-view:not(.hidden)", { timeout: 15000 });
  const roomCode = (await host.locator("#room-code-text").textContent()).trim();
  assert(roomCode && roomCode !== "------", "Host did not receive a room code.");

  await guest.fill("#room-code-input", roomCode);
  await guest.click("#join-room-btn");
  await guest.waitForSelector("#room-view:not(.hidden)", { timeout: 15000 });
  await host.waitForFunction(
    () => document.querySelectorAll("#player-list .player-chip").length === 2,
    { timeout: 15000 },
  );
  await guest.waitForFunction(
    () => document.querySelectorAll("#player-list .player-chip").length === 2,
    { timeout: 15000 },
  );

  await host.click("#role-grid button:nth-child(1)");
  await guest.click("#role-grid button:nth-child(2)");
  await host.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("#player-list .player-chip"))
        .map((node) => node.textContent)
        .join("|")
        .includes("火娃") &&
      Array.from(document.querySelectorAll("#player-list .player-chip"))
        .map((node) => node.textContent)
        .join("|")
        .includes("水娃"),
    { timeout: 15000 },
  );

  const firstLevelId = await startOnlinePickerAndSelectLevel(host, "fire", null, null);
  await host.click("#start-online-btn");
  await waitForState(host, "level", 15000);
  await waitForState(guest, "level", 15000);

  await forceSuccess(host);
  await waitForState(guest, "endGame", 15000);
  await sleep(2000);

  const hostCookie = await getCookieHeader(hostContext);
  const meHost = await request("/api/auth/me", "GET", null, { Cookie: hostCookie });
  const meHostPayload = JSON.parse(meHost.body);
  assert(
    meHostPayload.progressOnlineHost.completedLevels.includes(`fire:${firstLevelId}`),
    `Online host progress did not persist fire:${firstLevelId}.`,
  );

  await clickEndContinue(host);
  await waitForState(host, "levelMenu", 15000);
  try {
    await waitForLobby(guest, true);
  } catch (error) {
    const debug = await guest.evaluate(() => {
      const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
      return {
        currentState: game?.state?.current || null,
        lobbyVisible: document.getElementById("lobby-root")?.classList.contains("visible") || false,
        roomState: document.getElementById("room-state-text")?.textContent?.trim() || null,
      };
    });
    throw new Error(`Guest did not return to lobby after continue: ${JSON.stringify(debug)}`);
  }

  const secondLevelId = await chooseLevel(host, null, firstLevelId);
  await waitForLobby(host, true);
  await host.click("#start-online-btn");
  await waitForState(host, "level", 15000);
  await waitForState(guest, "level", 15000);

  assert(secondLevelId, "Failed to choose a second online level.");

  await quitOnlineLevel(host);
  try {
    await waitForLobby(host, true);
  } catch (error) {
    const debug = await host.evaluate(() => {
      const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
      return {
        currentState: game?.state?.current || null,
        lobbyVisible: document.getElementById("lobby-root")?.classList.contains("visible") || false,
        roomState: document.getElementById("room-state-text")?.textContent?.trim() || null,
      };
    });
    throw new Error(`Host did not return to lobby after quit: ${JSON.stringify(debug)}`);
  }
  try {
    await waitForLobby(guest, true);
  } catch (error) {
    const hostDebug = await host.evaluate(() => {
      const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
      return {
        currentState: game?.state?.current || null,
        lobbyVisible: document.getElementById("lobby-root")?.classList.contains("visible") || false,
        roomState: document.getElementById("room-state-text")?.textContent?.trim() || null,
      };
    });
    const guestDebug = await guest.evaluate(() => {
      const game = window.Phaser && window.Phaser.GAMES && window.Phaser.GAMES[0];
      return {
        currentState: game?.state?.current || null,
        lobbyVisible: document.getElementById("lobby-root")?.classList.contains("visible") || false,
        roomState: document.getElementById("room-state-text")?.textContent?.trim() || null,
      };
    });
    throw new Error(`Guest did not return to lobby after host quit: ${JSON.stringify({ hostDebug, guestDebug })}`);
  }
  await host.waitForFunction(
    () => document.getElementById("room-state-text").textContent.trim() === "等待中",
    { timeout: 15000 },
  );
  await guest.waitForFunction(
    () => document.getElementById("room-state-text").textContent.trim() === "等待中",
    { timeout: 15000 },
  );

  await hostContext.close();
  await guestContext.close();
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbwg5-e2e-"));
  const serverLogs = [];
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: tempDir,
      DB_FILE: path.join(tempDir, "fireboy-online.sqlite"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk) => {
    serverLogs.push(chunk.toString());
  });
  server.stderr.on("data", (chunk) => {
    serverLogs.push(chunk.toString());
  });

  try {
    await waitForHealth();
    const browser = await chromium.launch({
      headless: true,
      executablePath: CHROME,
    });

    try {
      await runSinglePlayerFlow(browser);
      await runOnlineFlow(browser);
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error("server logs:");
    console.error(serverLogs.join(""));
    throw error;
  } finally {
    server.kill();
    await new Promise((resolve) => {
      server.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log("e2e-ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
