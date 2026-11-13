/**
 * client.js — dsh-away-notify 浏览器半部
 *
 * 只做三件事：
 *   1. 把「用户正在看哪个会话 + 标签页是否可见 + 窗口是否有焦点」上报给宿主，
 *      宿主的 PresenceStore 据此决定要不要弹通知（前台抑制）。
 *   2. 处理点击通知回跳：宿主记住待跳转会话，本模块在页面加载 / 重新获得焦点时取走，
 *      再把它送到**实际显示它的位置**——主区域面板（`layout.selectPanel`）或主视图
 *      （`uiWorkspace.openSession`）；面板归属是运行时学习的，不写死插件名。
 *   3. 给 `document.title` 追加一个**按端口区分**的后缀（` [dsh:<port>]`），让同一
 *      台机器上并存的多个 dsh 实例（例如 Windows 原生 + WSL）在浏览器窗口标题上
 *      可区分，从而让 `dshnotify:` 处理器能精确聚焦到出事的那一个实例的窗口。
 *      详见 scripts/focus-or-open.ps1 的说明。
 *
 * 约束（0.1.6 / 0.1.7）：
 *   - 客户端 bundle 必须用 `window.__ModuleLoader__.load({id, factory})` 形式。
 *   - **只能 require seed 静态模块**（react/cordis/store/ui-slots/…）；require 任何
 *     非 seed 的内部包会直接抛错。本模块不 require 任何东西。
 *   - 前端不支持 `?session=` 深链，所以会话跳转只能在这里做：0.1.6 用
 *     `sessions.open()`，0.1.7 该 API 已移除，改用 `uiWorkspace.openSession()`
 *     （见 resolveSessionOpener）。
 *   - 同理，「当前正在看的会话」在 0.1.6 取 `list.getSnapshot().current`，
 *     0.1.7 该字段不再被写入，改用 `byId[].retainedBy.mainView`（见 currentSessionId）。
 *   - 上报不用 `connection.rpc`（该 API 在 0.1.6 不可用），而是 POST 到宿主注册在
 *     `/api` 前缀下的精确路由；浏览器会自动带上同源鉴权 cookie。
 *
 * 注意：`inject` 故意留空。若把 `sessions` 写进 `inject`，而该服务在客户端容器里
 * 不可用或晚就绪，`apply` 会一直不被调用，插件将完全静默——这正是本插件第一版
 * 在真机上 `attended: null` 的原因。改为 apply 先无条件挂上 DOM 监听，再用
 * `ctx.inject(['sessions'], …)` 在服务就绪后接过会话相关的部分。
 */

