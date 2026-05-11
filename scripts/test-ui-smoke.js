const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8055/";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function login(page, username, password) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill("#username-input", username);
  await page.fill("#password-input", password);
  await page.click("#login-btn");
  await page.waitForSelector("#main-panel:not(.hidden)", { timeout: 15000 });
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const username = `ui${Date.now().toString().slice(-6)}`;
  const password = "secret1";

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill("#username-input", username);
  await page.fill("#password-input", password);
  await page.click("#register-btn");
  await page.waitForTimeout(3000);

  const authState = await page.evaluate(() => ({
    authHidden: document.getElementById("auth-panel").classList.contains("hidden"),
    mainHidden: document.getElementById("main-panel").classList.contains("hidden"),
    userText: document.getElementById("auth-user-text").textContent.trim(),
    authStatus: document.getElementById("auth-status").textContent.trim(),
    onlineStatus: document.getElementById("online-status").textContent.trim(),
  }));

  if (!authState.authHidden || authState.mainHidden) {
    throw new Error(`Unexpected auth state after register: ${JSON.stringify(authState)}`);
  }

  const page2 = await context.newPage();
  await page2.goto(BASE, { waitUntil: "networkidle" });
  await page2.waitForTimeout(1500);
  const cookieState = await page2.evaluate(() => ({
    authHidden: document.getElementById("auth-panel").classList.contains("hidden"),
    mainHidden: document.getElementById("main-panel").classList.contains("hidden"),
    userText: document.getElementById("auth-user-text").textContent.trim(),
  }));

  if (!cookieState.authHidden || cookieState.mainHidden) {
    throw new Error(`Cookie auto-login failed: ${JSON.stringify(cookieState)}`);
  }

  await page.click("#mode-grid button:nth-child(2)");
  await page.click("#create-room-btn");
  await page.waitForSelector("#room-view:not(.hidden)", { timeout: 15000 });

  const roomState = await page.evaluate(() => ({
    roomCode: document.getElementById("room-code-text").textContent.trim(),
    retryDisplay: getComputedStyle(document.getElementById("retry-online-btn")).display,
    playerCount: document.querySelectorAll("#player-list .player-chip").length,
    hasHtmlInjection: !!document.querySelector("#player-list script, #player-list img"),
  }));

  if (!roomState.roomCode || roomState.roomCode === "------") {
    throw new Error(`Room code missing: ${JSON.stringify(roomState)}`);
  }
  if (roomState.retryDisplay !== "none") {
    throw new Error(`Retry button should be hidden in room view: ${JSON.stringify(roomState)}`);
  }
  if (roomState.playerCount !== 1) {
    throw new Error(`Unexpected player count in room: ${JSON.stringify(roomState)}`);
  }
  if (roomState.hasHtmlInjection) {
    throw new Error(`Unsafe DOM content found in player list: ${JSON.stringify(roomState)}`);
  }

  await page.click("#logout-btn");
  await page.waitForSelector("#auth-panel:not(.hidden)", { timeout: 15000 });

  await browser.close();
  console.log("ui-smoke-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
