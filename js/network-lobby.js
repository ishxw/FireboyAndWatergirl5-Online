(function () {
  "use strict";

  const DEFAULT_USERNAME = "";
  const ROOM_STATE_LABELS = {
    lobby: "等待中",
    playing: "游戏中",
    ended: "已结束",
  };
  const MODES = [
    { id: "single", title: "单人模式", copy: "使用账号单机进度。" },
    { id: "online", title: "联机模式", copy: "联机进度按房主账号单独保存。" },
  ];
  const ROLES = [
    { id: "fb", title: "火娃", copy: "Fireboy" },
    { id: "wg", title: "水娃", copy: "Watergirl" },
  ];

  const app = {
    auth: {
      token: localStorage.getItem("fb5_online_token") || "",
      user: null,
      progressSingle: null,
      progressOnlineHost: null,
    },
    mode: "single",
    ws: null,
    wsReady: false,
    wsAuthenticated: false,
    clientId: null,
    currentRoom: null,
    selectedRole: null,
    localInputState: { left: false, right: false, up: false },
    remoteInputState: { left: false, right: false, up: false },
    onlineInputSeq: 0,
    currentNonce: null,
    isHostRuntime: false,
    serverElapsedMs: 0,
    authoritativeElapsedMs: 0,
    levelOptions: [],
    dataLoaded: false,
    localProgressBackup: null,
    progressSaveOriginal: null,
    pendingWsAction: null,
    pendingStartRoom: null,
    pendingStartAttempts: 0,
    levelMenuReadyAt: 0,
    snapshotTimer: 0,
    remoteOutcomePending: null,
    syncMaps: {
      bodyToId: new Map(),
      idToBody: new Map(),
    },
    originals: {},
    confirmResolver: null,
  };

  function qs(id) {
    return document.getElementById(id);
  }

  const elements = {
    lobbyRoot: qs("lobby-root"),
    authPanel: qs("auth-panel"),
    mainPanel: qs("main-panel"),
    roomView: qs("room-view"),
    authStatus: qs("auth-status"),
    singleStatus: qs("single-status"),
    onlineStatus: qs("online-status"),
    usernameInput: qs("username-input"),
    passwordInput: qs("password-input"),
    registerBtn: qs("register-btn"),
    loginBtn: qs("login-btn"),
    logoutBtn: qs("logout-btn"),
    authUserText: qs("auth-user-text"),
    modeGrid: qs("mode-grid"),
    singlePanel: qs("single-panel"),
    onlinePanel: qs("online-panel"),
    singleStartBtn: qs("single-start-btn"),
    singleResetBtn: qs("single-reset-btn"),
    singleCompleteBtn: qs("single-complete-btn"),
    createRoomBtn: qs("create-room-btn"),
    joinRoomBtn: qs("join-room-btn"),
    copyRoomBtn: qs("copy-room-btn"),
    roomCodeInput: qs("room-code-input"),
    roomCodeText: qs("room-code-text"),
    roomStateText: qs("room-state-text"),
    roomRoleText: qs("room-role-text"),
    roomProgressText: qs("room-progress-text"),
    waitingHintText: qs("waiting-hint-text"),
    playerList: qs("player-list"),
    roleGrid: qs("role-grid"),
    startOnlineBtn: qs("start-online-btn"),
    reselectOnlineBtn: qs("reselect-online-btn"),
    retryOnlineBtn: qs("retry-online-btn"),
    resetOnlineBtn: qs("reset-online-btn"),
    completeOnlineBtn: qs("complete-online-btn"),
    leaveRoomBtn: qs("leave-room-btn"),
    floatingRoomBack: qs("floating-room-back"),
    confirmOverlay: qs("confirm-overlay"),
    confirmTitle: qs("confirm-title"),
    confirmMessage: qs("confirm-message"),
    confirmCancelBtn: qs("confirm-cancel-btn"),
    confirmOkBtn: qs("confirm-ok-btn"),
  };

  function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function clearPendingTempleSelection(game) {
    if (!game) {
      return;
    }
    game.__pendingTempleSelectionTemple = null;
  }

  function armLevelMenuDelayGuard() {
    app.levelMenuReadyAt = Date.now() + 1000;
  }

  function isLevelMenuDelayReady() {
    return Date.now() >= Number(app.levelMenuReadyAt || 0);
  }

  function armMenuDelayGuard() {
    app.menuReadyAt = Date.now() + 1000;
  }

  function isMenuDelayReady() {
    return Date.now() >= Number(app.menuReadyAt || 0);
  }

  function resetTransitionState(game) {
    if (!game?.state) {
      return;
    }
    game.paused = false;
    game.state.fading = false;
    if (game.state.overlay?.kill) {
      try {
        game.state.overlay.kill();
      } catch (error) {}
    }
    game.state.overlay = null;
  }

  function closeConfirmDialog(confirmed) {
    if (elements.confirmOverlay) {
      elements.confirmOverlay.classList.add("hidden");
      elements.confirmOverlay.setAttribute("aria-hidden", "true");
    }
    if (elements.confirmOkBtn) {
      elements.confirmOkBtn.classList.remove("btn-danger");
      elements.confirmOkBtn.classList.add("btn-primary");
      elements.confirmOkBtn.textContent = "确定";
    }
    const resolver = app.confirmResolver;
    app.confirmResolver = null;
    if (resolver) {
      resolver(!!confirmed);
    }
  }

  function resetOnlineSyncRuntime() {
    app.onlineInputSeq = 0;
    app.__inputHistory = [];
    app.__snapshotBuffer = [];
    app.__lastAckSeqs = { fb: 0, wg: 0 };
    app.__lastSyncState = new Map();
    app.authoritativeElapsedMs = 0;
  }

  function writeNonceToBytes(target, offset, nonce) {
    const value = String(nonce || "").padEnd(16, " ").slice(0, 16);
    for (let i = 0; i < 16; i += 1) {
      target[offset + i] = value.charCodeAt(i);
    }
  }

  function readNonceFromBytes(data, offset) {
    let nonce = "";
    for (let i = 0; i < 16; i += 1) {
      nonce += String.fromCharCode(data[offset + i]);
    }
    return nonce.trimEnd();
  }

  function isLocalPlayerBody(game, id) {
    return (id.startsWith("player-fb") && game.__onlineSelectedRole === "fb") ||
      (id.startsWith("player-wg") && game.__onlineSelectedRole === "wg");
  }

  function isRemotePlayerBody(game, id) {
    return (id.startsWith("player-fb") || id.startsWith("player-wg")) && !isLocalPlayerBody(game, id);
  }

  function resolveSnapshotState(snapshotA, snapshotB, playbackTime, id) {
    const stateA = snapshotA?.bodies?.get(id) || null;
    const stateB = snapshotB?.bodies?.get(id) || null;

    if (stateA && stateB && snapshotB.timestamp > snapshotA.timestamp) {
      const t = Math.max(0, Math.min(1, (playbackTime - snapshotA.timestamp) / (snapshotB.timestamp - snapshotA.timestamp)));
      return {
        x: stateA.x + (stateB.x - stateA.x) * t,
        y: stateA.y + (stateB.y - stateA.y) * t,
        angle: stateA.angle + (stateB.angle - stateA.angle) * t,
        vx: stateA.vx + (stateB.vx - stateA.vx) * t,
        vy: stateA.vy + (stateB.vy - stateA.vy) * t,
      };
    }

    if (stateA) {
      const aheadMs = Math.max(0, playbackTime - snapshotA.timestamp);
      const dt = Math.min(aheadMs / 1000, 0.12);
      return {
        x: stateA.x + stateA.vx * dt,
        y: stateA.y + stateA.vy * dt,
        angle: stateA.angle,
        vx: stateA.vx,
        vy: stateA.vy,
      };
    }

    return null;
  }

  function updateRemotePlaybackInputFromState(targetState) {
    if (!targetState) {
      return;
    }

    const nextLeft = targetState.vx > 0.6;
    const nextRight = targetState.vx < -0.6;
    const now = Date.now();

    if (targetState.vy > 3) {
      app.__remoteJumpUntil = now + 120;
    } else if (!app.__remoteJumpUntil) {
      app.__remoteJumpUntil = 0;
    }

    app.remoteInputState.left = nextLeft;
    app.remoteInputState.right = nextRight;
    app.remoteInputState.up = now < Number(app.__remoteJumpUntil || 0);
  }

  function accumulateRemoteCorrection(body, dx, dy) {
    if (!body) {
      return;
    }
    if (!body.__netCorrection) {
      body.__netCorrection = { x: 0, y: 0 };
    }
    body.__netCorrection.x += dx;
    body.__netCorrection.y += dy;
  }

  function applyRemoteCorrection(body) {
    const correction = body?.__netCorrection;
    if (!body || !correction) {
      return;
    }

    const dx = correction.x;
    const dy = correction.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < 0.000001) {
      correction.x = 0;
      correction.y = 0;
      return;
    }

    const factor = distSq > 9 ? 0.22 : distSq > 1 ? 0.14 : 0.08;
    const stepX = dx * factor;
    const stepY = dy * factor;
    const current = body.GetPosition();
    body.SetPositionXY(current.x + stepX, current.y + stepY);
    correction.x -= stepX;
    correction.y -= stepY;

    const angleCorrection = Number(body.__netAngleCorrection || 0);
    if (Math.abs(angleCorrection) >= 0.00001) {
      const angleStep = angleCorrection * (Math.abs(angleCorrection) > 0.2 ? 0.24 : 0.12);
      body.SetAngle(body.GetAngleRadians() + angleStep);
      body.__netAngleCorrection = angleCorrection - angleStep;
    } else {
      body.__netAngleCorrection = 0;
    }
  }

  function normaliseAngleDelta(value) {
    let delta = Number(value || 0);
    while (delta > Math.PI) {
      delta -= Math.PI * 2;
    }
    while (delta < -Math.PI) {
      delta += Math.PI * 2;
    }
    return delta;
  }

  function clearBodyCorrections(body) {
    if (!body) {
      return;
    }
    if (!body.__netCorrection) {
      body.__netCorrection = { x: 0, y: 0 };
    } else {
      body.__netCorrection.x = 0;
      body.__netCorrection.y = 0;
    }
    body.__netAngleCorrection = 0;
  }

  function queueSnapshotCorrection(game, body, id, targetState) {
    if (!body || !targetState) {
      return;
    }

    const current = body.GetPosition();
    const dx = targetState.x - current.x;
    const dy = targetState.y - current.y;
    const distSq = dx * dx + dy * dy;
    const isLocal = isLocalPlayerBody(game, id);
    const hardSnapSq = isLocal ? 4 : 2.25;
    const angleDelta = normaliseAngleDelta(targetState.angle - body.GetAngleRadians());
    const hardSnapAngle = isLocal ? 0.9 : 0.5;

    body.__syncTarget = targetState;

    if (targetState.isDying || distSq > hardSnapSq) {
      body.SetPositionXY(targetState.x, targetState.y);
      body.SetAngle(targetState.angle);
      if (body.SetLinearVelocity) {
        body.SetLinearVelocity(new box2d.b2Vec2(targetState.vx, targetState.vy));
      }
      if (body.SetAngularVelocity) {
        body.SetAngularVelocity(targetState.av || 0);
      }
      clearBodyCorrections(body);
      return;
    }

    accumulateRemoteCorrection(body, dx, dy);

    if (Math.abs(angleDelta) > hardSnapAngle) {
      body.SetAngle(targetState.angle);
      body.__netAngleCorrection = 0;
    } else {
      body.__netAngleCorrection = Number(body.__netAngleCorrection || 0) + angleDelta;
    }

    if (!isLocal) {
      body.SetLinearVelocity(new box2d.b2Vec2(targetState.vx, targetState.vy));
      if (body.SetAngularVelocity) {
        body.SetAngularVelocity(targetState.av || 0);
      }
    }
  }

  function confirmAction(title, message, options) {
    if (!elements.confirmOverlay || !elements.confirmTitle || !elements.confirmMessage) {
      return Promise.resolve(window.confirm(message || title || "确定继续吗？"));
    }
    if (app.confirmResolver) {
      closeConfirmDialog(false);
    }
    elements.confirmTitle.textContent = title || "继续执行？";
    elements.confirmMessage.textContent = message || "这个操作会立即生效。";
    if (elements.confirmOkBtn) {
      elements.confirmOkBtn.textContent = options?.confirmLabel || "确定";
      elements.confirmOkBtn.classList.toggle("btn-danger", options?.danger === true);
      elements.confirmOkBtn.classList.toggle("btn-primary", options?.danger !== true);
    }
    elements.confirmOverlay.classList.remove("hidden");
    elements.confirmOverlay.setAttribute("aria-hidden", "false");
    return new Promise(function (resolve) {
      app.confirmResolver = resolve;
    });
  }

  function queueOnlineLevelStart(room) {
    app.pendingStartRoom = cloneJson(room);
    app.pendingStartAttempts = 0;
    drainPendingOnlineLevelStart();
  }

  function drainPendingOnlineLevelStart() {
    const room = app.pendingStartRoom;
    if (!room) {
      return;
    }
    const game = getGame();
    if (!game) {
      setTimeout(drainPendingOnlineLevelStart, 80);
      return;
    }
    if (game.state?.fading) {
      app.pendingStartAttempts += 1;
      setTimeout(drainPendingOnlineLevelStart, 80);
      return;
    }
    app.pendingStartRoom = null;
    app.pendingStartAttempts = 0;
    hideLobby();
    startOnlineLevel(room);
  }

  function request(path, options) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options?.headers || {});
    if (app.auth.token) {
      headers.Authorization = `Bearer ${app.auth.token}`;
    }

    return fetch(path, Object.assign({}, options || {}, { headers, credentials: "same-origin" })).then(async function (response) {
      const payload = await response.json().catch(function () {
        return {};
      });
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message || "Request failed.");
      }
      return payload;
    });
  }

  function setStatus(target, message, variant) {
    if (!target) {
      return;
    }
    target.textContent = message || "";
    target.classList.remove("is-error", "is-success");
    if (variant === "error") {
      target.classList.add("is-error");
    } else if (variant === "success") {
      target.classList.add("is-success");
    }
  }

  function saveToken(token) {
    app.auth.token = token || "";
    if (token) {
      localStorage.setItem("fb5_online_token", token);
    } else {
      localStorage.removeItem("fb5_online_token");
    }
  }

  function setAuthenticated(authPayload) {
    saveToken(authPayload.token || app.auth.token);
    app.auth.user = authPayload.user || null;
    app.auth.progressSingle = authPayload.progressSingle || null;
    app.auth.progressOnlineHost = authPayload.progressOnlineHost || null;
    app.wsAuthenticated = false;
    if (app.wsReady && app.auth.token) {
      sendWs({ type: "authenticate", token: app.auth.token });
    }
    renderAuthState();
  }

  function clearAuth() {
    saveToken("");
    app.auth.user = null;
    app.auth.progressSingle = null;
    app.auth.progressOnlineHost = null;
    app.wsAuthenticated = false;
    app.pendingWsAction = null;
    renderAuthState();
  }

  function renderAuthState() {
    const loggedIn = !!app.auth.user;
    elements.authPanel.classList.toggle("hidden", loggedIn);
    elements.mainPanel.classList.toggle("hidden", !loggedIn);
    elements.roomView.classList.toggle("hidden", !app.currentRoom);
    elements.authUserText.textContent = loggedIn ? `当前账号：${app.auth.user.username}` : "未登录";
    if (elements.usernameInput) {
      elements.usernameInput.disabled = loggedIn;
    }
    if (elements.passwordInput) {
      elements.passwordInput.disabled = loggedIn;
      if (loggedIn) {
        elements.passwordInput.value = "";
      }
    }
    if (elements.registerBtn) {
      elements.registerBtn.disabled = loggedIn;
    }
    if (elements.loginBtn) {
      elements.loginBtn.disabled = loggedIn;
    }
  }

  function renderModeOptions() {
    elements.modeGrid.innerHTML = "";
    MODES.forEach(function (mode) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `choice-card is-clickable${app.mode === mode.id ? " is-active" : ""}`;
      card.innerHTML = `<h3 class="choice-title">${mode.title}</h3><p class="choice-copy">${mode.copy}</p>`;
      card.addEventListener("click", function () {
        app.mode = mode.id;
        renderModeOptions();
        renderModePanels();
      });
      elements.modeGrid.appendChild(card);
    });
  }

  function renderModePanels() {
    elements.singlePanel.classList.toggle("hidden", app.mode !== "single");
    elements.onlinePanel.classList.toggle("hidden", app.mode !== "online" || !!app.currentRoom);
    elements.roomView.classList.toggle("hidden", !app.currentRoom);
  }

  function renderPlayerList() {
    elements.playerList.innerHTML = "";
    const players = app.currentRoom?.players || [];
    players.forEach(function (player) {
      const item = document.createElement("div");
      item.className = "player-chip";
      item.innerHTML = `
        <div>
          <div class="player-name">${player.username}</div>
          <div class="player-meta">${player.id === app.currentRoom.hostId ? "房主" : "玩家"}</div>
        </div>
        <div class="player-meta">${player.role === "fb" ? "火娃" : player.role === "wg" ? "水娃" : "未选角色"}</div>
      `;
      elements.playerList.appendChild(item);
    });
  }

  function renderRoleGrid() {
    elements.roleGrid.innerHTML = "";
    const players = app.currentRoom?.players || [];
    const me = players.find(function (player) {
      return player.id === app.clientId;
    });

    ROLES.forEach(function (role) {
      const occupied = players.find(function (player) {
        return player.role === role.id && player.id !== app.clientId;
      });
      const selected = me?.role === role.id;
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = !!occupied;
      button.className = `role-card ${occupied ? "is-disabled" : "is-clickable"}${selected ? " is-active" : ""}`;
      button.innerHTML = `<h3 class="role-title">${role.title}</h3><p class="role-copy">${occupied ? `已被 ${occupied.username} 选择` : role.copy}</p>`;
      button.addEventListener("click", function () {
        sendWs({ type: "select_role", role: selected ? null : role.id });
      });
      elements.roleGrid.appendChild(button);
    });
  }

  function renderRoomState() {
    if (!app.currentRoom) {
      elements.roomCodeText.textContent = "------";
      elements.roomStateText.textContent = "未进入房间";
      elements.roomRoleText.textContent = "";
      elements.roomProgressText.textContent = app.auth.progressOnlineHost ? "已读取联机房主进度" : "暂无联机房主进度";
      elements.waitingHintText.textContent = "创建或加入房间后进入等待界面。";
      renderPlayerList();
      renderRoleGrid();
      renderModePanels();
      return;
    }

    const room = app.currentRoom;
    const me = room.players.find(function (player) {
      return player.id === app.clientId;
    });
    const isHost = room.hostId === app.clientId;
    const roles = room.players.map(function (player) {
      return player.role;
    });
    const readyToStart =
      room.players.length === 2 &&
      roles.includes("fb") &&
      roles.includes("wg") &&
      room.selectedTempleId &&
      room.selectedLevelId;

    elements.roomCodeText.textContent = room.code;
    elements.roomStateText.textContent = ROOM_STATE_LABELS[room.game?.status] || "等待中";
    elements.roomRoleText.textContent = isHost ? "你是房主" : "等待房主操作";
    elements.roomProgressText.textContent = app.auth.progressOnlineHost ? "已读取联机房主进度" : "暂无联机房主进度";
    elements.waitingHintText.textContent = room.players.length < 2
      ? "等待另一位玩家加入。"
      : room.selectedTempleId
        ? "双方选角后由房主开始关卡。"
        : "房主先进入原版选关流程。";

    elements.startOnlineBtn.textContent = room.selectedTempleId ? "开始联机关卡" : "进入原版选关";
    elements.startOnlineBtn.disabled = !isHost || (!!room.selectedTempleId && !readyToStart);
    if (elements.reselectOnlineBtn) {
      elements.reselectOnlineBtn.disabled = !isHost || !room.selectedTempleId;
    }
    
    // Hide the retry button in the room as requested
    if (elements.retryOnlineBtn) {
      elements.retryOnlineBtn.style.display = "none";
    }
    
    elements.resetOnlineBtn.disabled = !isHost;
    elements.completeOnlineBtn.disabled = !isHost;
    app.selectedRole = me?.role || null;

    renderPlayerList();
    renderRoleGrid();
    renderModePanels();
  }

  function sendWs(payload) {
    if (!app.wsReady || !app.ws) {
      setStatus(elements.onlineStatus, "房间连接尚未建立。", "error");
      return;
    }
    if (payload instanceof ArrayBuffer) {
      app.ws.send(payload);
    } else {
      app.ws.send(JSON.stringify(payload));
    }
  }

  function runAfterWsAuth(action) {
    if (!app.auth.user || !app.auth.token) {
      setStatus(elements.onlineStatus, "请先登录账号。", "error");
      return;
    }
    if (!app.wsReady || !app.ws) {
      setStatus(elements.onlineStatus, "房间连接尚未建立。", "error");
      return;
    }
    if (app.wsAuthenticated) {
      action();
      return;
    }
    app.pendingWsAction = action;
    sendWs({ type: "authenticate", token: app.auth.token });
    setStatus(elements.onlineStatus, "正在认证房间连接...", "success");
  }

  function connectWs() {
    if (app.ws) {
      return;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    app.ws = new WebSocket(`${protocol}//${location.host}/ws`);
    app.ws.binaryType = "arraybuffer";

    app.ws.addEventListener("open", function () {
      app.wsReady = true;
      app.wsAuthenticated = false;
      if (app.auth.token) {
        sendWs({ type: "authenticate", token: app.auth.token });
      }
      setStatus(elements.onlineStatus, "已连接到房间服务器。", "success");
    });

    app.ws.addEventListener("close", function () {
      app.wsReady = false;
      app.wsAuthenticated = false;
      app.pendingWsAction = null;
      app.currentRoom = null;
      renderRoomState();
      setStatus(elements.onlineStatus, "房间连接已断开。", "error");
    });

    app.ws.addEventListener("message", function (event) {
      if (event.data instanceof ArrayBuffer) {
        handleBinaryMessage(new Uint8Array(event.data));
        return;
      }
      if (ArrayBuffer.isView(event.data)) {
        handleBinaryMessage(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        return;
      }
      if (event.data instanceof Blob) {
        const reader = new FileReader();
        reader.onload = function () {
          handleBinaryMessage(new Uint8Array(reader.result));
        };
        reader.readAsArrayBuffer(event.data);
        return;
      }
      const message = JSON.parse(event.data);
      handleWsMessage(message);
    });
  }

  function handleBinaryMessage(data) {
    const type = data[0];
    if (type === 0x01) { // Snapshot
      decodeBinarySnapshot(data);
    } else if (type === 0x02) { // Input
      decodeBinaryInput(data);
    }
  }

  function decodeBinaryInput(data) {
    return;
  }

  function decodeBinarySnapshot(data) {
    return;
  }

  function handleWsMessage(message) {
    switch (message.type) {
      case "welcome":
        app.clientId = message.clientId;
        break;
      case "authenticated":
        app.wsAuthenticated = true;
        setStatus(elements.onlineStatus, "房间认证完成。", "success");
        if (app.pendingWsAction) {
          const action = app.pendingWsAction;
          app.pendingWsAction = null;
          action();
        }
        break;
      case "room_state":
        app.currentRoom = message.room;
        if (message.room) {
          app.auth.progressOnlineHost = cloneJson(message.room.progressOnlineHost);
        }
        renderRoomState();
        break;
      case "start_level":
        app.currentRoom = message.room;
        if (message.room) {
          app.auth.progressOnlineHost = cloneJson(message.room.progressOnlineHost);
        }
        renderRoomState();
        {
          const game = getGame();
          if (game?.state?.current === "endGame" && game.state.states?.endGame?.shutdown) {
            try {
              game.state.states.endGame.shutdown();
            } catch (error) {}
          }
        }
        queueOnlineLevelStart(message.room);
        break;
      case "game_retry": {
        const game = getGame();
        if (game && app.currentRoom) {
          app.currentNonce = message.nonce;
          startOnlineLevel(app.currentRoom);
        }
        break;
      }
      case "return_to_room":
        if (app.currentRoom?.hostId !== app.clientId) {
          prepareGuestForRemoteRoomReturn();
        } else {
          showLobby();
          forceBackToRoom();
        }
        break;
      case "player_input":
        if (message.nonce === app.currentNonce) {
          app.remoteInputState.left = !!message.state?.left;
          app.remoteInputState.right = !!message.state?.right;
          app.remoteInputState.up = !!message.state?.up;
        }
        break;
      case "level_snapshot":
        applySnapshot(message);
        break;
      case "level_complete":
        handleRemoteComplete(message);
        break;
      case "online_finish_animation":
        handleRemoteFinishAnimation(message);
        break;
      case "level_failed":
        handleRemoteFail(message);
        break;
      case "error":
        setStatus(elements.onlineStatus, message.message, "error");
        break;
      default:
        break;
    }
  }

  function loadTempleData() {
    const templePaths = [
      "elements/forest",
      "elements/fire",
      "elements/ice",
      "elements/water",
      "elements/crystal",
      "elements/light",
      "elements/wind",
    ];

    return Promise.all(
      templePaths.map(function (templePath) {
        return fetch(`data/${templePath}/temple.json`, { cache: "no-store" }).then(function (response) {
          return response.json();
        });
      }),
    ).then(function (temples) {
      app.levelOptions = temples
        .sort(function (left, right) {
          return (left.index || 0) - (right.index || 0);
        })
        .flatMap(function (temple) {
          return temple.levels.map(function (level) {
            return {
              templeId: temple.id,
              levelId: String(level.id),
              templeData: cloneJson(temple),
              levelData: cloneJson(level),
            };
          });
        });
      app.dataLoaded = true;
    });
  }

  function backupLocalProgress(game) {
    if (!game?.progress) {
      return;
    }
    if (!app.localProgressBackup) {
      app.localProgressBackup = cloneJson(game.progress.toJSON());
    }
    if (!app.progressSaveOriginal) {
      app.progressSaveOriginal = game.progress.save.bind(game.progress);
    }
  }

  function setProgressSaveSuppressed(game, suppressed) {
    if (!game?.progress) {
      return;
    }
    if (!app.progressSaveOriginal) {
      app.progressSaveOriginal = game.progress.save.bind(game.progress);
    }
    game.progress.save = suppressed ? function () { return null; } : app.progressSaveOriginal;
  }

  function applyAccountProgressToGame(game) {
    if (!game?.progress) {
      return;
    }

    backupLocalProgress(game);
    
    // Explicitly determine if we should use online host progress
    // This is true if we are in an active online match OR if the host is picking levels
    const useOnline = !!(game.__onlineMode || game.__onlinePickingLevel);
    const stored = useOnline ? app.auth.progressOnlineHost : app.auth.progressSingle;

    setProgressSaveSuppressed(game, true);
    if (stored) {
      game.progress.set(convertStoredProgressToGameProgress(game, stored));
    } else if (typeof game.progress.erase === "function") {
      game.progress.erase();
    }
    game.progress.process();
    game.progress.firstComplete = false;
    game.progress.firstTotalComplete = false;
  }

  function convertStoredProgressToGameProgress(game, stored) {
    const base = cloneJson(game.progress.toJSON());
    if (!stored) {
      return base;
    }

    const completed = new Set(Array.isArray(stored.completedLevels) ? stored.completedLevels : []);
    const storedTemples = Array.isArray(stored.temples) ? stored.temples : [];

    if (Array.isArray(base.temples)) {
      base.temples.forEach(function (temple) {
        const sTemple = storedTemples.find(t => t.id === temple.id);
        let completedCount = 0;
        (temple.levels || []).forEach(function (level) {
          const key = `${temple.id}:${level.id}`;
          if (completed.has(key)) {
            level.best = { stars: 3, diamonds: 3, time: 1, silverDiamond: 1 };
            level.played = true;
            level.state = 4;
          } else if (sTemple) {
            const sLevel = Array.isArray(sTemple.levels) ? sTemple.levels.find(l => String(l.id) === String(level.id)) : null;
            if (sLevel && (sLevel.best || sLevel.played)) {
              level.best = cloneJson(sLevel.best);
              level.played = !!sLevel.played;
              level.state = sLevel.state || 2;
            } else {
              delete level.best;
              level.played = false;
              level.state = 0;
            }
          } else {
            delete level.best;
            level.played = false;
            level.state = 0;
          }
          if (level.best) {
            completedCount += 1;
          }
        });
        temple.completedCount = completedCount;
      });
    }

    if (stored.gameComplete !== undefined) base.gameComplete = !!stored.gameComplete;
    if (stored.gameTotalComplete !== undefined) base.gameTotalComplete = !!stored.gameTotalComplete;

    return base;
  }

  function convertGameProgressToStoredProgress(progressJson) {
    const completedLevels = [];
    const temples = cloneJson(progressJson?.temples || []);
    temples.forEach(function (temple) {
      (temple.levels || []).forEach(function (level) {
        if (level?.best) {
          completedLevels.push(`${temple.id}:${level.id}`);
        }
      });
    });
    return {
      completedLevels,
      temples,
      gameComplete: !!progressJson?.gameComplete,
      gameTotalComplete: !!progressJson?.gameTotalComplete,
      updatedAt: new Date().toISOString(),
    };
  }

  function restoreLocalProgress(game) {
    if (!game?.progress || !app.localProgressBackup) {
      return;
    }
    game.progress.set(cloneJson(app.localProgressBackup));
    setProgressSaveSuppressed(game, false);
    game.progress.process();
    app.localProgressBackup = null;
  }

  function refreshCurrentGameProgress(mode) {
    const game = getGame();
    if (!game?.progress) {
      return;
    }

    if (mode === "single") {
      if (game.__onlineMode || game.__onlinePickingLevel) {
        return;
      }
    } else if (mode === "online_host") {
      if (!game.__onlineMode && !game.__onlinePickingLevel) {
        return;
      }
    }

    applyAccountProgressToGame(game);
  }

  function createCursorProxy(state, active) {
    const proxy = {
      left: {},
      right: {},
      up: {},
      show: function () {},
      hide: function () {},
      layoutContent: function () {},
      destroy: function () {},
    };

    Object.defineProperty(proxy.left, "isDown", { get: function () { return !!state.left; } });
    Object.defineProperty(proxy.right, "isDown", { get: function () { return !!state.right; } });
    Object.defineProperty(proxy.up, "isDown", { get: function () { return !!state.up; } });
    Object.defineProperty(proxy, "active", {
      get: function () {
        return active && (!!state.left || !!state.right || !!state.up);
      },
      set: function () {},
    });

    return proxy;
  }

  function installKeyboardSync() {
    window.addEventListener("keydown", function (event) {
      if (!app.currentNonce || !getGame()?.__onlineMode) {
        return;
      }
      if (event.code === "KeyA") {
        app.localInputState.left = true;
      } else if (event.code === "KeyD") {
        app.localInputState.right = true;
      } else if (event.code === "KeyW") {
        app.localInputState.up = true;
      } else {
        return;
      }
      emitInput();
    });

    window.addEventListener("keyup", function (event) {
      if (!app.currentNonce || !getGame()?.__onlineMode) {
        return;
      }
      if (event.code === "KeyA") {
        app.localInputState.left = false;
      } else if (event.code === "KeyD") {
        app.localInputState.right = false;
      } else if (event.code === "KeyW") {
        app.localInputState.up = false;
      } else {
        return;
      }
      emitInput();
    });

  }

  function emitInput() {
    if (!app.currentNonce) {
      return;
    }
    app.onlineInputSeq += 1;
    sendWs({
      type: "input",
      nonce: app.currentNonce,
      seq: app.onlineInputSeq,
      state: app.localInputState,
    });
  }

  function findLevelOption(templeId, levelId) {
    return app.levelOptions.find(function (option) {
      return option.templeId === templeId && String(option.levelId) === String(levelId);
    });
  }

  function beginOriginalPicker() {
    const game = getGame();
    if (!game || !app.currentRoom) {
      return;
    }
    // Set flags BEFORE applying progress
    game.__onlineMode = false;
    game.__onlinePickingLevel = true;
    game.__singlePlayerLobbyMode = false;
    armMenuDelayGuard();
    armLevelMenuDelayGuard();
    clearPendingTempleSelection(game);
    applyAccountProgressToGame(game);
    
    game.currentTemple = null;
    hideLobby();
    game.state.fade("menu", true, false);
  }

  function startSingleMode() {
    const game = getGame();
    if (!game) {
      setStatus(elements.singleStatus, "游戏仍在加载中。", "error");
      return;
    }
    // Set flags BEFORE applying progress
    game.__onlineMode = false;
    game.__onlinePickingLevel = false;
    game.__singlePlayerLobbyMode = true;
    armMenuDelayGuard();
    
    restoreLocalProgress(game);
    applyAccountProgressToGame(game);
    
    game.settings.controls = "keyboard";
    if (typeof game.saveSettings === "function") {
      game.saveSettings();
    }
    if (game.settingsSignal) {
      game.settingsSignal.dispatch("controls");
    }
    hideLobby();
    game.state.fade("menu", true, false);
  }

  function returnToSingleLobby() {
    const game = getGame();
    if (!game) {
      return;
    }
    if (game.progress) {
      app.auth.progressSingle = cloneJson(game.progress.toJSON());
    }
    game.__onlineMode = false;
    game.__onlinePickingLevel = false;
    game.__singlePlayerLobbyMode = true;
    app.currentNonce = null;
    app.serverElapsedMs = 0;
    app.localInputState = { left: false, right: false, up: false };
    app.remoteInputState = { left: false, right: false, up: false };
    app.remoteOutcomePending = null;
    restoreLocalProgress(game);
    showLobby();
  }

  function openCurrentTempleLevelMenuForHost() {
    const game = getGame();
    if (!game || !game.currentTemple) {
      return;
    }
    game.__onlineMode = false;
    game.__onlinePickingLevel = true;
    game.__onlineLevelSelectReady = false;
    game.__singlePlayerLobbyMode = false;
    armMenuDelayGuard();
    app.currentNonce = null;
    app.serverElapsedMs = 0;
    app.localInputState = { left: false, right: false, up: false };
    app.remoteInputState = { left: false, right: false, up: false };
    app.remoteOutcomePending = null;
    setProgressSaveSuppressed(game, true);
    applyAccountProgressToGame(game);
    hideLobby();
    const progressTemple = game.progress?.get?.("temples")?.find?.(function (temple) {
      return temple.id === game.currentTemple.id;
    });
    game.__pendingTempleSelectionTemple = cloneJson(progressTemple || game.currentTemple);
    game.state.fade("menu", true, false);
  }

  function startOnlineLevel(room) {
    const game = getGame();
    if (!game) {
      return;
    }

    const previousLevel = game.level || null;

    if (game.state?.current === "endGame" && game.state?.states?.endGame?.shutdown) {
      try {
        game.state.states.endGame.shutdown();
      } catch (error) {}
    }
    clearPendingTempleSelection(game);
    game.paused = false;

    const option = findLevelOption(room.selectedTempleId, room.selectedLevelId);
    if (!option) {
      setStatus(elements.onlineStatus, "未找到所选关卡数据。", "error");
      showLobby();
      return;
    }

    resetOnlineSyncRuntime();
    app.currentNonce = room.game?.nonce || null;
    app.serverElapsedMs = Number(room.elapsedMs || 0);
    app.authoritativeElapsedMs = app.serverElapsedMs;
    app.selectedRole = room.players.find(function (player) {
      return player.id === app.clientId;
    })?.role || null;
    app.isHostRuntime = room.hostId === app.clientId;
    app.localInputState = { left: false, right: false, up: false };
    app.remoteInputState = { left: false, right: false, up: false };
    app.remoteOutcomePending = null;
    app.snapshotTimer = 0;

    backupLocalProgress(game);
    setProgressSaveSuppressed(game, true);
    
    // Set flags BEFORE applying progress
    game.__onlineMode = true;
    game.__onlinePickingLevel = false;
    game.__singlePlayerLobbyMode = false;
    game.__onlineSelectedRole = app.selectedRole;
    game.__onlineNonce = app.currentNonce;
    game.currentTemple = cloneJson(option.templeData);
    
    game.settings.controls = "keyboard";
    if (typeof game.saveSettings === "function") {
      game.saveSettings();
    }
    if (game.settingsSignal) {
      game.settingsSignal.dispatch("controls");
    }

    applyAccountProgressToGame(game);

    // Always replace the level state with a fresh instance.
    // The original game does this on retry; otherwise flags like `ended`
    // can leak across online restarts and freeze the next run immediately.
    game.state.add("level", game.require("States/Level/Level"));
    game.state.fade("level", true, false, cloneJson(option.levelData));
    if (previousLevel) {
      teardownCurrentOnlineLevel(game, previousLevel);
    }
  }

  function teardownCurrentOnlineLevel(game, levelOverride) {
    const level = levelOverride || game?.level;
    if (!game || !level) {
      return;
    }
    if (level.__networkLobbyTornDown) {
      if (game.level === level) {
        game.level = null;
      }
      return;
    }
    try {
      level.__networkLobbyTornDown = true;
      level.ended = true;
      if (level.camManager) {
        level.camManager.update = function () {};
        level.camManager.updateCamera = function () {};
      }
      if (level.ui?.clock) {
        level.ui.clock.stopped = true;
      }
      if (game.physics?.box2d) {
        game.physics.box2d.paused = true;
      }
      if (typeof level.killAll === "function") {
        const originalKillAll = level.killAll;
        level.killAll = function () {};
        originalKillAll.call(level);
      }
      game.paused = false;
      if (game.level === level) {
        game.level = null;
      }
    } catch (error) {}
  }

  function stopResidualLevelAudio(game) {
    if (game?.sound?.stopAll) {
      try {
        game.sound.stopAll();
      } catch (error) {}
    }
    const level = game?.level;
    if (level?.sounds) {
      Object.keys(level.sounds).forEach(function (soundKey) {
        const sound = level.sounds[soundKey];
        if (sound?.stop) {
          try {
            sound.stop();
          } catch (error) {}
        }
      });
    }
    const levelState = game?.state?.states?.level;
    if (levelState?.sounds) {
      Object.keys(levelState.sounds).forEach(function (soundKey) {
        const sound = levelState.sounds[soundKey];
        if (sound?.stop) {
          try {
            sound.stop();
          } catch (error) {}
        }
      });
    }
  }

  function forceBackToRoom() {
    const game = getGame();
    if (!game) {
      return;
    }
    const previousLevel = game.level || null;
    if (previousLevel) {
      teardownCurrentOnlineLevel(game, previousLevel);
    }
    game.__onlineMode = false;
    game.__onlinePickingLevel = false;
    game.__singlePlayerLobbyMode = false;
    clearPendingTempleSelection(game);
    app.currentNonce = null;
    app.serverElapsedMs = 0;
    app.localInputState = { left: false, right: false, up: false };
    app.remoteInputState = { left: false, right: false, up: false };
    app.remoteOutcomePending = null;
    stopResidualLevelAudio(game);
    restoreLocalProgress(game);
    showLobby();
    
    const current = game.state.current;
    if (current === "level" || current === "endGame" || current === "levelMenu" || current === "menu") {
      game.state.fade("menu", true, false);
    } else {
      showLobby();
    }
  }

  function prepareGuestForRemoteRoomReturn() {
    const game = getGame();
    if (!game) {
      return;
    }
    const previousLevel = game.level || null;
    if (previousLevel) {
      teardownCurrentOnlineLevel(game, previousLevel);
    }
    game.__onlineMode = false;
    game.__onlinePickingLevel = false;
    game.__singlePlayerLobbyMode = false;
    clearPendingTempleSelection(game);
    app.currentNonce = null;
    app.serverElapsedMs = 0;
    app.localInputState = { left: false, right: false, up: false };
    app.remoteInputState = { left: false, right: false, up: false };
    app.remoteOutcomePending = null;
    stopResidualLevelAudio(game);
    restoreLocalProgress(game);
    resetTransitionState(game);
    game.paused = false;
    if (game.state?.current !== "menu") {
      game.state.start("menu", true, false);
    }
    showLobby();
  }

  function queueRemoteOutcome(success, payload) {
    app.remoteOutcomePending = {
      success: !!success,
      payload: payload || null,
    };

    const game = getGame();
    if (!game?.__onlineMode) {
      return;
    }

    if (game.state.current === "endGame") {
      consumeRemoteOutcome(game);
      return;
    }

    if (game.level && !game.level.ended) {
      game.level.ended = true;
      if (game.level.ui?.clock) {
        game.level.ui.clock.stop();
      }
      game.physics.box2d.paused = true;
      game.state.add("endGame", game.require("States/End"));
      game.state.start("endGame", false, false, {
        success: !!success,
        data: payload?.data || game.level.levelData || {},
        state: payload?.state || game.level.levelState || {},
      });
    }
  }

  function consumeRemoteOutcome(game) {
    if (!app.remoteOutcomePending) {
      return;
    }
    const pending = app.remoteOutcomePending;
    const endState = game?.state?.states?.endGame;
    if (!endState) {
      return;
    }
    endState.levelState = {
      success: pending.success,
      data: pending.payload?.data || endState.levelState?.data || {},
      state: pending.payload?.state || endState.levelState?.state || {},
    };
    app.remoteOutcomePending = null;
  }

  function setButtonLabel(button, text) {
    if (!button || !text || !button.label) {
      return;
    }
    button.label.text = text;
    if (button.label.anchor && typeof button.label.anchor.set === "function") {
      button.label.anchor.set(0.5);
    }
    button.label.x = 0;
    button.label.y = -button.label.textHeight / 2;
    if (button.sprite && button.label.textWidth > 0.65 * button.sprite.width) {
      button.sprite.width = button.label.textWidth / 0.65;
    }
  }

  function getMenuButtons(menu) {
    if (!menu?.board?.children) {
      return [];
    }
    return menu.board.children.filter(function (child) {
      return !!child?.label;
    });
  }

  function attachWaitingNotice(menu, text) {
    if (!menu || !text || menu.__waitingNotice) {
      return;
    }
    const notice = menu.game.make.bitmapText(0, 0, "font", text, 18);
    notice.anchor.set(0.5);
    menu.board.addChild(notice);
    menu.__waitingNotice = notice;
    const originalLayout = menu.layoutContent ? menu.layoutContent.bind(menu) : null;
    menu.layoutContent = function () {
      if (originalLayout) {
        originalLayout();
      }
      if (this.__waitingNotice) {
        this.__waitingNotice.x = 0;
        this.__waitingNotice.y = this.contentSize.halfHeight - 215;
      }
    };
    menu.layoutContent();
  }

  function saveOnlineProgress(game) {
    if (!game?.progress || !game.__onlineMode) {
      return Promise.resolve();
    }
    const progress = convertGameProgressToStoredProgress(game.progress.toJSON());
    app.auth.progressOnlineHost = progress;
    return request("/api/progress/save", {
      method: "POST",
      body: JSON.stringify({ mode: "online_host", progress }),
    }).catch(function (error) {
      setStatus(elements.onlineStatus, "联机进度保存失败：" + error.message, "error");
    });
  }

  function saveSingleProgress(game) {
    if (!game?.progress || !game.__singlePlayerLobbyMode) {
      return Promise.resolve();
    }
    const progress = convertGameProgressToStoredProgress(game.progress.toJSON());
    app.auth.progressSingle = progress;
    return request("/api/progress/save", {
      method: "POST",
      body: JSON.stringify({ mode: "single", progress }),
    }).catch(function (error) {
      setStatus(elements.singleStatus, "单机进度保存失败：" + error.message, "error");
    });
  }

  function markCurrentOnlineLevelComplete(game) {
    if (!game?.progress || !app.currentRoom?.selectedTempleId || app.currentRoom?.selectedLevelId == null) {
      return;
    }
    const progressJson = cloneJson(game.progress.toJSON());
    const temple = (progressJson.temples || []).find(function (entry) {
      return entry.id === app.currentRoom.selectedTempleId;
    });
    if (!temple) {
      return;
    }
    const level = (temple.levels || []).find(function (entry) {
      return String(entry.id) === String(app.currentRoom.selectedLevelId);
    });
    if (!level) {
      return;
    }
    level.best = { stars: 3, diamonds: 3, time: 1, silverDiamond: 1 };
    level.played = true;
    level.state = 4;
    game.progress.set(progressJson);
    game.progress.process();
  }

  function startSelectedOnlineLevel() {
    if (!app.currentRoom?.selectedTempleId || !app.currentRoom?.selectedLevelId) {
      setStatus(elements.onlineStatus, "请先选择关卡。", "error");
      return;
    }
    sendWs({ type: "start_level" });
  }

  function resolveLevelSelection(button, templeData) {
    const templeId = templeData?.id || null;
    const optionTempleLevels = app.levelOptions.filter(function (option) {
      return option.templeId === templeId;
    });
    const rawData = button?.data || null;

    const directId = rawData?.id;
    if (directId != null && directId !== "" && directId !== "undefined") {
      return {
        templeId,
        levelId: String(directId),
      };
    }

    const filename = rawData?.filename || button?.filename || null;
    if (filename) {
      const byFilename = optionTempleLevels.find(function (option) {
        return String(option.levelData?.filename || "") === String(filename);
      });
      if (byFilename) {
        return {
          templeId,
          levelId: String(byFilename.levelId),
        };
      }
    }

    const buttonIndex = templeData?.levels?.indexOf?.(rawData);
    if (buttonIndex >= 0 && templeData?.levels?.[buttonIndex]) {
      return {
        templeId,
        levelId: String(templeData.levels[buttonIndex].id),
      };
    }

    return null;
  }

  function handleOnlineContinue() {
    const game = getGame();
    if (!game?.__onlineMode) {
      return;
    }
    if (app.currentRoom?.hostId !== app.clientId) {
      setStatus(elements.onlineStatus, "等待房主操作。", "success");
      return;
    }
    sendWs({ type: "continue_levels" });
  }

  function returnToRoomFromPicker() {
    const game = getGame();
    if (!game) {
      return;
    }
    game.__onlinePickingLevel = false;
    game.__onlineMode = false;
    game.__singlePlayerLobbyMode = false;
    clearPendingTempleSelection(game);
    app.currentNonce = null;
    restoreLocalProgress(game);
    sendWs({ type: "return_to_room" });
    showLobby();
    game.state.fade("menu", true, false);
  }

  function handleRemoteComplete(message) {
    queueRemoteOutcome(true, message.payload);
  }

  function handleRemoteFinishAnimation(message) {
    const game = getGame();
    const level = game?.level;
    if (!game || !level || !game.__onlineMode || message.nonce !== app.currentNonce) {
      return;
    }
    if (app.isHostRuntime || level.ended) {
      return;
    }
    level.ended = true;
    game.physics.box2d.paused = true;
    level.animateFinish();
  }

  function handleRemoteFail(message) {
    queueRemoteOutcome(false, message.payload);
  }

  function assignBodyIds(level) {
    app.syncMaps.bodyToId = new Map();
    app.syncMaps.idToBody = new Map();
    let nextId = 1;

    function registerBody(body, prefix) {
      if (!body || app.syncMaps.bodyToId.has(body)) {
        return;
      }
      const id = `${prefix}:${nextId++}`;
      app.syncMaps.bodyToId.set(body, id);
      app.syncMaps.idToBody.set(id, body);
    }

    registerBody(level.pers1?.body?.data, "player-fb");
    registerBody(level.pers2?.body?.data, "player-wg");
    (level.objects || []).forEach(function (object, index) {
      registerBody(object?.body?.data, object?.options?.type || `device-${index}`);
    });
  }

  function sendSnapshot(level) {
    if (!level || level.ended || !level.game || level.game.level !== level || !level.ui?.clock || !level.loadCompleted) {
      return;
    }

    const bodies = [];
    app.syncMaps.idToBody.forEach(function (body, id) {
      const position = body.GetPosition();
      const velocity = body.GetLinearVelocity();
      bodies.push({
        id,
        x: position.x,
        y: position.y,
        angle: body.GetAngleRadians(),
        vx: velocity.x,
        vy: velocity.y,
        av: body.GetAngularVelocity ? body.GetAngularVelocity() : 0,
      });
    });

    const players = {
      fb: level.pers1
        ? {
            dying: !!level.pers1.dying,
            dead: !!level.pers1.dead,
            isDead: !!level.pers1.isDead,
            visible: level.pers1.sprite ? level.pers1.sprite.visible !== false : true,
          }
        : null,
      wg: level.pers2
        ? {
            dying: !!level.pers2.dying,
            dead: !!level.pers2.dead,
            isDead: !!level.pers2.isDead,
            visible: level.pers2.sprite ? level.pers2.sprite.visible !== false : true,
          }
        : null,
    };

    sendWs({
      type: "snapshot",
      nonce: app.currentNonce,
      elapsedMs: Math.max(0, Math.round(app.serverElapsedMs || 0)),
      bodies,
      players,
    });
  }

  function applySnapshot(message) {
    const game = getGame();
    const level = game?.level;
    if (!game || !level || !game.__onlineMode || message.nonce !== app.currentNonce) {
      return;
    }
    if (message.elapsedMs != null) {
      app.serverElapsedMs = Number(message.elapsedMs || 0);
    }
    if (app.isHostRuntime) {
      return;
    }

    if (message.players) {
      const roleMap = {
        fb: level.pers1 || null,
        wg: level.pers2 || null,
      };

      Object.keys(roleMap).forEach(function (role) {
        const character = roleMap[role];
        const state = message.players[role];
        if (!character || !state) {
          return;
        }
        if (state.dying && !character.dying && app.originals.originalCharacterKill) {
          app.originals.originalCharacterKill.call(character);
        }
        character.dying = !!state.dying;
        character.dead = !!state.dead;
        character.isDead = !!state.isDead;
        if (character.sprite) {
          character.sprite.visible = state.visible !== false;
        }
      });

      const localRole = game.__onlineSelectedRole;
      const localCharacter = localRole === "fb" ? level.pers1 : localRole === "wg" ? level.pers2 : null;
      if (!level.ended && localCharacter?.isDead) {
        level.ended = true;
        if (level.ui?.clock) {
          level.ui.clock.stop();
        }
        game.physics.box2d.paused = true;
        game.state.add("endGame", game.require("States/End"));
        game.state.start("endGame", false, false, {
          success: false,
          data: level.levelData,
          state: level.levelState,
        });
        return;
      }
    }

    (message.bodies || []).forEach(function (bodyState) {
      const body = app.syncMaps.idToBody.get(bodyState.id);
      if (!body) {
        return;
      }
      queueSnapshotCorrection(game, body, bodyState.id, {
        x: bodyState.x,
        y: bodyState.y,
        vx: bodyState.vx,
        vy: bodyState.vy,
        angle: bodyState.angle,
        av: bodyState.av || 0,
        isDying: (bodyState.id === "player-fb" ? !!message.players?.fb?.dying :
          bodyState.id === "player-wg" ? !!message.players?.wg?.dying : false),
      });
    });
  }

  function patchGame(game) {
    if (game.__networkLobbyPatched) {
      return;
    }

    game.require = function (moduleName) {
      return window.require(moduleName);
    };

    const UIStateClass = game.require("States/Common/UIState");
    const ButtonClass = game.require("States/Common/Button");
    const LevelClass = game.require("States/Level/Level");
    const MenuClass = game.require("States/Menu/Menu");
    const SingleMenuClass = game.require("States/Menu/SingleMenu");
    const MultiMenuClass = game.require("States/Menu/MultiMenu");
    const LevelMenuClass = game.require("States/LevelMenu/LevelMenu");
    const EndState = game.require("States/End");
    const EndMenu = game.require("States/Level/EndMenu");
    const GameOverMenu = game.require("States/Level/GameOverMenu");
    const PauseMenuClass = game.require("States/Level/PauseMenu");
    const LevelUIClass = game.require("States/Level/LevelUI");
    const ClockClass = game.require("States/Level/Clock");
    const CharacterClass = game.require("States/Level/character");

    const originalLevelCreateChars = LevelClass.prototype.createCharObjects;
    const originalLevelLoadComplete = LevelClass.prototype.loadComplete;
    const originalLevelUpdate = LevelClass.prototype.update;
    const originalLevelRetry = LevelClass.prototype.retry;
    const originalLevelQuit = LevelClass.prototype.quit;
    const originalCheckEndGame = LevelClass.prototype.checkEndGame;
    const originalMenuAfterAddContent = MenuClass.prototype.afterAddContent;
    const originalMenuLayoutContent = MenuClass.prototype.layoutContent;
    const originalStartTemple = MenuClass.prototype.startTemple;
    const originalMenuStart = MenuClass.prototype.start;
    const originalLevelMenuAfterAddContent = LevelMenuClass.prototype.afterAddContent;
    const originalLevelMenuLayoutContent = LevelMenuClass.prototype.layoutContent;
    const originalStartLevel = LevelMenuClass.prototype.startLevel;
    const originalGoBack = LevelMenuClass.prototype.goBack;
    const originalTempleClicked = game.require("States/Menu/TempleSelector").prototype.templeClicked;
    const originalEndCreate = EndState.prototype.create;
    const originalGameOverRenderContent = GameOverMenu.prototype.renderContent;
    const originalEndMenuContinue = EndMenu.prototype.gotoMenu;
    const originalGameOverMenu = GameOverMenu.prototype.gotoMenu;
    const originalGameOverRetry = GameOverMenu.prototype.retry;
    const originalTogglePause = LevelClass.prototype.togglePause;
    const originalClockUpdate = ClockClass.prototype.update;
    const originalClockGetElapsedSeconds = ClockClass.prototype.getElapsedSeconds;
    const originalCharacterKill = CharacterClass.prototype.kill;
    const originalUIStateCreate = UIStateClass.prototype.create;
    const originalButtonSetDown = ButtonClass.prototype.setDown;

    app.originals.LevelClass = LevelClass;
    app.originals.CharacterClass = CharacterClass;
    app.originals.originalLevelRetry = originalLevelRetry;
    app.originals.originalLevelQuit = originalLevelQuit;
    app.originals.originalGameOverRetry = originalGameOverRetry;
    app.originals.originalCharacterKill = originalCharacterKill;

    ButtonClass.prototype.setDown = function () {
      if (this.disabled) {
        this.isDown = false;
        return;
      }
      return originalButtonSetDown.call(this);
    };

    function cleanupUiStateArtifacts(state) {
      if (!state) {
        return;
      }
      if (state.currentMenu?.destroy) {
        try {
          state.currentMenu.destroy();
        } catch (error) {}
      }
      state.currentMenu = null;
      if (state.root?.destroy) {
        try {
          state.root.destroy(true);
        } catch (error) {}
      }
      state.root = null;
      state.buttons = null;
      state.back = null;
      state.showNumBtn = null;
      state.unlockButton = null;
      state.roomBackButton = null;
      state.text = null;
      state.templeHall = null;
    }

    function patchExistingStateInstance(state) {
      if (!state || state.__networkLobbyInstancePatched) {
        return;
      }

      if (typeof state.afterAddContent === "function") {
        const originalAfterAddContentInstance = state.afterAddContent;
        state.afterAddContent = function () {
          const result = originalAfterAddContentInstance.apply(this, arguments);
          addRoomBackButton(this);
          return result;
        };
      }

      if (typeof state.layoutContent === "function") {
        const originalLayoutContentInstance = state.layoutContent;
        state.layoutContent = function () {
          const result = originalLayoutContentInstance.apply(this, arguments);
          layoutRoomBackButton(this);
          return result;
        };
      }

      state.__networkLobbyInstancePatched = true;
    }

    UIStateClass.prototype.create = function () {
      cleanupUiStateArtifacts(this);
      return originalUIStateCreate.call(this);
    };

    function addRoomBackButton(state) {
      const isOnline = state.game.__onlinePickingLevel || state.game.__onlineMode;
      const isSingleLobby = !!state.game.__singlePlayerLobbyMode;
      
      if (!isOnline && !isSingleLobby) {
        return;
      }

      const BackButtonClass = state.game.require("States/Common/BackButton");
      if (state.roomBackButton) {
        try {
          state.roomBackButton.destroy();
        } catch (e) {}
        state.roomBackButton = null;
      }

      // Always use "返回房间" because "大厅" characters might not exist in the bitmap font
      const label = "返回房间";
      const callback = isOnline ? returnToRoomFromPicker : returnToSingleLobby;

      state.roomBackButton = new BackButtonClass(
        state.game,
        -state.game.realWidth / 2 + 100,
        -state.game.realHeight / 2 + 90,
        label,
        callback,
      );
      state.roomBackButton.__networkLobbyAction = callback;
      if (state.roomBackButton.label) {
        state.roomBackButton.removeChild(state.roomBackButton.label);
        state.roomBackButton.label = state.game.make.bitmapText(0, 0, "font", label, 20);
        state.roomBackButton.label.anchor.set(0.5);
        state.roomBackButton.label.y = -state.roomBackButton.label.textHeight / 2;
        state.roomBackButton.addChild(state.roomBackButton.label);
      }
      state.root.addChild(state.roomBackButton);
      layoutRoomBackButton(state);
    }

    function layoutRoomBackButton(state) {
      const isOnline = state.game.__onlinePickingLevel || state.game.__onlineMode;
      const isSingleLobby = !!state.game.__singlePlayerLobbyMode;

      if ((isOnline || isSingleLobby) && state.roomBackButton) {
        state.roomBackButton.x = -state.game.realWidth / 2 + state.roomBackButton.sprite.width / 2 + 30;
        state.roomBackButton.y = -state.game.realHeight / 2 + state.roomBackButton.sprite.height / 2 + 30;
        if (state.root) {
          state.root.bringToTop(state.roomBackButton);
        }
      }
    }

    function removeRoomBackButton(state) {
      if (!state?.roomBackButton) {
        return;
      }
      try {
        state.roomBackButton.destroy();
      } catch (error) {}
      state.roomBackButton = null;
    }

    LevelClass.prototype.createCharObjects = function (map, chars) {
      originalLevelCreateChars.call(this, map, chars);
      if (!this.game.__onlineMode) {
        return;
      }
      const role = this.game.__onlineSelectedRole;
      const localCursor = createCursorProxy(app.localInputState, true);
      const remoteCursor = createCursorProxy(app.remoteInputState, false);
      this.pers1.cursors = role === "fb" ? localCursor : remoteCursor;
      this.pers2.cursors = role === "wg" ? localCursor : remoteCursor;
      if (this.cursorToggle) {
        this.cursorToggle.visible = false;
      }
    };

    LevelClass.prototype.loadComplete = function () {
      originalLevelLoadComplete.call(this);
      if (!this.game.__onlineMode) {
        return;
      }
      this.game.stage.disableVisibilityChange = true;
      assignBodyIds(this);
    };

    LevelClass.prototype.update = function () {
      originalLevelUpdate.call(this);
      if (!this.game || !this.game.__onlineMode || !this.loadCompleted || this.ended) {
        return;
      }

      app.syncMaps.idToBody.forEach(function (body) {
        applyRemoteCorrection(body);
      });

      if (app.isHostRuntime) {
        app.snapshotTimer += this.game.time.elapsed;
        if (app.snapshotTimer >= 80) {
          app.snapshotTimer = 0;
          sendSnapshot(this);
        }
        return;
      }

      app.snapshotTimer += this.game.time.elapsed;
      if (app.snapshotTimer >= 45) {
        app.snapshotTimer = 0;
        emitInput();
      }
    };

    LevelClass.prototype.checkEndGame = function () {
      if (this.game.__onlineMode && !app.isHostRuntime) {
        return;
      }
      return originalCheckEndGame.call(this);
    };

    LevelClass.prototype.retry = function () {
      if (this.game.__onlineMode) {
        if (!app.isHostRuntime) {
          return;
        }
        sendWs({ type: "retry_level" });
        return;
      }
      return originalLevelRetry.call(this);
    };

    LevelClass.prototype.quit = function () {
      if (this.game.__onlineMode) {
        teardownCurrentOnlineLevel(this.game);
        sendWs({ type: "return_to_room" });
        showLobby();
        this.game.state.fade("menu", true, false);
        return;
      }
      return originalLevelQuit.call(this);
    };

    LevelClass.prototype.togglePause = function () {
      if (this.game.__onlineMode) {
        return;
      }
      return originalTogglePause.call(this);
    };

    MenuClass.prototype.afterAddContent = function () {
      originalMenuAfterAddContent.call(this);
      addRoomBackButton(this);
    };

    MenuClass.prototype.layoutContent = function () {
      const result = originalMenuLayoutContent.call(this);
      layoutRoomBackButton(this);
      return result;
    };

    MenuClass.prototype.start = function () {
      if (typeof originalMenuStart === "function") {
        originalMenuStart.call(this);
      }
      if (this.game.__onlinePickingLevel && this.game.__pendingTempleSelectionTemple) {
        const templeData = cloneJson(this.game.__pendingTempleSelectionTemple);
        this.game.__pendingTempleSelectionTemple = null;
        originalStartTemple.call(this, templeData);
      }
    };

    MenuClass.prototype.startTemple = function (templeData) {
      return originalStartTemple.call(this, templeData);
    };

    const TempleSelectorClass = game.require("States/Menu/TempleSelector");
    TempleSelectorClass.prototype.templeClicked = function () {
      if (!isMenuDelayReady()) {
        this.didpan = false;
        return;
      }
      armMenuDelayGuard();
      return originalTempleClicked.apply(this, arguments);
    };

    LevelMenuClass.prototype.afterAddContent = function () {
      originalLevelMenuAfterAddContent.call(this);
      armLevelMenuDelayGuard();
      if (this.game.__onlinePickingLevel) {
        this.game.__onlineLevelSelectReady = false;
        setTimeout(() => {
          if (this.game.state?.current === "levelMenu" && this.game.__onlinePickingLevel) {
            this.game.__onlineLevelSelectReady = true;
          }
        }, 1000);
      }
      removeRoomBackButton(this);
    };

    LevelMenuClass.prototype.layoutContent = function () {
      const result = originalLevelMenuLayoutContent.call(this);
      removeRoomBackButton(this);
      return result;
    };

    LevelMenuClass.prototype.startLevel = function (button) {
      if (!isLevelMenuDelayReady()) {
        return;
      }
      if (this.game.__onlinePickingLevel) {
        if (this.game.state?.fading || this.game.__onlineLevelSelectReady !== true) {
          return;
        }
        this.game.__onlinePickingLevel = false;
        this.game.__onlineLevelSelectReady = false;
        clearPendingTempleSelection(this.game);
        const selection = resolveLevelSelection(button, this.templeData);
        if (!selection?.templeId || selection?.levelId == null) {
          setStatus(elements.onlineStatus, "无法识别所选关卡。请重新选择。", "error");
          this.game.__onlinePickingLevel = true;
          this.game.__onlineLevelSelectReady = true;
          return;
        }
        sendWs({
          type: "select_level",
          templeId: selection.templeId,
          levelId: selection.levelId,
        });
        showLobby();
        this.game.state.fade("menu", true, false);
        return;
      }
      return originalStartLevel.call(this, button);
    };

    LevelMenuClass.prototype.goBack = function () {
      if (this.game.__onlinePickingLevel) {
        return originalGoBack.call(this);
      }
      if (this.game.__singlePlayerLobbyMode) {
        return originalGoBack.call(this);
      }
      return originalGoBack.call(this);
    };

    CharacterClass.prototype.kill = function () {
      if (this.game.__onlineMode && !app.isHostRuntime) {
        if (this.data?.char !== this.game.__onlineSelectedRole) {
          return;
        }
      }
      return originalCharacterKill.call(this);
    };

    PauseMenuClass.prototype.renderContent = function () {
      this.label = this.game.make.bitmapText(0, 0, "fontStone_large", this.game.lang.locale("Paused"), 36);
      this.label.anchor.set(0);
      this.label.x = -this.label.width / 2;
      this.label.y = 0.5 * -this.contentSize.halfHeight + this.label.textHeight / 2;
      this.board.addChild(this.label);

      this.settingsButton = new (this.game.require("States/Common/Button"))(
        this.game,
        0,
        0,
        "MenuAssets",
        ["SettingsButton0000", "SettingsButton0001"],
        (menu => () => {
          const settingsMenu = new (this.game.require("States/Settings/SettingsMenu"))(menu.game, menu.levelState);
          settingsMenu.show();
          settingsMenu.onClose.add(settingsMenu.destroy);
        })(this),
        "pusher",
      );
      this.settingsButton.anchor.set(1);
      this.settingsButton.scale.set(0.9);
      this.settingsButton.x = this.contentSize.halfWidth - this.settingsButton.width;
      this.settingsButton.y = -this.contentSize.halfHeight + this.settingsButton.height + 100;
      this.board.addChild(this.settingsButton);

      this.button1 = new (this.game.require("States/Common/StoneButton"))(
        this.game,
        0,
        0,
        this.game.lang.locale("Retry"),
        () => {
          const currentGame = getGame();
          if (this.level && (!currentGame?.__onlineMode || app.isHostRuntime)) {
            this.level.retry();
          }
        },
      );
      this.button1.__networkAction = () => {
        const currentGame = getGame();
        if (this.level && (!currentGame?.__onlineMode || app.isHostRuntime)) {
          this.level.retry();
        }
      };
      this.button1.anchor.set(0);
      this.board.addChild(this.button1);

      this.button2 = new (this.game.require("States/Common/StoneButton"))(
        this.game,
        0,
        0,
        this.game.lang.locale("End"),
        () => {
          if (this.level) {
            this.level.quit();
          }
        },
      );
      this.button2.anchor.set(0);
      this.board.addChild(this.button2);

      this.button3 = new (this.game.require("States/Common/StoneButton"))(
        this.game,
        0,
        0,
        this.game.lang.locale("Resume"),
        () => {
          const currentGame = getGame();
          if (!currentGame?.__onlineMode) {
            currentGame?.level?.togglePause();
          } else if (this.visible) {
            this.hide();
          }
        },
      );
      this.button3.anchor.set(0);
      this.board.addChild(this.button3);

      if (this.game.__onlineMode && !app.isHostRuntime) {
        this.button1.disable();
      }

      this.layoutContent();
    };

    LevelUIClass.prototype.pauseClicked = function () {
      if (!this.game.__onlineMode) {
        this.game.level.togglePause();
        return;
      }
      if (this.game.level && this.game.level.pauseMenu) {
        this.game.level.pauseMenu.show();
      }
    };

    ClockClass.prototype.update = function () {
      if (!this.game) {
        return;
      }
      if (!this.game.__onlineMode) {
        return originalClockUpdate.call(this);
      }
      if (this.stopped) {
        return;
      }
      if (app.isHostRuntime) {
        app.serverElapsedMs = Math.max(0, Number(app.serverElapsedMs || 0) + Number(this.game.time?.elapsed || 0));
      }
      const elapsedSeconds = Math.max(0, Math.round((app.serverElapsedMs || 0) / 1000));
      this.text.text = this.game.secondsToString(elapsedSeconds);
      this.text.x = -this.text.textWidth / 2;
      this.text.y = -this.height / 2 + this.text.textHeight + 20;
    };

    ClockClass.prototype.getElapsedSeconds = function () {
      if (!this.game) {
        return 0;
      }
      if (!this.game.__onlineMode) {
        return originalClockGetElapsedSeconds.call(this);
      }
      return Math.max(0, Math.round((app.serverElapsedMs || 0) / 1000));
    };

    EndMenu.prototype.gotoMenu = function () {
      if (this.game.__onlineMode) {
        if (this.__networkNavigating) {
          return;
        }
        const isHost = !!app.currentRoom && app.currentRoom.hostId === app.clientId;
        if (isHost) {
          this.__networkNavigating = true;
          openCurrentTempleLevelMenuForHost();
          sendWs({ type: "continue_levels" });
        }
        return;
      }
      return originalEndMenuContinue.call(this);
    };

    GameOverMenu.prototype.gotoMenu = function () {
      if (this.game.__onlineMode) {
        sendWs({ type: "return_to_room" });
        showLobby();
        return;
      }
      return originalGameOverMenu.call(this);
    };

    GameOverMenu.prototype.retry = function () {
      if (this.game.__onlineMode) {
        if (!app.isHostRuntime) {
          return;
        }
        sendWs({ type: "retry_level" });
        return;
      }
      return originalGameOverRetry.call(this);
    };

    GameOverMenu.prototype.renderContent = function () {
      originalGameOverRenderContent.call(this);
      if (!this.game.__onlineMode) {
        return;
      }
      const buttons = getMenuButtons(this);
      const menuButton = this.button1 || buttons[0];
      const retryButton = this.button2 || buttons[1];
      setButtonLabel(menuButton, "End");
      setButtonLabel(retryButton, "Retry");
      
      if (!app.isHostRuntime) {
        if (retryButton?.disable) {
          retryButton.disable();
        }
        attachWaitingNotice(this, "等待房主操作，或点击结束。");
      }
    };

    GameOverMenu.prototype.layoutContent = function () {
      if (this.label) {
        this.label.x = -this.label.width / 2;
        this.label.y = 0.5 * -this.contentSize.halfHeight + this.label.textHeight / 2;
      }
      if (this.button1) {
        this.button1.x = -this.contentSize.halfWidth / 3;
        this.button1.y = 0.4 * this.contentSize.halfHeight;
      }
      if (this.button2) {
        this.button2.x = this.contentSize.halfWidth / 3;
        this.button2.y = 0.4 * this.contentSize.halfHeight;
      }
      if (this.__waitingNotice) {
        this.__waitingNotice.x = 0;
        this.__waitingNotice.y = this.contentSize.halfHeight - 215;
      }
    };

    EndState.prototype.create = function () {
      if (this.game.__onlineMode) {
        consumeRemoteOutcome(this.game);
      }
      if (this.game.__onlineMode && app.isHostRuntime) {
        const payload = {
          data: this.levelState.data,
          state: this.levelState.state,
        };
        if (this.levelState.success) {
          sendWs({ type: "level_complete", nonce: app.currentNonce, payload });
        } else {
          sendWs({ type: "level_failed", nonce: app.currentNonce, payload });
        }
      }
      const result = originalEndCreate.call(this);
      if (this.game.__onlineMode) {
        if (this.levelState.success) {
          markCurrentOnlineLevelComplete(this.game);
          saveOnlineProgress(this.game);
          if (this.menu) {
            const buttons = getMenuButtons(this.menu);
            const continueButton = this.menu.button1 || buttons[0];
            if (app.isHostRuntime) {
              setButtonLabel(continueButton, "Level Select");
            } else {
              setButtonLabel(continueButton, "Wait Host");
              if (continueButton?.disable) {
                continueButton.disable();
              }
              attachWaitingNotice(this.menu, "等待房主操作。");
            }
          }
        } else if (!app.isHostRuntime && this.menu) {
          attachWaitingNotice(this.menu, "等待房主操作，或点击结束。");
        }
      } else if (this.game.__singlePlayerLobbyMode) {
        saveSingleProgress(this.game);
      }
      return result;
    };

    const originalAnimateFinish = LevelClass.prototype.animateFinish;
    LevelClass.prototype.animateFinish = function () {
      if (this.game.__onlineMode && app.isHostRuntime && app.currentNonce) {
        sendWs({ type: "online_finish_animation", nonce: app.currentNonce });
      }
      return originalAnimateFinish.call(this);
    };

    patchExistingStateInstance(game.state?.states?.menu);
    patchExistingStateInstance(game.state?.states?.levelMenu);
    game.__networkLobbyPatched = true;
  }

  function getGame() {
    return window.Phaser && window.Phaser.GAMES ? window.Phaser.GAMES[0] : null;
  }

  function waitForGame(callback) {
    const game = getGame();
    if (game) {
      callback(game);
      return;
    }
    setTimeout(function () {
      waitForGame(callback);
    }, 150);
  }

  function hideLobby() {
    elements.lobbyRoot.classList.remove("visible");
  }

  function showLobby() {
    elements.lobbyRoot.classList.add("visible");
    renderRoomState();
  }

  function bindUi() {
    elements.usernameInput.value = DEFAULT_USERNAME;
    renderModeOptions();
    renderModePanels();
    renderAuthState();

    if (elements.confirmCancelBtn) {
      elements.confirmCancelBtn.addEventListener("click", function () {
        closeConfirmDialog(false);
      });
    }
    if (elements.confirmOkBtn) {
      elements.confirmOkBtn.addEventListener("click", function () {
        closeConfirmDialog(true);
      });
    }
    if (elements.confirmOverlay) {
      elements.confirmOverlay.addEventListener("click", function (event) {
        if (event.target === elements.confirmOverlay) {
          closeConfirmDialog(false);
        }
      });
    }

    elements.registerBtn.addEventListener("click", async function () {
      try {
        const result = await request("/api/register", {
          method: "POST",
          body: JSON.stringify({
            username: elements.usernameInput.value,
            password: elements.passwordInput.value,
          }),
        });
        setAuthenticated(result);
        setStatus(elements.authStatus, "注册成功，已自动登录。", "success");
      } catch (error) {
        setStatus(elements.authStatus, error.message, "error");
      }
    });

    elements.loginBtn.addEventListener("click", async function () {
      try {
        const result = await request("/api/login", {
          method: "POST",
          body: JSON.stringify({
            username: elements.usernameInput.value,
            password: elements.passwordInput.value,
          }),
        });
        setAuthenticated(result);
        setStatus(elements.authStatus, "登录成功。", "success");
      } catch (error) {
        setStatus(elements.authStatus, error.message, "error");
      }
    });

    elements.logoutBtn.addEventListener("click", async function () {
      try {
        await request("/api/logout", { method: "POST", body: JSON.stringify({}) });
      } catch (error) {}
      clearAuth();
      app.currentRoom = null;
      renderRoomState();
      setStatus(elements.authStatus, "已退出登录。", "success");
    });

    elements.singleStartBtn.addEventListener("click", function () {
      startSingleMode();
    });

    elements.singleResetBtn.addEventListener("click", async function () {
      const confirmed = await confirmAction(
        "重置单机进度？",
        "这会立即清空当前账号的单机进度，所有单机关卡都会恢复到未完成状态。",
        { danger: true, confirmLabel: "确认重置" },
      );
      if (!confirmed) {
        return;
      }
      try {
        await request("/api/progress/reset?mode=single", { method: "POST", body: JSON.stringify({}) });
        app.auth.progressSingle = null;
        refreshCurrentGameProgress("single");
        setStatus(elements.singleStatus, "单机进度已重置。", "success");
      } catch (error) {
        setStatus(elements.singleStatus, error.message, "error");
      }
    });

    if (elements.singleCompleteBtn) {
      elements.singleCompleteBtn.addEventListener("click", async function () {
        const confirmed = await confirmAction(
          "单机一键通关？",
          "这会将当前账号的单机进度直接设为全部通关状态。",
          { confirmLabel: "确认通关" },
        );
        if (!confirmed) {
          return;
        }
        try {
          const result = await request("/api/progress/complete-all?mode=single", { method: "POST", body: JSON.stringify({}) });
          app.auth.progressSingle = result.progress || null;
          refreshCurrentGameProgress("single");
          setStatus(elements.singleStatus, "单机进度已一键通关。", "success");
        } catch (error) {
          setStatus(elements.singleStatus, error.message, "error");
        }
      });
    }

    elements.createRoomBtn.addEventListener("click", function () {
      runAfterWsAuth(function () {
        sendWs({ type: "create_room" });
      });
    });

    elements.joinRoomBtn.addEventListener("click", function () {
      runAfterWsAuth(function () {
        sendWs({
          type: "join_room",
          roomCode: elements.roomCodeInput.value,
        });
      });
    });

    elements.leaveRoomBtn.addEventListener("click", function () {
      sendWs({ type: "leave_room" });
      app.currentRoom = null;
      renderRoomState();
    });

    if (elements.copyRoomBtn) {
      elements.copyRoomBtn.addEventListener("click", async function () {
        const code = (elements.roomCodeText.textContent || "").trim();
        if (!code || code === "------") {
          return;
        }
        try {
          await navigator.clipboard.writeText(code);
          setStatus(elements.onlineStatus, "房间码已复制。", "success");
        } catch (error) {
          setStatus(elements.onlineStatus, "复制失败，请手动复制房间码。", "error");
        }
      });
    }

    elements.startOnlineBtn.addEventListener("click", function () {
      if (app.currentRoom?.hostId !== app.clientId) {
        setStatus(elements.onlineStatus, "等待房主操作。", "success");
        return;
      }
      if (!app.currentRoom?.selectedTempleId) {
        beginOriginalPicker();
        return;
      }
      startSelectedOnlineLevel();
    });

    if (elements.reselectOnlineBtn) {
      elements.reselectOnlineBtn.addEventListener("click", function () {
        if (app.currentRoom?.hostId !== app.clientId) {
          setStatus(elements.onlineStatus, "等待房主操作。", "success");
          return;
        }
        beginOriginalPicker();
      });
    }

    elements.retryOnlineBtn.addEventListener("click", function () {
      sendWs({ type: "retry_level" });
    });

    elements.resetOnlineBtn.addEventListener("click", async function () {
      const confirmed = await confirmAction(
        "重置联机进度？",
        "这会立即清空当前账号的联机房主进度，所有联机关卡完成记录都会恢复为未完成。",
        { danger: true, confirmLabel: "确认重置" },
      );
      if (!confirmed) {
        return;
      }
      try {
        await request("/api/progress/reset?mode=online_host", { method: "POST", body: JSON.stringify({}) });
        app.auth.progressOnlineHost = null;
        refreshCurrentGameProgress("online_host");
        setStatus(elements.onlineStatus, "联机房主进度已重置。", "success");
        if (app.currentRoom) {
          app.currentRoom.selectedTempleId = null;
          app.currentRoom.selectedLevelId = null;
          renderRoomState();
        }
      } catch (error) {
        setStatus(elements.onlineStatus, error.message, "error");
      }
    });

    if (elements.completeOnlineBtn) {
      elements.completeOnlineBtn.addEventListener("click", async function () {
        const confirmed = await confirmAction(
          "联机一键通关？",
          "这会将当前账号的联机房主进度直接设为全部通关状态。",
          { confirmLabel: "确认通关" },
        );
        if (!confirmed) {
          return;
        }
        try {
          const result = await request("/api/progress/complete-all?mode=online_host", { method: "POST", body: JSON.stringify({}) });
          app.auth.progressOnlineHost = result.progress || null;
          refreshCurrentGameProgress("online_host");
          setStatus(elements.onlineStatus, "联机房主进度已一键通关。", "success");
          renderRoomState();
        } catch (error) {
          setStatus(elements.onlineStatus, error.message, "error");
        }
      });
    }
  }

  async function bootAuth() {
    if (!app.auth.token) {
      renderAuthState();
      return;
    }
    try {
      const result = await request("/api/auth/me", { method: "GET" });
      app.auth.user = result.user;
      app.auth.progressSingle = result.progressSingle || null;
      app.auth.progressOnlineHost = result.progressOnlineHost || null;
      renderAuthState();
    } catch (error) {
      clearAuth();
    }
  }

  function boot() {
    bindUi();
    connectWs();
    loadTempleData();
    bootAuth();
    installKeyboardSync();
    window.__fb5LobbyApp = app;
    waitForGame(function (game) {
      patchGame(game);
    });
  }

  window.addEventListener("load", boot);
})();
