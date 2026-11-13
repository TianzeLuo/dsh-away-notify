# 已知限制与排障

[← 返回 README](../README.md)

这些是**已知且接受**的取舍，不是待修的 bug；遇到时知道「这是预期行为」即可。
安装与配置见 [开发与配置](development.md)。

## 会话跳转

- 前端不支持 `?session=` 深链，鉴权的 token 换取又会丢掉查询参数，所以跳转由本插件的
  浏览器半部完成——这也是它必须带客户端半部的原因。
- 待跳转会话有 90 秒有效期（`focusTtlMs`）：超过后再点旧通知，只回到 dsh 页面，不强行切会话。
- 走「新开标签页」那条路时，新页面会先落回上次选中的会话，约 1 秒后才切到目标会话。

## 聚焦

- 聚焦依靠「窗口标题 marker + `[dsh:<port>]` tag」与 UI Automation 选标签页；浏览器最小化时
  Chromium 不向 UIA 暴露标签页，助手会先还原窗口再选，代价是首次点击稍慢。
- UIA 不可用（组策略禁用、非 Chromium/Firefox）时，脚本只能聚焦已知窗口，于是**可能多开一个
  标签页**；这是「宁可多开也不把你留在原标签页」的刻意取舍。
- 缺 tag 的旧页面只在已确认属于本实例的窗口内兜底匹配；不知道窗口时不会猜，避免切到另一个实例。
- `titleTag: true` 会改写标签页标题（`… — DeepSeek Harness [dsh:3080]`）；关掉后多实例并存时
  会认错窗口。

## 通知

- 「一直停留」依赖 Windows 的 `scenario="reminder"` 且必须带按钮；它不会被勿扰（Focus Assist）
  静默，这是系统行为。
- `appName` 没有接线（声明了但无处读取）；要区分通知来源请改 `appId`。
- 已进入通知中心的通知按系统行为保留；`dismissOnReturn` 只撤回本插件自己挂着的通知。
- 被其它插件声明为「不打扰」的会话不会弹通知，这是接口而非故障；日志写
  `已抑制(suppressed:<调用方>)`，抑制条件由调用方定义。

## 进程与资源

- 焦点助手是常驻 PowerShell 进程（约 50–70MB），用于把点击端到端从 2.1s 降到约 0.1–0.2s。
- 助手互斥量按 spool 目录区分：共用同一个 `.focus-spool` 的实例共享一个助手；一方卸载/重载
  会把共享助手带走，另一方下一次点击退化为冷启动（约 1.4s），之后由心跳自愈。
- 从早期版本升级后可能残留一个旧助手进程；重启 `dsh` 即可，或只保留启动时间最新的那个。

## 内部会话

- 内部 worker 由创建方登记（[dsh-super-agent](https://github.com/TianzeLuo/dsh-super-agent)
  创建 worker 时调 `markInternal`），改标题不影响判定。
- 标题前缀（`internalSessionTitlePrefixes`，默认 `['Super-agent worker ·']`）只是后备，
  覆盖「未安装/旧版本」与「升级前已存在」的会话；这类边角里改过名的 worker 会重新提醒，
  别的插件用同样前缀命名也会被一起静音，配 `[]` 即关闭。

## 框架与平台差异

- 在场状态 TTL 45 秒（`presenceTtlMs`）：标签页崩溃或浏览器被关掉后，45 秒内仍可能认为你在看。
- 一个标签页可同时「在看」多条会话：主视图那条 + 面板 retain 的那条；面板自动学习只看面板
  被选中后 15 秒内第一个新出现的 retain 来源，显式注册（`awayNotifyPanels`）优先。
- 打开浏览器 DevTools 会让页面失焦（`document.hasFocus()` 为 false），插件判为「离开」——
  预期行为，不是故障。
- 普通 Linux 桌面依赖 `notify-send`（多数发行版需装 `libnotify-bin`）；持久化近似可用，
  但**撤回通知没有通用通道**，`dismissOnReturn` 在 Linux 上不生效。
- WSL 不需要 `notify-send`，直接走 Windows Toast；撤回同样只在 Windows/WSL 可用。

## 排障对照

| 现象 | 先查什么 |
| --- | --- |
| 重启后完全没有反应 | `dsh --profile web --dump-config` 里有没有 `- id: dsh-away-notify`；没有就是 Windows 跨盘符安装问题，见 [安装避坑](development.md#windows-跨盘符安装) |
| 挂上了但不弹 | 先跑 `node scripts/selftest-notify.mjs` 验证通道；通道 OK 就开 `debug: true` 看 `已抑制(<原因>)` |
| 日志是 `已抑制(attended-foreground)` | 你正看着那条会话——设计行为；切到别的标签页或别的应用再试 |
| 日志是 `已抑制(subagent-session)` | 子代理会话默认不打扰（`rootsOnly: true`） |
| 日志是 `已抑制(internal-session)` | 内部会话，来源见 `internalSource`（`super-agent-worker` / `title-prefix`） |
| 盯着会话看，跑完却还是弹了 | 控制台查 `op:'state'` 的 `attendedSessions`；面板里的会话依赖 `panelSessionSources` |
| 点了通知没回到 dsh | 看 `.focus-spool/last-status.txt`：`FOCUSED`/`TAB_FOCUSED` 表示脚本执行了，`TAG_MISS`/`NO_WINDOW` 指向标题或窗口识别 |
| 通知几秒就消失 | 只有 `persistent: true` 才用 reminder 场景常驻；reminder 必须带按钮，否则退化成普通通知 |
| 回到 dsh 后提醒还在 | 控制台 `op:'state'` 看 `sessionTracking`；为 `false` 时按会话撤回不生效，刷新页面后重试 |
