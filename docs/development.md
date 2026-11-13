# 开发与配置

[← 返回 README](../README.md)

面向维护者与排障：目录结构、本地调试、配置字段、实现要点与测试约定。日常使用只看
[README](../README.md) 即可。

## 目录

- `lib/host.js` — 宿主半部：订阅宿主事件、应用冷却与在场判定、调用通知通道。
- `lib/client.js` — 浏览器半部：上报「正在看哪条会话」、按端口给标题加 tag、注册 `dshnotify:` 协议。
- `lib/policy.js` / `presence.js` / `suppress.js` / `notifier.js` — 纯逻辑模块：触发筛选、在场状态、
  抑制登记、Toast/`notify-send` 文案与调用。
- `scripts/` — Windows 焦点助手（`focus-helper.ps1`、`focus-or-open.ps1`）、协议入口
  （`enqueue-focus.vbs`）、安装器（`install-windows.ps1`）、通道自检（`selftest-notify.mjs`）。
- `tests/` — `node:test` 用例，全部离线。

## 本地开发

```bash
node --test                                  # 全部用例，离线，不弹真实通知
node scripts/selftest-notify.mjs "标题" "正文"  # 真弹一条 Toast 并回读通知中心
```

装本地检出目录：`dsh plugin --profile web add /path/to/dsh-away-notify`。
宿主半部改动需要重启 `dsh web`；浏览器半部改动刷新页面即可。

## Windows 跨盘符安装

**症状**：Windows 原生 dsh，插件检出与 profile（`$DSH_HOME`）不在同一盘符时，
`dsh plugin add` 退出码 0、依赖也写进了 profile，但重启后插件完全不加载。

**根因**：`nodeLinker: hoisted` 下，pnpm 把 `link:` 的绝对路径当成相对路径拼在 profile 目录后，
建出的 junction 指向不存在的路径；包解析不到，`dsh` 就认为它没有声明 `dsh.bundle`。更糟的是
重跑一次 `dsh plugin add` / `pnpm install` 会把它移出 `dsh.profile.bundles`，把原本正常的
安装**悄悄注销**。

**处理**：用仓库里的安装器（会跑正常命令、校验结果并修好）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

WSL 侧不受影响：`/mnt/...` 是同一文件系统内的 POSIX 绝对路径，`link:` 解析正常。

## 通知通道自检

排查「装了但不弹」时，先把**通道**与**触发判定**分开：

1. `node scripts/selftest-notify.mjs "标题" "正文"` —— 真弹一条并回读通知中心。
2. 仍不弹：在 profile 的 `cordis.patch.yml` 里临时打开 `notifyOnLoad: true` 与 `debug: true`
   （写 `$DSH_HOME/dsh-away-notify.log`），看日志里的 `已通知` / `已抑制(<原因>)`。
3. 确认通路后把这两项关掉。

接线成功的日志应包含 `已加载 (windows)`、`已注册 dshnotify: 协议`、`presence 端点已注册`。

## 配置字段

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（该文件被热监视）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `onTurnComplete` / `onTurnError` / `onTurnAborted` / `onTurnMaxTokens` | `true` | 回合完成 / 出错 / 中断 / 达到输出上限 |
| `onApproval` / `onQuestion` / `onGoalComplete` | `true` | 等待审批 / agent 提问 / 目标完成 |
| `suppressGoalRounds` | `true` | `/goal` 自动推进的中间轮次静默 |
| `rootsOnly` | `true` | 子代理与内部 worker 会话不打扰 |
| `internalSessionTitlePrefixes` | `['Super-agent worker ·']` | 内部会话的**后备**识别；配 `[]` 关闭 |
| `panelSessionSources` | `['superAgentUi']` | 面板 retain 的会话也算「你正在看」；仅后备 |
| `cooldownMs` | `10000` | 同会话同类型最小间隔 |
| `presenceTtlMs` | `45000` | 在场状态有效期 |
| `previewMaxChars` | `140` | 通知正文摘要截断长度 |
| `sound` / `openOnClick` / `persistent` / `dismissOnReturn` | `true` | 提示音 / 点击回跳 / 常驻 / 切回时撤回 |
| `includeToken` | `true` | 点击 URL 带鉴权 token（取舍见下） |
| `useProtocolHandler` / `titleTag` | `true` | 注册 `dshnotify:` 协议 / 标题加 `[dsh:<port>]` |
| `spoolDir` | `''` | 点击请求与助手工作目录；留空 = 插件目录下 `.focus-spool` |
| `focusWindowMarker` / `focusTtlMs` | `'DeepSeek Harness'` / `90000` | 窗口识别串 / 待跳转会话有效期 |
| `titlePrefix` / `appName` / `appId` | `'DSH'` / `'DeepSeek Harness'` / `'DeepSeek Harness'` | 标题前缀 / 通知来源名（`appName` 未接线，改 `appId`） |
| `webUrl` | `''` | 留空则自动探测 |
| `debug` / `notifyOnLoad` | `false` | 写文件日志 / 加载时发自检通知 |

## 实现要点

- **在场上报按标签页**：每个标签页一个 clientId（存 `sessionStorage`），上报「主视图那条会话」
  加上「主区域面板 retain 的那条」，宿主侧按集合匹配；没有任何「新鲜 + 可见 + 有焦点」的标签页
  时视为离开。
- **点击回跳**：Toast 点击走 `dshnotify:` 协议，由 `enqueue-focus.vbs` 交给常驻的焦点助手；
  助手按「窗口标题 marker + `[dsh:<port>]` tag」聚焦已有窗口，必要时用 UI Automation 选中浏览器
  标签页，再让客户端半部切到目标会话。冷启动约 1.4s，常驻助手约 0.1–0.2s。
- **给其它插件的接口**：宿主侧 `awayNotify.register/markInternal/suppress(...)` 声明「这条会话
  别打扰 / 这是内部会话 / 点它时在右栏打开哪个 tab」；浏览器侧 `awayNotifyPanels.register(...)`
  声明「我的面板 retain 这些会话」。都不要求对方插件存在，缺席时静默降级。
- **`includeToken`**：默认把进程启动 token 拼进点击 URL，浏览器全关时也能点开；代价是 token
  会进本机通知中心历史。改成 `false` 后浏览器已打开（有 cookie）时照常，全关时会落到 401。
  插件不会把该 URL 写进日志。

## 测试约定

- Windows 只认 PE 映像，不能用 shell 脚本冒充 `powershell.exe`；测试一律沿
  `apply(ctx, config, deps)` 注入假 `spawn`，不产生真实通知。
- 随包的 `.ps1` 必须是**纯 ASCII**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本会用 ANSI
  代码页，任何一个非 ASCII 字符都会让整个脚本解析失败；标题 / 正文 / URL 以 UTF-8 base64 内联。
  `protocol.test.mjs` 有一条用例扫描随包脚本保证这一点。
