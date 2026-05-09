(function () {
  "use strict";

  const DEFAULT_PLAYER_NAME = `玩家${Math.floor(Math.random() * 900 + 100)}`;
  const ROOM_STATE_LABELS = {
    lobby: "房间中",
    playing: "游戏中",
    ended: "已结束",
  };
  const MODE_CONFIGS = [
    {
      id: "single",
      title: "单人模式",
      copy: "保留原版单机流程，可进入原游戏并重置本地进度。",
    },
    {
      id: "online",
      title: "联机模式",
      copy: "创建或加入 2 人房间，选关后再选角色进入关卡。",
    },
  ];
  const ROLE_CONFIGS = [
    {
      id: "fb",
      title: "Fireboy",
      copy: "火男",
    },
    {
      id: "wg",
      title: "Watergirl",
      copy: "水女孩",
    },
  ];

  const app = {
    bootRetries: 0,
    dataLoaded: false,
    levelOptions: [],
    mode: "single",
    ws: null,
    wsReady: false,
    clientId: null,
    currentRoom: null,
    selectedRole: null,
    pendingStartReason: null,
    onlineInputSeq: 0,
    remoteInputState: {
      left: false,
      right: false,
      up: false,
    },
    localInputState: {
      left: false,
      right: false,
      up: false,
    },
    roleBindingsPatched: false,
    pauseHookPatched: false,
    levelHookPatched: false,
    endHookPatched: false,
    currentNonce: null,
    isHostRuntime: false,
    snapshotTimer: 0,
    syncMaps: {
      deviceBodyToId: new Map(),
      bodyIdToDeviceBody: new Map(),
      playerBodyByRole: {},
      doorByRole: {},
    },
  };

  function qs(id) {
    return document.getElementById(id);
  }

  const elements = {
    lobbyRoot: qs("lobby-root"),
    modeGrid: qs("mode-grid"),
    singlePanel: qs("single-panel"),
    onlinePanel: qs("online-panel"),
    singleStatus: qs("single-status"),
    onlineStatus: qs("online-status"),
    roomPanel: qs("room-panel"),
    roomCodeText: qs("room-code-text"),
    roomRoleText: qs("room-role-text"),
    roomStateText: qs("room-state-text"),
    onlineProgressCount: qs("online-progress-count"),
    playerNameInput: qs("player-name-input"),
    roomCodeInput: qs("room-code-input"),
    copyRoomBtn: qs("copy-room-btn"),
    createRoomBtn: qs("create-room-btn"),
    joinRoomBtn: qs("join-room-btn"),
    leaveRoomBtn: qs("leave-room-btn"),
    singleStartBtn: qs("single-start-btn"),
    singleResetBtn: qs("single-reset-btn"),
    roleGrid: qs("role-grid"),
    levelList: qs("level-list"),
    playerList: qs("player-list"),
    startOnlineBtn: qs("start-online-btn"),
    retryOnlineBtn: qs("retry-online-btn"),
    resetOnlineBtn: qs("reset-online-btn"),
  };

  function waitForGame(callback) {
    const ready =
      window.require &&
      window.require.s &&
      window.require.s.contexts &&
      window.require.s.contexts._ &&
      window.require.s.contexts._.defined &&
      window.Phaser &&
      window.Phaser.GAMES &&
      window.Phaser.GAMES[0];

    if (ready) {
      callback(window.Phaser.GAMES[0]);
      return;
    }

    setTimeout(function () {
      waitForGame(callback);
    }, 150);
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
              templeLabel: temple.label,
              id: `${temple.id}:${level.id}`,
              levelId: String(level.id),
              filename: level.filename,
              label: `${temple.label} · ${level.id + 1}`,
              copy: level.filename,
              type: level.type || "normal",
              levelData: JSON.parse(JSON.stringify(level)),
              templeData: JSON.parse(JSON.stringify(temple)),
            };
          });
        });

      app.dataLoaded = true;
      renderLevelOptions();
    });
  }

  function getSingleProgressNamespace() {
    return "fb-elements";
  }

  function resetSingleProgress() {
    const namespace = `${getSingleProgressNamespace()}:`;
    Object.keys(localStorage).forEach(function (key) {
      if (key.indexOf(namespace) === 0) {
        localStorage.removeItem(key);
      }
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

  function setMode(mode) {
    app.mode = mode;
    renderModeOptions();
    elements.singlePanel.classList.toggle("hidden", mode !== "single");
    elements.onlinePanel.classList.toggle("hidden", mode !== "online");
  }

  function renderModeOptions() {
    elements.modeGrid.innerHTML = "";
    MODE_CONFIGS.forEach(function (config) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `choice-card is-clickable${app.mode === config.id ? " is-active" : ""}`;
      card.innerHTML = `
        <h3 class="choice-title">${config.title}</h3>
        <p class="choice-copy">${config.copy}</p>
      `;
      card.addEventListener("click", function () {
        setMode(config.id);
      });
      elements.modeGrid.appendChild(card);
    });
  }

  function renderRoleOptions() {
    elements.roleGrid.innerHTML = "";
    const room = app.currentRoom;
    const roomPlayers = room?.players || [];
    const myPlayer = roomPlayers.find(function (player) {
      return player.id === app.clientId;
    });

    ROLE_CONFIGS.forEach(function (role) {
      const takenBy = roomPlayers.find(function (player) {
        return player.role === role.id && player.id !== app.clientId;
      });
      const selected = myPlayer?.role === role.id;
      const disabled = !!takenBy;

      const card = document.createElement("button");
      card.type = "button";
      card.className = `role-card ${disabled ? "is-disabled" : "is-clickable"}${selected ? " is-active" : ""}`;
      card.innerHTML = `
        <h3 class="role-title">${role.title}</h3>
        <p class="role-copy">${disabled ? `已被 ${takenBy.name} 选择` : role.copy}</p>
      `;
      card.disabled = disabled;
      card.addEventListener("click", function () {
        send({
          type: "select_role",
          role: selected ? null : role.id,
        });
      });
      elements.roleGrid.appendChild(card);
    });
  }

  function renderLevelOptions() {
    elements.levelList.innerHTML = "";

    if (!app.dataLoaded) {
      return;
    }

    const room = app.currentRoom;
    const isHost = room && room.hostId === app.clientId;

    app.levelOptions.forEach(function (option) {
      const isSelected =
        room &&
        room.selectedTempleId === option.templeId &&
        String(room.selectedLevelId) === option.levelId;
      const isCompleted = room?.progress?.completedLevels?.includes(option.id);
      const levelCard = document.createElement("button");
      levelCard.type = "button";
      levelCard.className = `level-card ${isHost ? "is-clickable" : ""}${isSelected ? " is-active" : ""}`;
      levelCard.disabled = !isHost;
      levelCard.innerHTML = `
        <h3 class="level-title">${option.label}</h3>
        <p class="level-copy">${option.copy}</p>
        <div class="level-tags">
          <span class="tag">${option.type === "normal" ? "普通" : option.type}</span>
          <span class="tag">${isCompleted ? "已完成" : "未完成"}</span>
        </div>
      `;
      levelCard.addEventListener("click", function () {
        send({
          type: "select_level",
          templeId: option.templeId,
          levelId: option.levelId,
        });
      });
      elements.levelList.appendChild(levelCard);
    });
  }

  function renderPlayerList() {
    elements.playerList.innerHTML = "";
    const room = app.currentRoom;
    const roomPlayers = room?.players || [];

    roomPlayers.forEach(function (player) {
      const chip = document.createElement("div");
      chip.className = "player-chip";
      chip.innerHTML = `
        <div>
          <div class="player-name">${player.name}</div>
          <div class="player-meta">${player.id === room.hostId ? "房主" : "成员"}</div>
        </div>
        <div class="player-meta">${player.role === "fb" ? "Fireboy" : player.role === "wg" ? "Watergirl" : "未选角"}</div>
      `;
      elements.playerList.appendChild(chip);
    });
  }

  function renderRoomPanel() {
    const room = app.currentRoom;
    const joined = !!room;
    elements.roomPanel.classList.toggle("hidden", !joined);

    if (!joined) {
      elements.roomCodeText.textContent = "------";
      elements.roomRoleText.textContent = "";
      elements.roomStateText.textContent = "等待玩家进入";
      elements.onlineProgressCount.textContent = "0 关";
      renderPlayerList();
      renderRoleOptions();
      renderLevelOptions();
      return;
    }

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
    elements.roomRoleText.textContent = isHost ? "你是房主" : "你是成员";
    elements.roomStateText.textContent = ROOM_STATE_LABELS[room.game?.status] || "房间中";
    elements.onlineProgressCount.textContent = `${room.progress?.completedLevels?.length || 0} 关`;
    elements.startOnlineBtn.disabled = !isHost || !readyToStart;
    elements.retryOnlineBtn.disabled = !room.selectedTempleId || !room.selectedLevelId;
    elements.resetOnlineBtn.disabled = !isHost;
    elements.copyRoomBtn.disabled = !room.code;
    elements.roomCodeInput.value = room.code;

    if (me) {
      app.selectedRole = me.role || null;
    }

    renderPlayerList();
    renderRoleOptions();
    renderLevelOptions();
  }

  function send(payload) {
    if (!app.wsReady || !app.ws) {
      setStatus(elements.onlineStatus, "联机连接尚未建立。", "error");
      return;
    }
    app.ws.send(JSON.stringify(payload));
  }

  function connectWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    app.ws = socket;

    socket.addEventListener("open", function () {
      app.wsReady = true;
      setStatus(elements.onlineStatus, "已连接到房间服务器。", "success");
    });

    socket.addEventListener("close", function () {
      app.wsReady = false;
      app.currentRoom = null;
      renderRoomPanel();
      setStatus(elements.onlineStatus, "联机连接已断开，请刷新页面后重试。", "error");
    });

    socket.addEventListener("message", function (event) {
      const message = JSON.parse(event.data);
      handleSocketMessage(message);
    });
  }

  function handleSocketMessage(message) {
    switch (message.type) {
      case "welcome":
        app.clientId = message.clientId;
        break;

      case "room_state":
        app.currentRoom = message.room;
        renderRoomPanel();
        break;

      case "start_level":
        app.currentRoom = message.room;
        renderRoomPanel();
        hideLobby();
        startOnlineLevelFromRoom(message.room);
        break;

      case "return_to_room":
        showLobby();
        forceReturnToRoom();
        break;

      case "player_input":
        handleRemoteInputMessage(message);
        break;

      case "level_snapshot":
        handleSnapshotMessage(message);
        break;

      case "level_complete":
        handleRemoteLevelComplete(message);
        break;

      case "level_failed":
        handleRemoteLevelFail(message);
        break;

      case "error":
        setStatus(elements.onlineStatus, message.message, "error");
        break;

      default:
        break;
    }
  }

  function hideLobby() {
    elements.lobbyRoot.classList.remove("visible");
  }

  function showLobby() {
    elements.lobbyRoot.classList.add("visible");
    renderRoomPanel();
  }

  function getGame() {
    return window.Phaser && window.Phaser.GAMES ? window.Phaser.GAMES[0] : null;
  }

  function findLevelOption(templeId, levelId) {
    return app.levelOptions.find(function (option) {
      return option.templeId === templeId && String(option.levelId) === String(levelId);
    });
  }

  function getRoomPlayerRole(clientId) {
    const room = app.currentRoom;
    const player = room?.players?.find(function (currentPlayer) {
      return currentPlayer.id === clientId;
    });
    return player?.role || null;
  }

  function getRemoteRole() {
    return app.selectedRole === "fb" ? "wg" : app.selectedRole === "wg" ? "fb" : null;
  }

  function ensureRoleInputPatch(game) {
    if (app.roleBindingsPatched) {
      return;
    }

    game.__roleInputPatchInstalled = true;
    app.roleBindingsPatched = true;

    const originalAddKey = game.input.keyboard.addKey.bind(game.input.keyboard);
    game.input.keyboard.addKey = function (keyCode) {
      const key = originalAddKey(keyCode);
      const originalGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(key), "isDown");
      if (!originalGetter || key.__onlineInputWrapped) {
        return key;
      }

      Object.defineProperty(key, "isDown", {
        configurable: true,
        enumerable: true,
        get: function () {
          if (!game.__onlineMode || !game.level || !app.selectedRole) {
            return originalGetter.get.call(this);
          }

          const localIsFireboy = app.selectedRole === "fb";
          const localIsWatergirl = app.selectedRole === "wg";
          if (keyCode === window.Phaser.Keyboard.A) {
            return localIsWatergirl ? app.localInputState.left : app.remoteInputState.left;
          }
          if (keyCode === window.Phaser.Keyboard.D) {
            return localIsWatergirl ? app.localInputState.right : app.remoteInputState.right;
          }
          if (keyCode === window.Phaser.Keyboard.W) {
            return localIsWatergirl ? app.localInputState.up : app.remoteInputState.up;
          }
          if (keyCode === window.Phaser.Keyboard.LEFT) {
            return localIsFireboy ? app.localInputState.left : app.remoteInputState.left;
          }
          if (keyCode === window.Phaser.Keyboard.RIGHT) {
            return localIsFireboy ? app.localInputState.right : app.remoteInputState.right;
          }
          if (keyCode === window.Phaser.Keyboard.UP) {
            return localIsFireboy ? app.localInputState.up : app.remoteInputState.up;
          }

          return originalGetter.get.call(this);
        },
      });

      key.__onlineInputWrapped = true;
      return key;
    };
  }

  function installKeyboardInputSync() {
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
      emitLocalInput();
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
      emitLocalInput();
    });
  }

  function emitLocalInput() {
    if (!app.currentNonce || !app.currentRoom) {
      return;
    }
    app.onlineInputSeq += 1;
    send({
      type: "input",
      nonce: app.currentNonce,
      seq: app.onlineInputSeq,
      state: app.localInputState,
    });
  }

  function startSingleMode() {
    setStatus(elements.singleStatus, "");
    hideLobby();
    const game = getGame();
    if (!game) {
      setStatus(elements.singleStatus, "游戏尚未加载完成，请稍后再试。", "error");
      showLobby();
      return;
    }

    game.__onlineMode = false;
    game.settings.controls = "keyboard";
    if (typeof game.saveSettings === "function") {
      game.saveSettings();
    }
    if (game.settingsSignal) {
      game.settingsSignal.dispatch("controls");
    }
    game.state.fade("menu", true, false);
  }

  function startOnlineLevelFromRoom(room) {
    const game = getGame();
    if (!game) {
      return;
    }

    const levelOption = findLevelOption(room.selectedTempleId, room.selectedLevelId);
    if (!levelOption) {
      setStatus(elements.onlineStatus, "未找到所选关卡数据。", "error");
      showLobby();
      return;
    }

    app.currentRoom = room;
    app.currentNonce = room.game?.nonce || null;
    app.selectedRole = getRoomPlayerRole(app.clientId);
    app.remoteInputState = { left: false, right: false, up: false };
    app.localInputState = { left: false, right: false, up: false };
    app.isHostRuntime = room.hostId === app.clientId;
    game.__onlineMode = true;
    game.__onlineRoomCode = room.code;
    game.__onlineNonce = app.currentNonce;
    game.__onlineSelectedRole = app.selectedRole;
    game.__onlineLevelOption = levelOption;
    game.currentTemple = JSON.parse(JSON.stringify(levelOption.templeData));
    game.settings.controls = "keyboard";
    if (typeof game.saveSettings === "function") {
      game.saveSettings();
    }
    if (game.settingsSignal) {
      game.settingsSignal.dispatch("controls");
    }

    game.state.add("level", game.require("States/Level/Level"));
    game.state.fade("level", true, false, JSON.parse(JSON.stringify(levelOption.levelData)));
  }

  function patchLevelState(game) {
    if (app.levelHookPatched) {
      return;
    }

    const LevelClass = game.require("States/Level/Level");
    const originalCreateCharObjects = LevelClass.prototype.createCharObjects;
    const originalLoadComplete = LevelClass.prototype.loadComplete;
    const originalRetry = LevelClass.prototype.retry;
    const originalQuit = LevelClass.prototype.quit;

    LevelClass.prototype.createCharObjects = function (map, chars) {
      originalCreateCharObjects.call(this, map, chars);

      if (!this.game.__onlineMode) {
        return;
      }

      this.game.settings.controls = "keyboard";
      if (this.cursorToggle) {
        this.cursorToggle.visible = false;
      }
      if (this.pers1 && this.pers1.cursors.buttons) {
        this.pers1.cursors.hide();
      }
      if (this.pers2 && this.pers2.cursors.buttons) {
        this.pers2.cursors.hide();
      }

      const localRole = this.game.__onlineSelectedRole;
      const remoteRole = localRole === "fb" ? "wg" : "fb";
      if (localRole === "fb") {
        this.pers2.cursors.active = false;
      } else {
        this.pers1.cursors.active = false;
      }

      app.syncMaps.playerBodyByRole = {
        fb: this.pers1?.body?.data || null,
        wg: this.pers2?.body?.data || null,
      };
      app.syncMaps.doorByRole = {
        fb: this.door1?.body?.data || null,
        wg: this.door2?.body?.data || null,
      };
      app.remoteRole = remoteRole;
    };

    LevelClass.prototype.loadComplete = function () {
      originalLoadComplete.call(this);

      if (!this.game.__onlineMode) {
        return;
      }

      this.__snapshotSeq = 0;
      assignBodyIds(this);
    };

    LevelClass.prototype.retry = function () {
      if (this.game.__onlineMode) {
        if (this.game.level && this.game.level.sounds && this.game.level.sounds.levelMusic) {
          this.game.level.sounds.levelMusic.stop();
        }
        this.killAll();
        send({ type: "retry_level" });
        this.game.state.fade("menu", true, false);
        showLobby();
        return;
      }

      originalRetry.call(this);
    };

    LevelClass.prototype.quit = function () {
      if (this.game.__onlineMode) {
        if (this.game.level && this.game.level.sounds && this.game.level.sounds.levelMusic) {
          this.game.level.sounds.levelMusic.stop();
        }
        this.killAll();
        send({ type: "return_to_room" });
        this.game.state.fade("menu", true, false);
        showLobby();
        return;
      }
      originalQuit.call(this);
    };

    const originalUpdate = LevelClass.prototype.update;
    LevelClass.prototype.update = function () {
      originalUpdate.call(this);

      if (!this.game.__onlineMode || !this.loadCompleted) {
        return;
      }

      if (app.isHostRuntime) {
        app.snapshotTimer += this.game.time.elapsed;
        if (app.snapshotTimer >= 80) {
          app.snapshotTimer = 0;
          sendSnapshot(this);
        }
      }
    };

    app.levelHookPatched = true;
  }

  function assignBodyIds(level) {
    app.syncMaps.deviceBodyToId = new Map();
    app.syncMaps.bodyIdToDeviceBody = new Map();
    let nextId = 1;

    function registerBody(body, label) {
      if (!body || app.syncMaps.deviceBodyToId.has(body)) {
        return;
      }
      const id = `${label}:${nextId++}`;
      app.syncMaps.deviceBodyToId.set(body, id);
      app.syncMaps.bodyIdToDeviceBody.set(id, body);
    }

    registerBody(level.pers1?.body?.data, "player-fb");
    registerBody(level.pers2?.body?.data, "player-wg");

    (level.objects || []).forEach(function (object, index) {
      registerBody(object?.body?.data, object?.options?.type || `device-${index}`);
      if (object?.sprite?.body?.data && object.body?.data !== object.sprite.body.data) {
        registerBody(object.sprite.body.data, `${object?.options?.type || "sprite"}-${index}`);
      }
    });
  }

  function bodyToSnapshot(body) {
    if (!body) {
      return null;
    }

    const id = app.syncMaps.deviceBodyToId.get(body);
    if (!id) {
      return null;
    }

    const position = body.GetPosition();
    const velocity = body.GetLinearVelocity();
    return {
      id: id,
      x: position.x,
      y: position.y,
      angle: body.GetAngleRadians(),
      vx: velocity.x,
      vy: velocity.y,
      av: body.GetAngularVelocity ? body.GetAngularVelocity() : 0,
    };
  }

  function sendSnapshot(level) {
    const bodies = [];

    app.syncMaps.bodyIdToDeviceBody.forEach(function (body) {
      const snapshot = bodyToSnapshot(body);
      if (snapshot) {
        bodies.push(snapshot);
      }
    });

    send({
      type: "snapshot",
      nonce: app.currentNonce,
      clock: level.ui?.clock?.getElapsedSeconds ? level.ui.clock.getElapsedSeconds() : 0,
      bodies: bodies,
    });
  }

  function handleSnapshotMessage(message) {
    const game = getGame();
    const level = game?.level;
    if (!game || !level || !game.__onlineMode || app.isHostRuntime || message.nonce !== app.currentNonce) {
      return;
    }

    message.bodies.forEach(function (bodyState) {
      const body = app.syncMaps.bodyIdToDeviceBody.get(bodyState.id);
      if (!body) {
        return;
      }

      const current = body.GetPosition();
      const dx = bodyState.x - current.x;
      const dy = bodyState.y - current.y;
      if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
        body.SetPositionXY(bodyState.x, bodyState.y);
      }
      body.SetAngle(bodyState.angle);
      body.SetLinearVelocity(new box2d.b2Vec2(bodyState.vx, bodyState.vy));
      if (body.SetAngularVelocity) {
        body.SetAngularVelocity(bodyState.av || 0);
      }
    });
  }

  function handleRemoteInputMessage(message) {
    if (message.nonce !== app.currentNonce) {
      return;
    }
    app.remoteInputState = {
      left: !!message.state?.left,
      right: !!message.state?.right,
      up: !!message.state?.up,
    };
  }

  function forceReturnToRoom() {
    const game = getGame();
    if (!game) {
      return;
    }

    app.currentNonce = null;
    app.remoteInputState = { left: false, right: false, up: false };
    app.localInputState = { left: false, right: false, up: false };
    game.__onlineMode = false;
    if (game.state.current === "level" || game.state.current === "endGame") {
      game.state.fade("menu", true, false);
    }
  }

  function patchEndState(game) {
    if (app.endHookPatched) {
      return;
    }

    const EndState = game.require("States/End");
    const EndMenu = game.require("States/Level/EndMenu");
    const GameOverMenu = game.require("States/Level/GameOverMenu");
    const originalCreate = EndState.prototype.create;
    const originalEndGotoMenu = EndMenu.prototype.gotoMenu;
    const originalGameOverGotoMenu = GameOverMenu.prototype.gotoMenu;
    const originalGameOverRetry = GameOverMenu.prototype.retry;

    EndMenu.prototype.gotoMenu = function () {
      if (this.game.__onlineMode) {
        send({ type: "return_to_room" });
        showLobby();
        return;
      }
      return originalEndGotoMenu.call(this);
    };

    GameOverMenu.prototype.gotoMenu = function () {
      if (this.game.__onlineMode) {
        send({ type: "return_to_room" });
        showLobby();
        return;
      }
      return originalGameOverGotoMenu.call(this);
    };

    GameOverMenu.prototype.retry = function () {
      if (this.game.__onlineMode) {
        send({ type: "retry_level" });
        showLobby();
        return;
      }
      return originalGameOverRetry.call(this);
    };

    EndState.prototype.create = function () {
      if (this.game.__onlineMode) {
        if (app.isHostRuntime) {
          if (this.levelState && this.levelState.success) {
            send({
              type: "complete_level",
              nonce: app.currentNonce,
              summary: {
                state: this.levelState.state,
                totalDiamonds: this.levelState.data ? this.levelState.data.totalDiamonds : 0,
              },
            });
          } else if (this.levelState && this.levelState.success === false) {
            send({
              type: "level_failed",
              nonce: app.currentNonce,
              summary: {
                state: this.levelState.state,
              },
            });
          }
        }
        console.log("game ended with online mode");
        if (this.levelState && this.levelState.success) {
          this.menu = new (this.game.require("States/Level/EndMenu"))(this.game, this.levelState);
          this.menu.show();
        } else {
          this.menu = new (this.game.require("States/Level/GameOverMenu"))(this.game, this.levelState);
          this.menu.show();
        }
        return;
      }

      originalCreate.call(this);
    };

    app.endHookPatched = true;
  }

  function handleRemoteLevelComplete(message) {
    if (app.isHostRuntime || message.nonce !== app.currentNonce) {
      return;
    }

    const game = getGame();
    if (!game?.level) {
      return;
    }

    const level = game.level;
    level.levelState = message.summary && message.summary.state ? message.summary.state : level.levelState;
    level.ui.clock.stop();
    level.levelData.totalDiamonds = message.summary && message.summary.totalDiamonds != null
      ? message.summary.totalDiamonds
      : level.totalDiamonds || 0;
    game.state.add("endGame", game.require("States/End"));
    game.state.start("endGame", false, false, {
      success: true,
      data: level.levelData,
      state: level.levelState,
    });
  }

  function handleRemoteLevelFail(message) {
    if (app.isHostRuntime || message.nonce !== app.currentNonce) {
      return;
    }

    const game = getGame();
    if (!game?.level) {
      return;
    }

    const level = game.level;
    if (message.summary && message.summary.state) {
      level.levelState = message.summary.state;
    }
    level.ui.clock.stop();
    game.state.add("endGame", game.require("States/End"));
    game.state.start("endGame", false, false, {
      success: false,
      data: level.levelData,
      state: level.levelState,
    });
  }

  function installGamePatches(game) {
    if (game.__networkLobbyPatched) {
      return;
    }

    game.require = function (moduleName) {
      return window.require(moduleName);
    };

    ensureRoleInputPatch(game);
    patchLevelState(game);
    patchEndState(game);
    installKeyboardInputSync();
    game.__networkLobbyPatched = true;
  }

  function bindUi() {
    elements.playerNameInput.value = DEFAULT_PLAYER_NAME;
    renderModeOptions();
    setMode("single");

    elements.singleStartBtn.addEventListener("click", function () {
      startSingleMode();
    });

    elements.singleResetBtn.addEventListener("click", function () {
      resetSingleProgress();
      setStatus(elements.singleStatus, "单人进度已重置，重新进入单人模式即可生效。", "success");
    });

    elements.createRoomBtn.addEventListener("click", function () {
      send({
        type: "create_room",
        name: elements.playerNameInput.value,
      });
    });

    elements.joinRoomBtn.addEventListener("click", function () {
      send({
        type: "join_room",
        roomCode: elements.roomCodeInput.value,
        name: elements.playerNameInput.value,
      });
    });

    elements.leaveRoomBtn.addEventListener("click", function () {
      send({ type: "leave_room" });
      app.currentRoom = null;
      renderRoomPanel();
    });

    elements.startOnlineBtn.addEventListener("click", function () {
      send({ type: "start_level" });
    });

    elements.retryOnlineBtn.addEventListener("click", function () {
      send({ type: "retry_level" });
    });

    elements.resetOnlineBtn.addEventListener("click", function () {
      send({ type: "reset_room_progress" });
    });

    elements.copyRoomBtn.addEventListener("click", function () {
      if (!app.currentRoom?.code) {
        return;
      }
      navigator.clipboard.writeText(app.currentRoom.code).then(function () {
        setStatus(elements.onlineStatus, "房间号已复制。", "success");
      });
    });
  }

  function boot() {
    bindUi();
    connectWebSocket();
    loadTempleData().catch(function () {
      setStatus(elements.onlineStatus, "关卡数据读取失败。", "error");
    });

    waitForGame(function (game) {
      installGamePatches(game);
    });
  }

  window.addEventListener("load", boot);
})();
