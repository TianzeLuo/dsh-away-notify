# dsh-away-notify

**只有当你没在看 dsh 页面时**，回合完成、出错、等待审批、agent 提问或目标完成才弹一条
桌面通知；点通知直接回到产生它的会话。

## 安装

```bash
dsh plugin --profile web add github:TianzeLuo/dsh-away-notify
```

1. 重启 `dsh web`（首次安装或替换包必须重启）
2. 刷新页面（浏览器半部要重新进 boot graph）

开发调试时可改装本地目录：`dsh plugin --profile web add /path/to/dsh-away-notify`。

> 如果改用**本地目录**安装（而不是 `github:`）且 dsh 原生跑在 Windows：检出目录与
> `$DSH_HOME` 不在同一盘符时会**静默装出一个永远不会加载的插件**（退出码仍是 0）。
> 用仓库里的 `scripts/install-windows.ps1` 安装，它会校验并修好；细节与判定方法见
> [安装避坑](docs/development.md#windows-跨盘符安装)。

装完想先确认通知通道是否通，可跑一次自检（会真的弹一条 Toast 并回读通知中心）：
见 [通知通道自检](docs/development.md#通知通道自检)。

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH | `>=0.1.7-rc.2`（只写下界） |
| 验证于 | 0.2.2-rc.3（2026-11-13） |
| Node | `>=22.5` |
| 平台 | Windows / WSL2 已验证；Linux 桌面走 `notify-send`（撤回不可用） |

## 能做什么

- **五类提醒，可分别关**：回合完成、出错 / 中断 / 达到输出上限、等待审批、agent 提问、目标完成。
- **只在离开时弹**：按标签页判断你正在看哪条会话，看当前会话不打扰，后台会话照常提醒。
- **点击回跳**：优先聚焦已有的 dsh 窗口并切到出事的那条会话；会话显示在某个面板里时回到该面板。
- **不刷屏也不漏**：同会话同类型有冷却，子代理与内部 worker 默认静默；提醒可一直停留，直到你处理。

## 用法

| 触发方式 | 位置 | 行为 |
| --- | --- | --- |
| 回合结束 / 出错 / 中断 / 超输出上限 | 自动 | 页面不可见或窗口失焦时弹 Toast |
| 等待审批 / agent 提问 / 目标完成 | 自动 | 同上；`/goal` 中间轮次默认静默 |
| 点击通知 | 桌面 Toast | 聚焦已有窗口并切到对应会话；面板里的会话回到面板 |
| 按 id 覆盖配置 | profile 的 `cordis.patch.yml` | 改完热生效（新增 bundle 的首次装载仍需重启） |

关掉插件后：不再弹任何桌面通知，会话、审批与其它插件的行为不变。

常用开关（`onApproval`、`suppressGoalRounds`、`cooldownMs`、`persistent`、`openOnClick` 等）
与完整字段表见 [配置字段](docs/development.md#配置字段)；点击回跳与抑制接口的原理见
[实现要点](docs/development.md#实现要点)。

## 已知限制

- Windows 的「一直停留」依赖 reminder 场景与按钮；它不会被勿扰（Focus Assist）静默，这是系统行为。
- 待跳转会话有 90 秒有效期：过期后再点旧通知只回到 dsh 页面，不强行切会话。
- 普通 Linux 桌面没有通用的通知撤回通道，`dismissOnReturn` 在 Linux 上不生效。

完整清单、平台差异与常见故障见 [已知限制与排障](docs/limitations.md)。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/development.md](docs/development.md) | 目录结构、Windows 安装避坑、通知通道自检、配置字段、测试与实现要点 |
| [docs/limitations.md](docs/limitations.md) | 完整限制、平台差异、故障对照表 |

## 隐私与数据

- 读取：会话标题与回合状态（完成 / 出错 / 审批 / 提问 / 目标）；浏览器侧只读当前可见会话与窗口焦点。
- 外发：不发起任何网络请求；通知由本机 `powershell.exe`（Windows Toast）或 `notify-send` 弹出。
- 存储：`.focus-spool/`（点击请求、窗口缓存，可用 `spoolDir` 改位置）；`debug: true` 时写本地日志。
- 关闭后：不再弹通知或撤回；已进入通知中心的通知按系统行为保留。

## 许可证

MIT，见 [LICENSE](LICENSE)。
