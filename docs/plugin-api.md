# 给其他插件的接口：抑制与点击揭示

[← 返回 README](../README.md)

有些插件会创建**普通会话**，但它们不希望这类会话打扰用户。最典型的是 `dsh-btw-sidebar`：
侧边聊天是主会话 fork 出来的普通会话，而浏览器半部上报的「当前会话」永远是主视图那条
（`retainedBy.mainView`），所以宿主的在场判定**认不出**用户其实正看着侧栏面板里的那一条——
跑完一轮就会误弹。

首选修法是把「要不要提醒、点了去哪儿」交给**创建会话的那一方**声明，而不是让 away-notify 去猜。
away-notify 通过一个 cordis 服务开放这个能力（服务名 `awayNotify`，实现见
[lib/suppress.js](../lib/suppress.js)）。

> **唯一的例外**：`super-agent` 派发的 worker 是普通 Session（`header` 上没有 `origin` /
> `delegationDepth`，见[实现说明 §3.2](./implementation-notes.md#32-内部会话为什么按标题识别super-agent-worker)），
> 它也没有调用本接口，所以本插件用**一条可配置的标题前缀**兜底（`internalSessionTitlePrefixes`，
> 默认 `['Super-agent worker ·']`）。这不是通用关键词黑名单：清单只有这一项、可清空、命中只影响
> 通知判定。**你自己的插件请优先用 `suppressSession` / `addRule`**，别依赖标题。

这是给**宿主侧**插件的通路。浏览器侧另有一个**可选**的面板注册接口 `awayNotifyPanels`：
如果某个主区域面板（`ctx.slots` 的 `main` keyed 槽）自己 retain 会话，它可以告诉 away-notify
「面板 id + retain 来源」，点击通知时就会激活这个面板。**不注册也能工作**：away-notify 会在
面板被选中后自动学习「新出现的 retain 来源 → 面板」的对应关系（见文末「面板点击落点」）。

---

## 用法

揭示目标可以再带一个「归属主视图会话」（`mainSessionId`）。这不是可选的花活：右栏的状态
（`ctx.sidebarRight`）是**按主视图会话分域**的，`openResource(地址)` 只作用于当前挂载的那条会话，
所以点一条属于会话 A 的右栏通知时若不先切回 A，tab 会落进你当前看的 B 的右栏——左栏也不回原会话，
并且同一资源地址被两个 tab 同时持有（资源注册表按地址引用计数），只关一个不会中止资源流，会话
也就不会归档。声明方知道这个归属（它就是在哪条会话里建的），所以由它告诉 away-notify：

```js
// 在任意宿主侧插件里
const away = ctx.get('awayNotify')            // 或 ctx.inject(['awayNotify'], (c) => …) 等服务就绪
if (away) {
  // ① 抑制
  const release = away.suppressSession('session-abc', 'my-plugin') // 逐条声明；返回释放函数
  away.releaseSession('session-abc')                               // 撤销该会话的全部声明
  away.isSuppressed('session-abc')            // 诊断：返回原因标签或 undefined

  // ①' 内部会话（推荐给「创建方」）：这条会话不是用户直接发起的对话。
  //    与按标题前缀识别的那条路径**同语义、同 reason**（internal-session），
  //    同样受 rootsOnly 约束；用户改标题也不影响判定。
  const releaseInternal = away.markInternal('session-worker-1', 'my-plugin-worker')
  away.isInternal('session-worker-1')         // 诊断：返回原因标签或 undefined

  away.addRule({                              // 按「类」声明：自己决定什么条件下静音
    id: 'my-plugin',
    reason: 'my-plugin',
    match: (sessionId, event, context) =>       // context = { attended, pageAttended }
      myIds.has(sessionId) && context.pageAttended,
  })

  // ② 点击揭示：点它的通知时，先在右栏打开这个资源（已在右栏则聚焦那个 tab）。
  //    mainSessionId 可选：该资源所在的右栏属于哪条主视图会话——右栏的状态按会话分域，
  //    目标不是当前会话时浏览器半部会先切过去再打开（不传就开在当前会话里）。
  away.revealSession('session-abc', {
    resource: 'dsh-resource://my-plugin/session/abc',
    mainSessionId: 'session-parent',
    reason: 'my-plugin',
  })
  away.revealFor('session-abc')               // 诊断：{ resource, mainSessionId?, reason } | undefined
  away.snapshot()                             // 诊断：{ version, sessions, rules }
}
```

| 行为 | 说明 |
|---|---|
| 时机 | 抑制在**在场判定与冷却之前**生效，与「是否刚收到过同类通知」无关；是否与在场有关由调用方的规则决定 |
| 上下文 | 规则第三个参数是宿主提供的 `{ attended, pageAttended }`——前者「用户正看着这条会话」，后者「用户正看着 dsh 页面（可见 + 有焦点）」。`dsh-btw-sidebar` 就是用它实现「面板**显示在右栏** **且** 你在看时才静音」 |
| 原因 | `reason` 由调用方给（建议用插件 id），命中时日志写 `已抑制(suppressed:<reason>)` |
| 揭示 | `revealSession` 声明的地址会随 `op:'pending-focus'` 的应答发回浏览器半部：**先在右栏 `openResource(地址)`**（目标 tab 已开着就聚焦它、没开就新开并展开右栏），失败才退回「切到主视图那条会话」。可选的 `mainSessionId` 声明「这个右栏属于哪条主视图会话」：右栏状态按会话分域，目标不是当前会话时会先切主视图、等右栏挂载过去再打开；不传就开在当前会话里。地址对 away-notify 是不透明字符串 |
| 内部会话 | `markInternal(sessionId, reason)` 声明「这条会话不是用户直接发起的对话」：`rootsOnly` 生效时不打扰，日志写 `已抑制(internal-session)`，与**标题前缀**那条后备路径同语义、同 reason；两者都受 `rootsOnly: false` 约束。它与 `suppressSession` 的区别是语义而非机制——后者是「别打扰我这类会话」，前者参与「只提醒用户直接发起的会话」这条判定 |
| 隔离 | away-notify **不认识任何具体插件**，也不做标题/关键词匹配（唯一的标题匹配是可清空的后备配置 `internalSessionTitlePrefixes`）；`match` 抛错视为「不抑制」（宁可多弹一条） |
| 计数 | 逐条声明按 token 引用计数：多个调用方各自释放互不影响；`releaseSession` 一次撤销该会话的**全部**声明（抑制 + 内部 + 揭示） |
| 缺失 | 对方没装 / 服务未就绪时 `ctx.get('awayNotify')` 返回 `undefined`，调用方自行降级即可（点击退回主视图） |
| 版本 | 接口版本在服务对象的 `version` 字段与 `snapshot().version` 里（当前 `1`） |

---

## 面板点击落点（浏览器侧 `awayNotifyPanels`）

主区域可能是会话视图，也可能是某个插件面板（`ctx.slots` 的 `main` keyed 槽）。面板里的会话
由面板自己 `sessions.retain(sessionId, { source })` 挂住；**点通知时应该激活那个面板**，而不是
走 `uiWorkspace.openSession()`——后者内部会 `selectPanel(null)`，把面板关掉。

归属关系不写死任何 source 名，按优先级来自三处：

1. **显式注册**（下面的服务）——最可靠，也是唯一能声明「切到某条会话」的通路；
2. **自动学习**——面板被 `layout.selectPanel` 选中后，**第一次新出现**的 retain 来源就认作它的
   （只存本页面内存；**已显式注册的来源不参与学习**；面板关掉后靠「会话 → 面板」记忆重新打开）；
3. 都没有 → 保持旧行为（揭示目标 / 主视图）。

```js
// 在任意浏览器侧插件（client bundle）里；可选，不注册也能靠自动学习工作
const panels = ctx.get('awayNotifyPanels')      // 或 ctx.inject(['awayNotifyPanels'], (c) => …)
if (panels) {
  const release = panels.register({
    panelId: 'my-panel',                        // ctx.layout.selectPanel(id) 的 id
    source: 'myPanelUi',                        // 本面板 retain 会话用的 source（也可传 sources: []）
    // 可选：面板自己把会话切到前台。selectPanel 之后同步调用；抛错只记诊断，不影响已打开的面板
    showSession: (sessionId) => { /* … */ },
  })
  release()                                     // 插件卸载时注销
}
```

| 行为 | 说明 |
|---|---|
| 落点 | 会话正被某个面板来源 retain 时 `layout.selectPanel(panelId)`；会话只在记忆里（面板已关）时也尝试打开它 |
| 优先级 | 当前打开的面板 > 主视图（若主视图也 retain 着它）> 其它面板来源 > 归属记忆 > 主视图 |
| 降级 | 布局服务缺失、`selectPanel` 抛错、面板未注册、会话已关闭/已删除 → 一律退回「揭示目标 / 主视图」老路径，点击不会没反应 |
| 记忆 | 「会话 → 面板」写 `localStorage`（上限 100 条、30 天过期），所以刷新后仍记得；面板卸载后面板 id 不在注册表里，记忆会在下次点击时被清掉 |
| 学习边界 | 只在面板激活后 15 秒内学习，且每个面板只学第一条新来源；**已显式注册的来源与面板不参与学习**（注册优先；注销后自动学习照常接管）；来源绑定不持久化。误绑的代价是「这次点击开到面板而不是主视图」，刷新即恢复 |
| 重复注册 | `register()` 每次调用是一个独立句柄，返回的注销函数幂等；重复注册同一面板/来源不会产生第二条声明，注销只撤自己那份（同一来源多次注册时后注册者优先） |
| 取代猜测 | 把同一来源显式注册给另一个面板时，之前自动学习到的那条猜测会被丢弃——否则注销后点击会退回猜错的面板 |
| 缺失 | 服务未提供时 `ctx.get('awayNotifyPanels')` 返回 `undefined`，面板插件自行降级即可；自动学习仍然生效 |

---

## 排障

presence 端点的 `op:'state'` 会回显 `suppressed: { version, sessions, rules, internal }`
（`sessions` 里同时带 `reason` 与 `reveal`；`internal` 是创建方声明的内部会话，单独列出，
不混进「抑制」），一眼能看出「这条通知为什么不弹、点了会去哪儿」：

```js
fetch('/api/dsh-away-notify',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({op:'state'})}).then(r=>r.json()).then(console.log)
```

实现细节（`SuppressionRegistry` 的引用计数、规则求值、`ctx.provide('awayNotify')` 的接线位置）
见[实现说明 §3.1](./implementation-notes.md#31-抑制与点击揭示给其它插件的-awaynotify-服务)。
