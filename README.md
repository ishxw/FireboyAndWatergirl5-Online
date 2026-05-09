# FireboyAndWatergirl5-Online

基于原版《Fireboy & Watergirl 5》改造的网页版本，支持：

- 单人模式
- 联机房间模式
- 房间选关
- 双人选角，角色不能重复
- 联机房间进度保存
- 手动重置单人 / 联机进度

## 功能说明

### 单人模式

- 保留原有闯关流程
- 可手动重置本地单人进度

### 联机模式

- 2 名玩家进入同一个房间
- 房主选择关卡
- 双方分别选择 `Fireboy` / `Watergirl`
- 两个人不能选同一个角色
- 进入关卡后使用键盘控制
- 联机房间进度按房间号保存
- 房主可手动重置联机进度

## 本地运行

### 方式 1：直接双击

直接运行：

- [run_game.bat](/E:/Project/Web/FireboyAndWatergirl-master/5/run_game.bat)

它会自动：

- 启动 `node server.js`
- 打开浏览器访问 `http://127.0.0.1:8005/index.html`

### 方式 2：命令行运行

在项目目录执行：

```bash
npm install
npm start
```

然后打开：

```text
http://127.0.0.1:8005/index.html
```

## 项目结构

- [server.js](/E:/Project/Web/FireboyAndWatergirl-master/5/server.js)
  Web 服务、WebSocket 房间服务、联机进度持久化、健康检查

- [js/network-lobby.js](/E:/Project/Web/FireboyAndWatergirl-master/5/js/network-lobby.js)
  单人 / 联机大厅、房间交互、联机流程补丁

- [index.html](/E:/Project/Web/FireboyAndWatergirl-master/5/index.html)
  页面入口，挂载大厅 UI 与原游戏

- [css/lobby.css](/E:/Project/Web/FireboyAndWatergirl-master/5/css/lobby.css)
  大厅与联机界面样式

- [DEPLOY.md](/E:/Project/Web/FireboyAndWatergirl-master/5/DEPLOY.md)
  公网部署说明

## 联机进度存储

联机房间进度默认保存在：

```text
online-progress.json
```

内容包括：

- 已完成关卡列表
- 完成历史
- 更新时间

单人进度仍然保存在浏览器本地 `localStorage`。

## 公网部署

本项目已经补充了可部署所需文件：

- [package.json](/E:/Project/Web/FireboyAndWatergirl-master/5/package.json)
- [Dockerfile](/E:/Project/Web/FireboyAndWatergirl-master/5/Dockerfile)
- [DEPLOY.md](/E:/Project/Web/FireboyAndWatergirl-master/5/DEPLOY.md)

推荐部署方式：

1. 一台支持 Node.js 18+ 的 VPS
2. 使用 Nginx / Caddy 做 HTTPS 反向代理
3. 反代普通 HTTP 页面和 `/ws` WebSocket
4. 给 `online-progress.json` 或 `DATA_DIR` 挂持久化目录

详细说明见：

- [DEPLOY.md](/E:/Project/Web/FireboyAndWatergirl-master/5/DEPLOY.md)

## 健康检查

服务启动后可访问：

```text
http://127.0.0.1:8005/healthz
```

返回内容包括：

- `ok`
- `activeRooms`
- `activeClients`
- `progressFile`

## 当前实现说明

这版已经可以本地运行，也可以部署到公网，但联机仍然是偏“实用型”的方案：

- 由房主作为权威端
- 房主广播关卡快照给另一位玩家
- 房间与进度为单进程 JSON 存储

因此它适合：

- 好友开房
- 小规模公网体验
- 先上线验证玩法

如果后续要做更稳定的公网联机，建议继续升级：

- 更稳的同步模型
- 断线重连
- Redis / 数据库房间存储
- 多实例支持

## 启动环境

- Node.js `>= 18`

## 许可与来源

本仓库基于原项目资源与前端逻辑继续改造，当前重点是补齐单人 / 联机房间能力与部署能力。
