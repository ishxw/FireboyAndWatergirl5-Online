# FireboyAndWatergirl5-Online

基于原版 Fireboy & Watergirl 5 改造的网页版本，支持：

- 单人模式
- 联机房间模式
- 房主原版选关
- 双人选角，角色互斥
- 账号体系与服务端进度保存
- 断线后自动重连与房间恢复

## 本地运行

方式 1：

- 直接运行 [run_game.bat](/E:/Project/Web/FireboyAndWatergirl-master/5/run_game.bat)

方式 2：

```bash
npm install
npm start
```

打开：

```text
http://127.0.0.1:8005/index.html
```

## 当前实现

- 服务端使用 `ws` 处理房间 WebSocket。
- 账号、会话、单机进度、联机房主进度已迁移到 SQLite。
- 进度写入改为服务端权威接口，不再接受前端整包覆盖。
- 房间玩家身份改为稳定 `playerId`，支持同账号断线恢复。
- 前端会自动重连房间连接，并在重连后尝试恢复当前房间和进行中的关卡。

## 主要文件

- [server.js](/E:/Project/Web/FireboyAndWatergirl-master/5/server.js)
  HTTP / WebSocket 服务、房间管理、账号和进度接口
- [lib/database.js](/E:/Project/Web/FireboyAndWatergirl-master/5/lib/database.js)
  SQLite 存储层
- [lib/game-manifest.js](/E:/Project/Web/FireboyAndWatergirl-master/5/lib/game-manifest.js)
  关卡清单加载与校验
- [js/network-lobby.js](/E:/Project/Web/FireboyAndWatergirl-master/5/js/network-lobby.js)
  大厅、房间、联机流程与游戏补丁
- [css/lobby.css](/E:/Project/Web/FireboyAndWatergirl-master/5/css/lobby.css)
  大厅界面样式
- [DEPLOY.md](/E:/Project/Web/FireboyAndWatergirl-master/5/DEPLOY.md)
  部署说明

## 数据存储

默认 SQLite 文件：

```text
DATA_DIR/fireboy-online.sqlite
```

默认开发环境下，`DATA_DIR` 未设置时会落在项目目录。

## 健康检查

```text
http://127.0.0.1:8005/healthz
```

返回内容包括：

- `ok`
- `activeRooms`
- `activeClients`
- `accounts`
- `dbFile`

## 环境要求

- Node.js `>= 18`