window.__ModuleLoader__.load({
  id: 'dsh-away-notify',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    // ── 诊断开关（排查问题时置 true，浏览器控制台可见）────────────────────
    const DIAG = false;
    const diag = (...args) => {
      if (DIAG) console.log('[dsh-away-notify]', ...args);
    };

    /** 与宿主 `connection.fetch.register` 注册的路径必须完全一致。 */
    const PRESENCE_PATH = '/api/dsh-away-notify';
    /** 心跳间隔：远小于宿主 presenceTtlMs(45s)，标签页崩溃后能及时判定为「离开」。 */
    const HEARTBEAT_MS = 15000;
    /** 点击通知回跳时 URL 上携带会话 id 的参数名。 */
    const FOCUS_PARAM = 'dshAwayNotifyFocus';
    /**
     * 跨会话揭示时，等「右栏挂载到归属会话」的上限与轮询间隔。
     * 主视图切换是同步的，但右栏的 seat 要等 React 渲染后才 bind；等不到就放弃，
     * 绝不硬开（硬开就会把 tab 开进当前那条会话的右栏，正是这次修的错位）。
     */
    const REVEAL_TIMEOUT_MS = 3000;
    const REVEAL_POLL_MS = 50;

    /**
     * 本实例的窗口标题后缀。
     *
     * 格式必须与 `scripts/focus-or-open.ps1` 里从目标 URL 端口重建的那个完全一致
     * （`[dsh:<port>]`），否则聚焦脚本找不到窗口。用端口而不是别的标识，是因为它
     * 同时出现在浏览器地址栏和通知里的 URL 上——脚本无需额外传参就能推导出来。
     */
    const TITLE_TAG = (() => {
      try {
        const port = location.port || (location.protocol === 'https:' ? '443' : '80');
        return port ? ` [dsh:${port}]` : '';
      } catch {
        return '';
      }
    })();

    // 见文件头说明：留空，避免 apply 被依赖阻塞而永不执行。
    const inject = [];

    /**
     * 每个标签页一个稳定标识。宿主按它记录「谁在看哪个会话」，这样同一标签页切换
     * 会话时旧会话会立刻失效；多个标签页则各自独立、可同时被抑制。
     * 用 sessionStorage 让同一标签页刷新后仍是同一个 id，避免刷新期间残留旧记录。
     */
    const CLIENT_ID = (() => {
      const KEY = 'dshAwayNotifyClientId';
      const make = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
      try {
        const existing = sessionStorage.getItem(KEY);
        if (existing) return existing;
        const fresh = make();
        sessionStorage.setItem(KEY, fresh);
        return fresh;
      } catch {
        return make();
      }
    })();

    /** 只在首次拿不到会话 id 时提示一次，避免每 15 秒刷屏。 */
    let warnedNoSession = false;

    /**
     * dsh 0.1.7 起视图选择归 uiWorkspace 服务；会话切换用它而不是 sessions.open。
     * 由 apply 里的 ctx.inject(['uiWorkspace']) 赋值，见 resolveSessionOpener。
     */
    let workspaceService;

    /**
     * 右栏服务（`ctx.sidebarRight`）。点击通知带着「揭示目标」回来时，先用它把目标
     * 资源开在右栏（已经在右栏就聚焦那个 tab），失败再退回主视图。
     * 同样是可选依赖：服务缺失只是少一条通路，绝不能让 apply 被阻塞。
     */
    let sidebarRightService;

    /**
     * 「面板里正在显示的会话」的 retain 来源。
     *
     * 主视图只 retain 一条会话（source `mainView`）。但主区域也可能被插件面板占据
     * （`ctx.layout.panelInfo.activePanelId !== null`），面板里的会话是用**它自己的
     * source** retain 的——`dsh-super-agent` 的 Router 面板用的是 `superAgentUi`。
     * 此时主视图那条仍然是「上一次打开的会话」，只看它会得出「用户在看 B、其实在看
     * 面板里的 A」，A 跑完一轮就误弹通知。
     *
     * 默认值与宿主 `host.js` 的 `panelSessionSources` 一致：宿主经 `op:'config'`
     * 下发，取不到时保留这里的默认值（约定同 TITLE_TAG）。
     *
     * 自动学习到的面板来源（见 `observePanelBindings`）与显式注册（`registerPanel`）
     * 会**并进**这个集合，所以这里只是「无法学习时的后备清单」，点击落点不依赖它。
     */
    let panelSessionSources = ['superAgentUi'];

    // ── 面板归属：点通知该回哪一块主区域 ──────────────────────────────────
    //
    // 主区域要么是会话视图（会话由 `source: 'mainView'` retain），要么是某个插件
    // 面板（`ctx.slots` 的 `main` keyed 槽；选中状态在 `ctx.layout.panelInfo`）。
    // 面板里的会话由面板自己 retain，来源名由插件命名（如 super-agent 的
    // `superAgentUi`）——所以不能写死名字，也拿不到「来源 → 面板 id」的注册表。
    //
    // 这里的通用做法：**面板被选中后，第一次新出现的 retain 来源就是它的**。
    // 学到之后，点击该来源下的会话通知时先 `layout.selectPanel(面板 id)`；
    // 不能走 `uiWorkspace.openSession()`——它内部是 `replaceMain(..., 'reveal')`，
    // 会先 `selectPanel(null)` 把面板关掉，这正是之前点通知落到主视图的原因。
    //
    // 归属记忆按会话 id 持久化（sessionId 跨刷新稳定），所以「面板已关掉」时也能
    // 重新打开它；会话不存在 / 面板已被卸载 / selectPanel 抛错都退回原来的主视图路径。

    /** 面板归属记忆（sessionId → panelId）的存储 key、条数上限与有效期。 */
    const PANEL_MEMORY_KEY = 'dshAwayNotify.panelMemory.v1';
    const PANEL_MEMORY_LIMIT = 100;
    const PANEL_MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    /**
     * 面板激活后多久内出现的「新 retain 来源」才算该面板自己的。
     *
     * 面板一被选中就会挂载并 retain 它显示的会话（super-agent 的 Router 面板是
     * `superAgentUi`，创建会话可能要等一次 HTTP）。窗口只用于防止误绑：例如面板
     * 开着时你打开右栏，右栏自己的 retain 来源也会「新出现」。误绑只影响本页面
     * 生命周期（来源绑定不持久化），且点击时仍会核对主视图 / 面板注册状态。
     */
    const PANEL_LEARN_WINDOW_MS = 15000;

    /**
     * 显式注册（仅本页面）。
     *
     * 按**句柄**记账：`source → Map<token, panelId>`、`panelId → Map<token, showSession>`。
     * 同一个面板可能被注册两次（插件热重载期间新旧实例并存、宿主重复挂载），
     * 注销只能撤掉自己那份——否则先注销的句柄会把仍然活着的注册一起取消。
     * 读取时取最后写入的那条（后注册者优先）。
     */
    const registeredPanelSources = new Map();
    const registeredPanels = new Map();
    /** 自动学习到的来源绑定（仅本页面）：source → panelId。 */
    const learnedPanelSources = new Map();
    /** 会话上次显示在哪个面板（跨刷新保留，见 readPanelMemory）。 */
    const rememberedPanels = readPanelMemory();
    /** 上一次观察到的面板选择；null 表示主区域是会话视图，undefined 表示还没观察过。 */
    let observedPanelId;
    /** 上一次观察到的全部 retain 来源（不含 mainView），用来识别「新出现」。 */
    let observedPanelSources = new Set();
    /** 当前这轮面板激活的时刻。 */
    let panelActivatedAt = 0;

    /**
     * 上报去重节流：会话列表订阅会在短时间内连续触发（实测同一秒 12 次），
     * 而状态其实没变。相同载荷在心跳周期内只发一次；真正变化（切换标签页/失焦）
     * 会立刻发出。
     */
    let lastPayloadKey = null;
    let lastSentAt = 0;

    /**
     * 当前被选中的会话 id。
     *
     * dsh 0.1.6：会话列表快照带 `current` 字段。
     * dsh 0.1.7：视图选择搬出了 sessions 控制器——其源码注释写得很直白
     *   "view selection remains outside the Controller"，列表快照只剩
     *   `{ids, byId, phase, projectionsBySession}`，`current` 不再被任何人写入。
     *   被查看的会话改为「被主视图 retain 的那条」，即
     *   `byId[id].retainedBy.mainView > 0`（见 dsh-client-ui-session 的 publishMain）。
     *
     * 两个形状都试，谁先命中用谁；都拿不到时返回 undefined，宿主据此退化为
     * 页面级在场判定（保守抑制全部）。
     */
    function currentSessionId(sessionCtx) {
      try {
        const snapshot = sessionCtx?.sessions?.list?.getSnapshot?.();
        const current = snapshot?.current;
        if (typeof current === 'string' && current.length > 0) return current;
        const byId = snapshot?.byId;
        if (byId !== null && typeof byId === 'object') {
          for (const row of Object.values(byId)) {
            if (row === null || typeof row !== 'object') continue;
            if ((row.retainedBy?.mainView ?? 0) > 0 && typeof row.id === 'string' && row.id.length > 0) {
              return row.id;
            }
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 主区域此刻是否被**插件面板**占据（而不是会话视图）。
     *
     * `dsh-client-ui-layout` 把选中的面板记在 `ctx.layout.panelInfo` 上
     * （`{ activePanelId: string|null }`），侧栏面板点击走 `layout.selectPanel(id)`。
     * 服务缺失（老版本）或读取失败都返回 null，等价于旧行为。
     *
     * @param {object} sessionCtx 已注入会话服务的上下文
     * @returns {string|null} 面板 id；没有面板时为 null
     */
    function activePanelId(sessionCtx) {
      try {
        const snapshot = serviceOf(sessionCtx, 'layout')?.panelInfo?.getSnapshot?.();
        const id = snapshot?.activePanelId;
        return typeof id === 'string' && id.length > 0 ? id : null;
      } catch {
        return null;
      }
    }

    /** 会话列表快照；拿不到时返回 undefined（调用方按「未知」处理）。 */
    function sessionSnapshot(sessionCtx) {
      try {
        return sessionCtx?.sessions?.list?.getSnapshot?.();
      } catch {
        return undefined;
      }
    }

    /**
     * 从持久化存储里读回「会话 → 面板」记忆。
     *
     * `localStorage` 不可用（隐私模式、被策略禁用）时只用本页面内的 Map，功能仍可用，
     * 只是刷新后记不住面板归属——属于可接受的降级。
     *
     * @returns {Map<string, { panelId: string, at: number }>}
     */
    function readPanelMemory() {
      const memory = new Map();
      try {
        const raw = globalThis.localStorage?.getItem(PANEL_MEMORY_KEY);
        if (typeof raw !== 'string' || raw.length === 0) return memory;
        const sessions = JSON.parse(raw)?.sessions;
        if (sessions === null || typeof sessions !== 'object') return memory;
        const now = Date.now();
        for (const [sessionId, value] of Object.entries(sessions)) {
          if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
          if (value === null || typeof value !== 'object') continue;
          const { panelId, at } = value;
          if (typeof panelId !== 'string' || panelId.length === 0) continue;
          if (typeof at !== 'number' || !Number.isFinite(at)) continue;
          if (now - at > PANEL_MEMORY_TTL_MS) continue;
          memory.set(sessionId, { panelId, at });
        }
      } catch {
        /* ignore */
      }
      return memory;
    }

    /** 把「会话 → 面板」记忆写回存储；失败只影响刷新后的记忆，不影响点击。 */
    function writePanelMemory() {
      try {
        if (globalThis.localStorage === undefined) return;
        const sessions = {};
        for (const [sessionId, value] of rememberedPanels) sessions[sessionId] = value;
        globalThis.localStorage.setItem(PANEL_MEMORY_KEY, JSON.stringify({ version: 1, sessions }));
      } catch {
        /* ignore */
      }
    }

    /**
     * 记住某条会话显示在某个面板里。值没变时不写存储（列表订阅触发很频繁）。
     *
     * @returns {boolean} 是否发生了变化
     */
    function rememberPanel(sessionId, panelId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
      if (typeof panelId !== 'string' || panelId.length === 0) return false;
      const previous = rememberedPanels.get(sessionId);
      if (previous !== undefined && previous.panelId === panelId) return false;
      // 重新插入到末尾，顺带把「最久没更新」的条目挤出去
      rememberedPanels.delete(sessionId);
      rememberedPanels.set(sessionId, { panelId, at: Date.now() });
      while (rememberedPanels.size > PANEL_MEMORY_LIMIT) {
        const oldest = rememberedPanels.keys().next().value;
        if (oldest === undefined) break;
        rememberedPanels.delete(oldest);
      }
      writePanelMemory();
      return true;
    }

    /** 面板已经不存在时清掉过期记忆，避免每次点击都白试一遍。 */
    function forgetRememberedPanel(sessionId) {
      if (typeof sessionId !== 'string' || !rememberedPanels.delete(sessionId)) return;
      writePanelMemory();
    }

    /** 该会话上次显示在哪个面板；没有 / 过期时返回 null。 */
    function rememberedPanelFor(sessionId) {
      const value = rememberedPanels.get(sessionId);
      if (value === undefined) return null;
      if (Date.now() - value.at > PANEL_MEMORY_TTL_MS) {
        rememberedPanels.delete(sessionId);
        writePanelMemory();
        return null;
      }
      return value.panelId;
    }

    /** Map 里最后写入的值（显式注册的「后注册者优先」就是靠这个）。 */
    function lastValue(map) {
      let value;
      for (const item of map.values()) value = item;
      return value;
    }

    /** source → panelId 的合并视图：显式注册优先，其次自动学习。 */
    function ownerOfSource(source) {
      if (typeof source !== 'string' || source.length === 0 || source === 'mainView') return null;
      const claims = registeredPanelSources.get(source);
      const registered = claims === undefined ? undefined : lastValue(claims);
      if (registered !== undefined) return registered;
      return learnedPanelSources.get(source) ?? null;
    }

    /** 全部「算面板」的 retain 来源：配置的后备清单 + 显式注册 + 自动学习。 */
    function effectivePanelSources() {
      const sources = new Set(panelSessionSources);
      for (const source of registeredPanelSources.keys()) sources.add(source);
      for (const source of learnedPanelSources.keys()) sources.add(source);
      return sources;
    }

    /** 这个面板是否已经有来源绑定（显式或学习）。 */
    function panelHasBinding(panelId) {
      for (const claims of registeredPanelSources.values()) {
        for (const owner of claims.values()) if (owner === panelId) return true;
      }
      for (const owner of learnedPanelSources.values()) if (owner === panelId) return true;
      return false;
    }

    /** 当前所有被 retain 的非主视图来源（遍历会话列表，不写状态）。 */
    function collectRetainedSources(sessionCtx) {
      const sources = new Set();
      const byId = sessionSnapshot(sessionCtx)?.byId;
      if (byId === null || typeof byId !== 'object') return sources;
      for (const row of Object.values(byId)) {
        const retained = row?.retainedBy;
        if (retained === null || typeof retained !== 'object') continue;
        for (const [source, count] of Object.entries(retained)) {
          if (source === 'mainView' || !((count ?? 0) > 0)) continue;
          sources.add(source);
        }
      }
      return sources;
    }

    /**
     * 把「被某个面板来源 retain 的会话」记进归属记忆。
     *
     * 这是「面板关掉后仍能点通知打开它」的数据来源：面板挂载期间我们见过这条会话
     * 归它，之后 retain 释放了，记忆还在。
     */
    function recordPanelSessions(sessionCtx, panelId) {
      const byId = sessionSnapshot(sessionCtx)?.byId;
      if (byId === null || typeof byId !== 'object') return;
      for (const row of Object.values(byId)) {
        if (row === null || typeof row !== 'object') continue;
        if (typeof row.id !== 'string' || row.id.length === 0) continue;
        const retained = row.retainedBy;
        if (retained === null || typeof retained !== 'object') continue;
        let owned = false;
        for (const [source, count] of Object.entries(retained)) {
          if (source === 'mainView' || !((count ?? 0) > 0)) continue;
          if (ownerOfSource(source) === panelId) {
            owned = true;
            break;
          }
        }
        if (owned) rememberPanel(row.id, panelId);
      }
    }

    /**
     * 观察面板选择与会话 retain，学习「谁 retain 了面板里的会话」。
     *
     * 规则刻意保守：
     *   - 只在面板**刚被选中**（activePanelId 变化）之后的一小段时间内学习；
     *   - 学习那一刻先拍下已有来源的快照，只有**快照之后新出现**的来源才算；
     *   - 每个面板只学一条来源，且已有绑定就不再学（面板再次打开时右栏之类的
     *     来源不会被误绑）；
     *   - **显式注册的来源只归登记方**：学习不得把它改记到当前面板（否则登记方一
     *     注销，点击就会跳到错的面板）；
     *   - 激活那一刻只记基线不学习（面板的 retain 正常在下一帧才发生，宁可漏学
     *     退回旧行为，也不误绑）；
     *   - 来源绑定只存在本页面内存里，刷新后重新学习；跨刷新只保留精确到会话的
     *     归属记忆。
     *
     * @param {object} sessionCtx 已注入会话服务的上下文
     */
    function observePanelBindings(sessionCtx) {
      const active = activePanelId(sessionCtx);
      const currentSources = collectRetainedSources(sessionCtx);
      if (active !== observedPanelId) {
        observedPanelId = active;
        panelActivatedAt = Date.now();
        observedPanelSources = currentSources;
        if (active !== null) recordPanelSessions(sessionCtx, active);
        return;
      }
      if (active === null) {
        observedPanelSources = currentSources;
        return;
      }
      if (Date.now() - panelActivatedAt <= PANEL_LEARN_WINDOW_MS && !panelHasBinding(active)) {
        for (const source of currentSources) {
          if (observedPanelSources.has(source)) continue;
          // 显式注册优先：这条来源已经声明归属，学习不能覆盖或给它追加第二个面板
          if (registeredPanelSources.has(source)) continue;
          learnedPanelSources.set(source, active);
          diag('学到面板来源', source, '→', active);
          break;
        }
      }
      observedPanelSources = currentSources;
      recordPanelSessions(sessionCtx, active);
    }

    /**
     * 目标会话此刻应该落到哪个面板。
     *
     * @param {object} sessionCtx 已注入会话服务的上下文
     * @param {string} sessionId 目标会话
     * @returns {string|null} 面板 id；null 表示按原行为走主视图
     */
    function panelForSession(sessionCtx, sessionId) {
      const snapshot = sessionSnapshot(sessionCtx);
      const byId = snapshot?.byId;
      const row = byId !== null && typeof byId === 'object' ? byId[sessionId] : undefined;
      const listed = row !== null && typeof row === 'object';
      // 会话列表已就绪但找不到这条会话（已关闭/已删除）：保持旧行为，别去开一个空面板
      if (!listed && snapshot?.phase === 'ready') return null;

      const retained =
        listed && row.retainedBy !== null && typeof row.retainedBy === 'object' ? row.retainedBy : {};
      const owners = [];
      for (const [source, count] of Object.entries(retained)) {
        if (source === 'mainView' || !((count ?? 0) > 0)) continue;
        const owner = ownerOfSource(source);
        if (owner !== null) owners.push(owner);
      }
      const active = activePanelId(sessionCtx);
      if (owners.length > 0) {
        // 当前打开的面板正 retain 着它：优先回到这个面板（哪怕主视图也还 retain 着）
        if (active !== null && owners.includes(active)) return active;
        // 主视图也 retain 着它：主视图才是它此刻显示的地方，保持旧行为
        if ((retained.mainView ?? 0) > 0) return null;
        return owners[0];
      }
      if ((retained.mainView ?? 0) > 0) return null;
      // 面板已经关掉（retain 已释放）：用上次观察到的归属把它重新打开
      return rememberedPanelFor(sessionId);
    }

    /**
     * 激活面板并（可选）让面板切到目标会话。
     *
     * 任何一步不成立都返回 false，由调用方退回「揭示目标 / 主视图」的老路径——
     * 点击绝不能变成没反应或抛错。
     *
     * @returns {boolean} 是否已经把面板切到前台
     */
    function focusPanel(sessionCtx, panelId, sessionId) {
      const layout = serviceOf(sessionCtx, 'layout');
      if (layout === undefined || layout === null || typeof layout.selectPanel !== 'function') return false;
      try {
        if (typeof layout.hasMainPanel === 'function' && layout.hasMainPanel(panelId) !== true) {
          diag('面板未注册，退回主视图', panelId);
          forgetRememberedPanel(sessionId);
          return false;
        }
      } catch {
        // 老版本没有这个探测：交给 selectPanel 自己判断
      }
      try {
        layout.selectPanel(panelId);
      } catch (error) {
        diag('激活面板失败，退回主视图', panelId, String(error?.message ?? error));
        forgetRememberedPanel(sessionId);
        return false;
      }
      const sessionClaims = registeredPanels.get(panelId);
      const showSession = sessionClaims === undefined ? undefined : lastValue(sessionClaims);
      if (typeof showSession === 'function') {
        try {
          showSession(sessionId);
        } catch (error) {
          // 面板已经打开了：回调失败只记诊断，不再跳主视图造成二次导航
          diag('面板 showSession 失败', String(error?.message ?? error));
        }
      }
      rememberPanel(sessionId, panelId);
      return true;
    }

    /** 撤销一个注册句柄对某条来源的声明（同一个来源的其它句柄、以及更早的注册都保留）。 */
    function releaseSourceClaim(source, token) {
      const claims = registeredPanelSources.get(source);
      if (claims === undefined || claims.delete(token) !== true) return;
      if (claims.size === 0) registeredPanelSources.delete(source);
    }

    /** 撤销一个注册句柄对某面板 showSession 的声明。 */
    function releasePanelSession(panelId, token) {
      const claims = registeredPanels.get(panelId);
      if (claims === undefined || claims.delete(token) !== true) return;
      if (claims.size === 0) registeredPanels.delete(panelId);
    }

    /**
     * 显式注册一个面板（可选契约，见 docs/development.md#实现要点）。
     *
     * 自动学习已经覆盖常见情况；这条通路给「一个面板管多条会话」「来源名动态」
     * 或想自己实现「切到某条会话」的面板用。返回注销函数。
     *
     * 每次调用是一个独立句柄：同一个面板重复注册（插件热重载、宿主重复挂载）
     * 不会产生第二条来源声明，注销也只撤掉自己那份。
     *
     * @param {{ panelId?: string, source?: string, sources?: string[], showSession?: (sessionId: string) => void }} entry
     * @returns {() => void}
     */
    function registerPanel(entry) {
      const panelId = typeof entry?.panelId === 'string' && entry.panelId.length > 0 ? entry.panelId : null;
      if (panelId === null) return () => {};
      const rawSources = Array.isArray(entry?.sources) ? entry.sources : [entry?.source];
      const sources = [
        ...new Set(
          rawSources.filter(
            (source) => typeof source === 'string' && source.length > 0 && source !== 'mainView',
          ),
        ),
      ];
      const showSession = typeof entry?.showSession === 'function' ? entry.showSession : undefined;
      const token = Symbol('awayNotifyPanel');
      if (showSession !== undefined) {
        const claims = registeredPanels.get(panelId) ?? new Map();
        claims.set(token, showSession);
        registeredPanels.set(panelId, claims);
      }
      for (const source of sources) {
        // 显式注册优先：这条来源如果被自动学习猜给了别的面板，丢掉那条猜测。
        // 否则登记方一注销，点击就会退回猜测指向的面板（错的那个）。
        const learnedOwner = learnedPanelSources.get(source);
        if (learnedOwner !== undefined && learnedOwner !== panelId) {
          learnedPanelSources.delete(source);
          diag('显式注册取代自动学习', source, learnedOwner, '→', panelId);
        }
        const claims = registeredPanelSources.get(source) ?? new Map();
        claims.set(token, panelId);
        registeredPanelSources.set(source, claims);
      }
      diag('面板已显式注册', panelId, sources);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const source of sources) releaseSourceClaim(source, token);
        releasePanelSession(panelId, token);
      };
    }

    /**
     * 把注册表暴露成客户端 cordis 服务，供面板插件（同为浏览器半部）显式注册。
     * 服务名与宿主侧的 `awayNotify` 区分开：两边是不同容器，互不影响。
     */
    function providePanelRegistry(ctx) {
      try {
        const reflect = ctx?.reflect;
        if (reflect === undefined || reflect === null || typeof reflect.provide !== 'function') return;
        const dispose = reflect.provide('awayNotifyPanels', {
          version: 1,
          register: (entry) => registerPanel(entry),
        });
        if (typeof dispose === 'function') {
          try {
            ctx.effect(() => dispose, 'dsh-away-notify: panel registry');
          } catch {
            /* ignore */
          }
        }
      } catch (error) {
        diag('提供 awayNotifyPanels 服务失败', String(error?.message ?? error));
      }
    }

    /**
     * 用户此刻「正在看」的全部会话 id —— 上报给宿主的就是这个集合。
     *
     * 基础是主视图那条（`currentSessionId`）。主区域被插件面板占据时，再把面板
     * retain 的会话加进来：面板里的会话（super-agent 的 Router）匹配不上主视图，
     * 不补这一条的话它跑完一轮就误弹通知，即使你就盯着它看。
     *
     * 面板没开时**完全保持旧行为**（只报主视图那条），不会因为「某插件在后台
     * retain 了某条会话」而多静音。
     *
     * @param {object} sessionCtx 已注入会话服务的上下文
     * @returns {string[]} 去重后的会话 id 列表；空数组表示无法归因
     */
    function attendedSessionIds(sessionCtx) {
      const ids = [];
      const main = currentSessionId(sessionCtx);
      if (typeof main === 'string' && main.length > 0) ids.push(main);
      if (activePanelId(sessionCtx) !== null) {
        try {
          const byId = sessionSnapshot(sessionCtx)?.byId;
          if (byId !== null && typeof byId === 'object') {
            // 配置的后备清单 + 显式注册 + 自动学习到的面板来源（见 effectivePanelSources）
            const panelSources = effectivePanelSources();
            for (const row of Object.values(byId)) {
              if (row === null || typeof row !== 'object') continue;
              if (typeof row.id !== 'string' || row.id.length === 0) continue;
              const retained = row.retainedBy;
              if (retained === null || typeof retained !== 'object') continue;
              // retainedBy 是 { source: 引用计数 }；命中任一面板来源即视为面板里显示着
              if (Object.keys(retained).some((source) => (retained[source] ?? 0) > 0 && panelSources.has(source))) {
                ids.push(row.id);
              }
            }
          }
        } catch {
          // 拿不到会话列表就退回「只报主视图那条」，与改动前一致
        }
      }
      return [...new Set(ids)];
    }

    /**
     * 取「切换查看会话」的可调用 API，按 dsh 版本回退。
     *
     * - 0.1.6：`sessions.open(id)`。
     * - 0.1.7：sessions 控制器上已无 `open`；视图选择归 uiWorkspace 服务，
     *   对应 `uiWorkspace.openSession(id)`（内部走 replaceMain(..., "reveal")）。
     *
     * 返回 undefined 表示当前环境下两者都不可用——调用方应重试/放弃，而不是
     * 假装已经切过去了。uiWorkspace 可能晚于 sessions 就绪，所以这里每次现取。
     */
    function resolveSessionOpener(sessionCtx) {
      const asOpener = (candidate) => {
        try {
          if (candidate && typeof candidate.openSession === 'function') {
            return (id) => candidate.openSession(id);
          }
        } catch {
          /* ignore */
        }
        return undefined;
      };

      // 0.1.6 通路
      try {
        if (typeof sessionCtx?.sessions?.open === 'function') {
          return (id) => sessionCtx.sessions.open(id);
        }
      } catch {
        /* ignore */
      }

      // 0.1.7 通路（inject 回调拿到的服务实例）
      const injected = asOpener(workspaceService);
      if (injected !== undefined) return injected;

      // 0.1.7 通路（当场向 ctx 要；ctx.get 在服务缺失/未注入时可能抛）
      try {
        if (typeof sessionCtx?.get === 'function') {
          const viaGet = asOpener(sessionCtx.get('uiWorkspace'));
          if (viaGet !== undefined) return viaGet;
        }
      } catch {
        /* ignore */
      }

      let direct;
      try {
        direct = sessionCtx?.uiWorkspace;
      } catch {
        direct = undefined;
      }
      return asOpener(direct);
    }

    /**
     * 上报一次在场状态。任何失败都被吞掉——上报绝不影响页面本身。
     * `visible` 与 `focused` 分开上报，宿主据此区分「切到别的标签页」和
     * 「标签页可见但焦点在别的应用」。
     */
    function report(sessionCtx) {
      try {
        // 先更新「面板归属」观察（面板激活后新出现的 retain 来源 → 面板），
        // 下面上报的面板会话和点击落点都依赖它。
        observePanelBindings(sessionCtx);
        // 主视图 + 面板里正在显示的会话（见 attendedSessionIds）
        const sessionIds = attendedSessionIds(sessionCtx);
        const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
        const focused =
          typeof document !== 'undefined' && typeof document.hasFocus === 'function'
            ? document.hasFocus()
            : false;
        // 会话 id 拿不到也要上报：宿主会退化为「页面级在场」判定
        if (sessionIds.length === 0 && !warnedNoSession) {
          warnedNoSession = true;
          diag('拿不到会话 id，退化为页面级在场判定（可见=', visible, '焦点=', focused, '）');
        }
        if (sessionIds.length > 0) warnedNoSession = false;
        // `sessionId` 保留第一条（主视图优先）：旧宿主只认这个字段，行为与改动前相同；
        // 新宿主按 `sessionIds` 匹配，面板里那条也一并算「在场」。
        const payload = sessionIds.length === 0
          ? { op: 'presence', clientId: CLIENT_ID, visible, focused }
          : { op: 'presence', clientId: CLIENT_ID, sessionId: sessionIds[0], sessionIds, visible, focused };

        // 去重节流：相同载荷在心跳周期内只发一次
        const key = `${sessionIds.join(',')}|${visible}|${focused}`;
        const now = Date.now();
        if (key === lastPayloadKey && now - lastSentAt < HEARTBEAT_MS) return;
        lastPayloadKey = key;
        lastSentAt = now;

        const pending = fetch(PRESENCE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (error) {
        diag('上报异常', String(error?.message ?? error));
      }
    }

    /**
     * 取服务：`ctx.get` 在服务缺失/未注入时会抛，所以统一包一层。
     */
    function serviceOf(sessionCtx, name) {
      try {
        if (typeof sessionCtx?.get === 'function') return sessionCtx.get(name);
      } catch {
        /* ignore */
      }
      try {
        return sessionCtx?.[name];
      } catch {
        return undefined;
      }
    }

    /**
     * 把「揭示目标」资源开在右栏。
     *
     * 这是点击回跳的优先通路：插件（如 btw-sidebar）在宿主侧声明了
     * `reveal: { resource: 'dsh-resource://…' }`，这里就让右栏去开它——**目标 tab 已经
     * 开着时会聚焦它而不是重复开一个**（右栏按 contentId 查重）。任何一步不成立都返回
     * false，调用方随即退回「切到主视图那条会话」的旧行为。
     *
     * 注意它只能开在**右栏此刻挂载的那条会话**里（`openResource` 内部走 mounted
     * binding）。跨会话的揭示必须先切主视图，见 `revealInRightSidebar`。
     *
     * @param {object} sessionCtx - 已注入会话服务的上下文。
     * @param {string} address - `dsh-resource://…` 地址。
     * @returns {boolean} 是否已交给右栏处理。
     */
    function openInRightSidebar(sessionCtx, address) {
      const sidebar = sidebarRightService ?? serviceOf(sessionCtx, 'sidebarRight');
      if (sidebar === undefined || typeof sidebar.openResource !== 'function') return false;
      try {
        sidebar.openResource(address);
        return true;
      } catch (error) {
        // 没有 tab 类型认领该地址、或右栏自身拒绝：退回主视图，别把点击变成没反应
        diag('右栏打开揭示目标失败，退回主视图', String(error?.message ?? error));
        return false;
      }
    }

    /**
     * 右栏此刻挂载的会话 id。
     *
     * 三态：字符串 = 挂载中的会话；`null` = 服务有这个可观察量但还没有 seat 挂载
     * （页面刚加载时的常见状态）；`undefined` = 老版本服务没有这个可观察量（只能靠
     * 「主视图在看谁」退而求其次）。
     */
    function sidebarMountedSession(sessionCtx) {
      const sidebar = sidebarRightService ?? serviceOf(sessionCtx, 'sidebarRight');
      try {
        const mounted = sidebar?.mounted;
        if (mounted === undefined || typeof mounted.getSnapshot !== 'function') return undefined;
        const value = mounted.getSnapshot();
        return typeof value === 'string' && value.length > 0 ? value : null;
      } catch {
        return undefined;
      }
    }

    /** 可等待的一小步。 */
    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * 按揭示目标回到右栏——**必要时先把主视图切回它的归属会话**。
     *
     * 为什么必须切：右栏的状态是**按主视图会话分域**的
     * （`dsh-client-ui-sidebar-right` 的 `bySession[sessionId]`，每个动作都带
     * sessionId），而 `sidebarRight.openResource(address)` 只作用于**当前挂载**的
     * 那条会话。你在 B 里点一条属于 A 的右栏会话的通知时，不切回 A 就会把 tab 开进
     * B 的右栏：左侧主会话仍是 B，tab 出现在 B 的侧栏里；并且因为资源注册表按地址
     * 引用计数（`dsh-client-resources` 的 `records.set(address)` + `holders`），同一
     * 地址在 A、B 各有一个 tab 时，只关 A 的那个不会中止资源流，会话也就不会归档。
     *
     * 切过去之后要等右栏**真的挂载到目标会话**再开（`sidebarRight.mounted`），否则
     * 又落回旧会话。等不到就如实返回 false，由调用方按老规矩退回「切到主视图那条会话」。
     *
     * @param {object} sessionCtx - 已注入会话服务的上下文。
     * @param {{ resource?: string, mainSessionId?: string }} reveal - 宿主转发的揭示目标。
     * @returns {Promise<boolean>} 右栏是否已受理（false 时调用方退回主视图，别让点击没反应）。
     */
    async function revealInRightSidebar(sessionCtx, reveal) {
      const resource = reveal?.resource;
      if (typeof resource !== 'string' || resource.length === 0) return false;
      const sidebar = sidebarRightService ?? serviceOf(sessionCtx, 'sidebarRight');
      if (sidebar === undefined || typeof sidebar.openResource !== 'function') return false;

      const owner =
        typeof reveal?.mainSessionId === 'string' && reveal.mainSessionId.length > 0
          ? reveal.mainSessionId
          : undefined;
      if (owner === undefined) return openInRightSidebar(sessionCtx, resource);

      // 可以直接开的情况：右栏**已经挂在归属会话上**；或老版本服务没有 mounted
      // 可观察量时，退而确认主视图已在归属会话。注意 `null`（有观察量但还没挂载，
      // 例如页面刚加载）不算「已就绪」——那正是需要等一等的时候。
      const mountedAtStart = sidebarMountedSession(sessionCtx);
      if (
        mountedAtStart === owner ||
        (mountedAtStart === undefined && currentSessionId(sessionCtx) === owner)
      ) {
        return openInRightSidebar(sessionCtx, resource);
      }

      const deadline = Date.now() + REVEAL_TIMEOUT_MS;
      /** 主视图是否已经（或已经发出切换）在归属会话上；之后只等右栏挂载过去。 */
      let navigated = false;
      for (;;) {
        if (!navigated) {
          if (currentSessionId(sessionCtx) === owner) {
            // 主视图已经在归属会话上（页面刚加载时的常见情况）：不需要再切，只等右栏 bind。
            navigated = true;
          } else {
            // 切换 API 可能比 sessions 晚就绪，所以每轮现取而不是一次性判断。
            const open = resolveSessionOpener(sessionCtx);
            if (open !== undefined) {
              try {
                open(owner);
                navigated = true;
                diag('揭示目标归属', owner, '：已切回主视图');
              } catch (error) {
                diag('切回归属会话失败', String(error?.message ?? error));
              }
            }
          }
        }
        if (navigated) {
          const mounted = sidebarMountedSession(sessionCtx);
          // seat 已经 bind 到归属会话：此刻打不开就是真的打不开（没有 tab 类型认领这个
          // 地址、右栏自己拒绝），再等也不会变。
          if (mounted === owner) return openInRightSidebar(sessionCtx, resource);
          // mounted 拿不到（老版本服务）时退化为看主视图是否已经切过去，再试开。
          if (mounted === undefined && currentSessionId(sessionCtx) === owner && openInRightSidebar(sessionCtx, resource)) {
            return true;
          }
        }
        if (Date.now() >= deadline) break;
        await delay(REVEAL_POLL_MS);
      }
      diag('未能等到归属会话的右栏挂载，放弃在右栏打开', owner);
      return false;
    }

    /** 当前页面是否可见且有焦点。 */
    function isVisibleAndFocused() {
      const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
      const focused =
        typeof document !== 'undefined' && typeof document.hasFocus === 'function'
          ? document.hasFocus()
          : false;
      return visible && focused;
    }

    /** 把某个会话切到前台，必要时等会话列表就绪。 */
    function switchTo(sessionCtx, target, { giveUpWhenReady = true } = {}) {
      let tries = 0;
      const attempt = () => {
        tries += 1;
        try {
          const snapshot = sessionCtx?.sessions?.list?.getSnapshot?.();
          const listed =
            snapshot?.byId !== undefined && Object.prototype.hasOwnProperty.call(snapshot.byId, target);
          if (listed) {
            const open = resolveSessionOpener(sessionCtx);
            if (open !== undefined) {
              open(target);
              diag('已切到目标会话', target);
              return true;
            }
            // 会话已就绪但切换 API 还没就绪（例如 uiWorkspace 注入晚一步）：继续重试
            diag('会话在列表中，但切换 API 尚未就绪，稍后重试', target);
          } else if (giveUpWhenReady && snapshot?.phase === 'ready') {
            diag('目标会话不在列表中，放弃', target);
            return false;
          }
        } catch {
          /* ignore */
        }
        if (tries < 40) setTimeout(attempt, 250);
        return false;
      };
      return attempt();
    }

    /**
     * 取一次宿主记录的「待跳转会话」并切过去。
     *
     * 这是点击 Toast 回到正确会话的**主通路**：token 换 cookie 的 303 会丢掉 URL
     * 参数，所以不能依赖 `?dshAwayNotifyFocus=`。改为每次页面加载 / 重新获得焦点
     * 时向宿主索取，取到后回执清除。
     */
    async function consumePendingFocus(sessionCtx) {
      if (sessionCtx === undefined || sessionCtx === null) return;
      let data = null;
      try {
        const res = await fetch(PRESENCE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'pending-focus' }),
        });
        data = res && res.ok ? await res.json() : null;
      } catch {
        return;
      }
      const target = data?.sessionId;
      if (typeof target !== 'string' || target.length === 0) return;
      // 点击可能发生在页面失焦后回来时，列表订阅未必已经跑过；这里现观察一次
      observePanelBindings(sessionCtx);
      if (currentSessionId(sessionCtx) === target) {
        // 已经在目标会话上，直接回执即可
        ackFocus(target);
        return;
      }
      // 通路一：目标会话正被某个主区域面板 retain —— 激活那个面板。
      // 不能走 uiWorkspace.openSession：它内部会 selectPanel(null)，把面板关掉，
      // 这就是「点通知落到主视图」的根因。面板关着时靠归属记忆重新打开它。
      const panelId = panelForSession(sessionCtx, target);
      if (panelId !== null && focusPanel(sessionCtx, panelId, target)) {
        diag('已激活目标会话所在的面板', panelId, target);
        ackFocus(target);
        return;
      }
      // 通路二：触发通知的插件声明过「这条会话属于右栏某个 tab」——把它开在
      // 右栏（已在右栏则聚焦那个 tab），而不是在主视图里新开一条会话。揭示目标带
      // 归属会话时会先切主视图（右栏按会话分域，见 revealInRightSidebar）。
      const reveal = data?.reveal;
      if (reveal !== null && typeof reveal === 'object' && typeof reveal.resource === 'string' && reveal.resource.length > 0) {
        if (await revealInRightSidebar(sessionCtx, reveal)) {
          diag('已按揭示目标在右栏打开', reveal.resource);
          ackFocus(target);
          return;
        }
      }
      switchTo(sessionCtx, target, { giveUpWhenReady: false });
      ackFocus(target);
    }

    function ackFocus(sessionId) {
      fetch(PRESENCE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'ack-focus', sessionId }),
      }).catch(() => {});
    }

    /**
     * 兼容路径：页面带 `?dshAwayNotifyFocus=<id>` 打开时切过去。
     * 注意当前 dsh 的 token 换取流程会 303 到 `/` 丢掉查询参数，所以这条通常不生效，
     * 真正的通路是上面的 `consumePendingFocus`。保留它以防将来前端/鉴权行为变化。
     */
    function focusFromUrl(sessionCtx) {
      if (typeof location === 'undefined' || typeof history === 'undefined') return;
      let target;
      try {
        target = new URLSearchParams(location.search).get(FOCUS_PARAM);
      } catch {
        return;
      }
      if (typeof target !== 'string' || target.length === 0) return;
      diag('检测到 URL 回跳目标会话', target);

      // 立刻从地址栏移除，避免刷新时重复触发、也避免 token 残留在浏览器历史里
      try {
        const clean = new URL(location.href);
        clean.searchParams.delete(FOCUS_PARAM);
        history.replaceState(history.state, '', clean.toString());
      } catch {
        /* ignore */
      }
      // 与 consumePendingFocus 同一落点规则：面板里的会话优先激活面板
      const panelId = panelForSession(sessionCtx, target);
      if (panelId !== null && focusPanel(sessionCtx, panelId, target)) {
        diag('URL 回跳：已激活目标会话所在的面板', panelId, target);
        return;
      }
      switchTo(sessionCtx, target);
    }

    // ── 窗口标题 tag ───────────────────────────────────────────────────────
    //
    // 标题由 dsh-client-ui-layout 拥有（它在会话切换时整体重写 document.title），
    // 所以这里不能只写一次：用 MutationObserver 在每次被覆盖后重新补上后缀。
    // applyTitleTag 自身幂等（已带后缀就直接返回），不会和观察者打成死循环。
    let titleTagOn = false;
    let titleObserver = null;

    function applyTitleTag() {
      if (!titleTagOn || TITLE_TAG === '') return;
      try {
        const current = document.title;
        if (typeof current !== 'string' || current.endsWith(TITLE_TAG)) return;
        document.title = current + TITLE_TAG;
      } catch {
        /* ignore */
      }
    }

    function setTitleTag(on) {
      if (on === titleTagOn) return;
      titleTagOn = on;
      try {
        if (on) {
          applyTitleTag();
          if (titleObserver === null && typeof MutationObserver === 'function') {
            const root = document.head ?? document.documentElement;
            if (root) {
              titleObserver = new MutationObserver(applyTitleTag);
              titleObserver.observe(root, { childList: true, subtree: true, characterData: true });
            }
          }
        } else {
          if (titleObserver !== null) {
            titleObserver.disconnect();
            titleObserver = null;
          }
          if (TITLE_TAG !== '' && typeof document.title === 'string' && document.title.endsWith(TITLE_TAG)) {
            document.title = document.title.slice(0, -TITLE_TAG.length);
          }
        }
      } catch {
        /* ignore */
      }
    }

    /**
     * 问宿主要「浏览器半部相关的配置」：标题 tag 与面板会话来源。
     *
     * 取不到时**保持默认值**：宿主的聚焦脚本默认也要求 tag，两边默认一致才不会
     * 出现「脚本等 tag、页面没打」而每次都退化去新开标签页的情况；面板来源同理，
     * 默认值与 `host.js` 的 DEFAULTS 一致。
     */
    function loadHostConfig() {
      fetch(PRESENCE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'config' }),
      })
        .then((res) => (res && res.ok ? res.json() : null))
        .then((data) => {
          if (data && typeof data.titleTag === 'boolean') setTitleTag(data.titleTag);
          if (data && Array.isArray(data.panelSessionSources)) {
            panelSessionSources = data.panelSessionSources.filter(
              (source) => typeof source === 'string' && source.length > 0,
            );
          }
        })
        .catch(() => {});
    }

    function apply(ctx) {
      diag('apply 被调用', {
        visibility: typeof document !== 'undefined' ? document.visibilityState : 'no-document',
        hasEffect: typeof ctx.effect,
      });

      // 标题 tag 先无条件打开（与宿主聚焦脚本的默认一致），再按宿主配置决定去留
      setTitleTag(true);
      loadHostConfig();
      // 可选契约：面板插件可以显式注册「面板 id + retain 来源 + 切会话回调」
      providePanelRegistry(ctx);

      // 会话就绪后才有值的上下文；DOM 监听不依赖它
      let sessionCtx;

      /** 常规上报。 */
      const onChange = () => report(sessionCtx);

      /**
       * 回到前台/页面时：先上报，再尝试取一次「待跳转会话」。
       * 这样即使浏览器只是**聚焦已有窗口**（没有重新加载页面），也能完成跳转。
       */
      const onRegain = () => {
        report(sessionCtx);
        if (isVisibleAndFocused()) consumePendingFocus(sessionCtx);
      };

      const domTargets = [];
      const bind = (target, type, handler) => {
        target.addEventListener(type, handler);
        domTargets.push([target, type, handler, false]);
      };
      if (typeof document !== 'undefined') {
        bind(document, 'visibilitychange', onRegain);
      }
      if (typeof window !== 'undefined') {
        for (const type of ['focus', 'pageshow']) bind(window, type, onRegain);
        for (const type of ['blur', 'pagehide']) bind(window, type, onChange);
      }

      // sessions 就绪后接管：订阅列表变化 + 首次上报 + 处理回跳
      let unsubscribeList;
      let unsubscribePanel;
      try {
        ctx.inject(['sessions'], (c) => {
          sessionCtx = c;
          diag('sessions 已就绪', {
            hasList: !!c.sessions?.list,
            phase: (() => {
              try {
                return c.sessions?.list?.getSnapshot?.()?.phase;
              } catch (error) {
                return `throw:${String(error?.message ?? error)}`;
              }
            })(),
          });
          try {
            unsubscribeList = c.sessions?.list?.subscribe?.(onChange);
          } catch {
            /* ignore */
          }
          // 面板切换立刻观察一次：面板的 retain 发生在挂载之后，先把激活时刻
          // 与「已有来源」拍下来，才能把随后新出现的来源认成这个面板的。
          try {
            const panelInfo = serviceOf(c, 'layout')?.panelInfo;
            if (panelInfo !== undefined && panelInfo !== null && typeof panelInfo.subscribe === 'function') {
              unsubscribePanel = panelInfo.subscribe(() => {
                observePanelBindings(c);
                onChange();
              });
            }
          } catch (error) {
            diag('订阅面板选择失败', String(error?.message ?? error));
          }
          onChange();
          // 主通路：向宿主索取待跳转会话
          consumePendingFocus(c);
          // 兼容通路：URL 参数（当前鉴权流程会丢掉它）
          focusFromUrl(c);
        });
      } catch (error) {
        diag('注入 sessions 失败', String(error?.message ?? error));
      }

      // 0.1.7 的会话切换 API（见 resolveSessionOpener）。这个服务不存在时
      // inject 不会回调，属正常情况，绝不能因此阻塞 apply（这正是 inject 数组
      // 留空的原因）。晚于 sessions 就绪也没关系：切换时现取。
      try {
        ctx.inject(['uiWorkspace'], (w) => {
          workspaceService = w?.uiWorkspace ?? w;
          diag('uiWorkspace 已就绪（0.1.7 会话切换通路可用）');
        });
      } catch (error) {
        diag('注入 uiWorkspace 失败', String(error?.message ?? error));
      }

      // 右栏服务：只用于「点击通知 → 回到插件自己的面板 tab」（reveal），
      // 缺失时退回主视图。同样是可选注入。
      try {
        ctx.inject(['sidebarRight'], (s) => {
          sidebarRightService = s?.sidebarRight ?? s;
          diag('sidebarRight 已就绪（揭示目标可开在右栏）');
        });
      } catch (error) {
        diag('注入 sidebarRight 失败', String(error?.message ?? error));
      }

      const timer = setInterval(onChange, HEARTBEAT_MS);

      ctx.effect(
        () => () => {
          clearInterval(timer);
          try {
            setTitleTag(false);
          } catch {
            /* ignore */
          }
          try {
            unsubscribeList?.();
          } catch {
            /* ignore */
          }
          try {
            unsubscribePanel?.();
          } catch {
            /* ignore */
          }
          for (const [target, type, handler, capture] of domTargets) {
            try {
              target.removeEventListener(type, handler, capture);
            } catch {
              /* ignore */
            }
          }
        },
        'dsh-away-notify: presence reporting',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    diag('bundle 求值完毕，导出已就绪');
    return module.exports;
  },
});
