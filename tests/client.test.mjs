/**
 * client.test.mjs — 在最小 DOM 桩上加载浏览器半部，验证 bundle 契约与运行时行为。
 * 这能在不开浏览器的情况下抓到 client.js 的语法/运行时错误。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const PRESENCE_PATH = '/api/dsh-away-notify';
const FOCUS_PARAM = 'dshAwayNotifyFocus';

/** 建立最小 DOM 桩并加载 client.js，返回其导出。 */
async function loadClientModule({
  search = '',
  pendingFocusReply = null,
  reveal = null,
  titleTagReply,
  configReply,
  panelMemory,
} = {}) {
  const listeners = [];
  const registrations = [];
  const observerInstances = [];

  const documentStub = {
    visibilityState: 'visible',
    hasFocus: () => true,
    title: '我的会话 — DeepSeek Harness',
    head: {},
    addEventListener: (type, handler) => listeners.push(['document', type, handler]),
    removeEventListener: (type, handler) => {
      const i = listeners.findIndex(([t, ty, h]) => t === 'document' && ty === type && h === handler);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  /** 可手动触发的 MutationObserver 替身：Node 里没有 DOM 的这一个。 */
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observerInstances.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      this.callback();
    }
  }

  const windowStub = {
    __ModuleLoader__: {
      load: (registration) => registrations.push(registration),
    },
    addEventListener: (type, handler) => listeners.push(['window', type, handler]),
    removeEventListener: (type, handler) => {
      const i = listeners.findIndex(([t, ty, h]) => t === 'window' && ty === type && h === handler);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  const fetchCalls = [];
  /** pending-focus 的应答由测试随时改写（模拟「现在才点通知」）。 */
  const focusReply = { sessionId: pendingFocusReply, reveal };
  /** localStorage 替身：面板归属记忆持久化测试要能预置 / 观察。 */
  const storageData = new Map();
  if (panelMemory !== undefined) {
    storageData.set('dshAwayNotify.panelMemory.v1', JSON.stringify(panelMemory));
  }
  const storage = {
    getItem: (key) => (storageData.has(key) ? storageData.get(key) : null),
    setItem: (key, value) => storageData.set(key, String(value)),
    removeItem: (key) => storageData.delete(key),
    snapshot: () => Object.fromEntries(storageData),
  };
  const replaced = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    fetch: globalThis.fetch,
    MutationObserver: globalThis.MutationObserver,
    localStorage: globalThis.localStorage,
  };

  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.localStorage = storage;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    let reqBody = {};
    try {
      reqBody = JSON.parse(init?.body ?? '{}');
    } catch {
      /* ignore */
    }
    // 宿主的 pending-focus / config 应答由测试控制
    let payload = { ok: true };
    if (reqBody.op === 'pending-focus') payload = { ok: true, sessionId: focusReply.sessionId, reveal: focusReply.reveal };
    else if (reqBody.op === 'config' && configReply !== undefined) payload = { ok: true, ...configReply };
    else if (reqBody.op === 'config' && titleTagReply !== undefined) {
      payload = { ok: true, titleTag: titleTagReply };
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
  globalThis.location = {
    search,
    href: `http://127.0.0.1:3081/${search}`,
    port: '3081',
    protocol: 'http:',
  };
  globalThis.history = { state: null, replaceState: () => {} };

  // 每次都要重新求值模块（client.js 顶层有副作用）
  const url = new URL('../lib/client.js', import.meta.url);
  url.searchParams.set('t', String(Math.random()));
  await import(url.href);

  const registration = registrations.at(-1);
  const clientModule = registration.factory(() => {
    throw new Error('客户端 bundle 不应 require 任何模块');
  });

  return {
    registration,
    clientModule,
    listeners,
    fetchCalls,
    documentStub,
    windowStub,
    observerInstances,
    storage,
    /** 模拟「宿主刚刚记下待跳转会话」（点击通知后浏览器半部才来取）。 */
    setPendingFocus: (sessionId, nextReveal = null) => {
      focusReply.sessionId = sessionId;
      focusReply.reveal = nextReveal;
    },
    /** 模拟 dsh-client-ui-layout 重写 document.title，然后触发观察者。 */
    overwriteTitle: (next) => {
      documentStub.title = next;
      for (const o of observerInstances) if (!o.disconnected) o.trigger();
    },
    restore: () => {
      globalThis.window = replaced.window;
      globalThis.document = replaced.document;
      globalThis.location = replaced.location;
      globalThis.history = replaced.history;
      globalThis.fetch = replaced.fetch;
      globalThis.MutationObserver = replaced.MutationObserver;
      globalThis.localStorage = replaced.localStorage;
    },
  };
}

function makeClientCtx({
  current = 's1',
  byId = { s1: {}, s2: {} },
  phase = 'ready',
  sessionsOpen = true,
  withWorkspace = false,
  sidebar = 'none',
  autoMountSession = false,
  mountedInitial = 's1',
  withoutMountedObservable = false,
  panel = null,
  /** 是否提供布局服务。默认沿用旧行为：只有传了 panel 才算「布局存在」。 */
  layout = panel !== null,
  /** `selectPanel` 行为：'ok' 正常，'throws' 模拟面板未注册 / 版本不兼容。 */
  selectPanelMode = 'ok',
  /** 提供 `hasMainPanel` 时，只有这些面板 id 算已注册。 */
  registeredPanels = null,
} = {}) {
  const opened = [];
  const openedViaWorkspace = [];
  const openedResources = [];
  /** 每次 openResource 时右栏挂载的会话；用来断言「没开错会话」。 */
  const openedMounts = [];
  const subscribed = [];
  const injectedDeps = [];
  const disposers = [];
  const state = { current, byId, phase };
  /** 右栏挂载会话的可观察量替身（sidebarRight.mounted）。 */
  const mountState = { current: mountedInitial };
  const noteOpen = (id) => {
    if (!autoMountSession) return;
    // 主视图切换是同步的；右栏 seat 随后 bind。测试里默认让它立即跟上。
    state.current = id;
    mountState.current = id;
  };
  const sessions = {
    list: {
      getSnapshot: () => ({ ...state }),
      subscribe: (fn) => {
        subscribed.push(fn);
        return () => {};
      },
    },
  };
  // dsh 0.1.7 的 ClientSessions 上已无 open；sessionsOpen:false 用来模拟它
  if (sessionsOpen) sessions.open = (id) => { opened.push(id); noteOpen(id); };
  const ctx = {
    sessions,
    // 生产代码用 ctx.inject([...], cb) 在服务就绪后接管；
    // 这里同步回调，模拟「服务已就绪」。
    inject: (deps, cb) => {
      injectedDeps.push(deps);
      cb(ctx);
    },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
    },
    setCurrent: (id) => {
      state.current = id;
    },
    setMounted: (id) => {
      mountState.current = id;
    },
    opened,
    openedViaWorkspace,
    openedResources,
    openedMounts,
    subscribed,
    injectedDeps,
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
  };
  // dsh-client-ui-layout 的面板选择状态（`ctx.layout.panelInfo`）。null = 主区域是会话视图。
  ctx.selectedPanels = [];
  if (layout) {
    const panelState = { activePanelId: panel };
    const panelListeners = new Set();
    ctx.layout = {
      panelInfo: {
        getSnapshot: () => ({ ...panelState }),
        subscribe: (fn) => {
          panelListeners.add(fn);
          return () => panelListeners.delete(fn);
        },
      },
      selectPanel: (id) => {
        ctx.selectedPanels.push(id);
        if (selectPanelMode === 'throws') throw new Error('layout.selectPanel: main panel is not registered');
        panelState.activePanelId = id;
        for (const fn of [...panelListeners]) fn();
      },
    };
    if (Array.isArray(registeredPanels)) {
      ctx.layout.hasMainPanel = (id) => registeredPanels.includes(id);
    }
    /** 模拟用户点击侧栏面板按钮（不经过 selectPanel 记录，避免和点击落点混淆）。 */
    ctx.setPanel = (id) => {
      panelState.activePanelId = id;
      for (const fn of [...panelListeners]) fn();
    };
  } else {
    ctx.setPanel = () => {};
  }
  /** 替换会话列表（模拟面板挂载后 retain / 卸载后 release）。 */
  ctx.setById = (next) => {
    state.byId = next;
  };
  /** 插件提供的客户端服务（`ctx.reflect.provide`）。 */
  ctx.provided = {};
  ctx.reflect = {
    provide: (name, service) => {
      ctx.provided[name] = service;
      return () => {
        delete ctx.provided[name];
      };
    },
  };
  // dsh 0.1.7 的会话切换服务
  if (withWorkspace) {
    ctx.uiWorkspace = { openSession: (id) => { openedViaWorkspace.push(id); noteOpen(id); } };
  }
  // 右栏服务：`ok` 记录打开的地址；`throws` 模拟「没有 tab 类型认领这个地址」。
  // `mounted` 是官方服务上的可观察量（揭示跨会话时用来等它切过去）。
  const mountedObservable =
    withoutMountedObservable === true
      ? {}
      : {
          mounted: {
            getSnapshot: () => mountState.current,
            subscribe: () => () => {},
          },
        };
  if (sidebar === 'ok') {
    ctx.sidebarRight = {
      openResource: (address) => {
        openedMounts.push(mountState.current);
        openedResources.push(address);
      },
      ...mountedObservable,
    };
  } else if (sidebar === 'throws') {
    ctx.sidebarRight = {
      openResource: () => {
        throw new Error('sidebarRight: no registered tab type claims it');
      },
      ...mountedObservable,
    };
  }
  return ctx;
}

const loaded = [];
afterEach(() => {
  while (loaded.length > 0) {
    const l = loaded.pop();
    try {
      l.ctx?.dispose?.();
    } catch {
      /* ignore */
    }
    l.mod.restore();
  }
});

async function boot(options, ctxOptions) {
  const mod = await loadClientModule(options);
  const ctx = makeClientCtx(ctxOptions);
  mod.clientModule.apply(ctx);
  loaded.push({ mod, ctx });
  return { mod, ctx };
}

test('bundle 使用 __ModuleLoader__.load 且 id 正确', async () => {
  const mod = await loadClientModule();
  loaded.push({ mod });
  assert.equal(mod.registration.id, 'dsh-away-notify');
  assert.equal(typeof mod.registration.factory, 'function');
});

test('导出 apply 与 inject，且刻意不声明 inject 依赖（避免 apply 被阻塞）', async () => {
  const mod = await loadClientModule();
  loaded.push({ mod });
  assert.equal(typeof mod.clientModule.apply, 'function');
  assert.deepEqual(mod.clientModule.inject, [], 'inject 必须为空，否则 sessions 不可用时插件会完全静默');
});

test('apply 内部按需注入 sessions、uiWorkspace 与 sidebarRight（都不写进 inject 数组，避免被阻塞）', async () => {
  const { ctx } = await boot();
  assert.deepEqual(ctx.injectedDeps, [['sessions'], ['uiWorkspace'], ['sidebarRight']]);
});

test('apply 后立即上报一次 presence 到正确端点', async () => {
  const { mod } = await boot();
  assert.ok(mod.fetchCalls.length >= 1, '应至少上报一次');
  // 启动时还会先发一次 config（问宿主标题 tag 开关），所以按 op 定位而不是取第一条
  const call = mod.fetchCalls.find((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(call, '应至少上报一次 presence');
  assert.equal(call.url, PRESENCE_PATH);
  assert.equal(call.init.method, 'POST');
  const body = JSON.parse(call.init.body);
  assert.equal(body.op, 'presence');
  assert.equal(body.sessionId, 's1');
  assert.equal(body.visible, true);
  assert.equal(body.focused, true);
  assert.equal(typeof body.clientId, 'string');
  assert.ok(body.clientId.length > 0, '必须带 clientId，宿主才能按标签页记录在场状态');
});

test('所有上报带同一个 clientId（同一标签页内稳定）', async () => {
  const { mod } = await boot();
  mod.documentStub.visibilityState = 'hidden';
  mod.listeners.find(([t, ty]) => t === 'document' && ty === 'visibilitychange')[2]();
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  const ids = new Set(presence.map((c) => JSON.parse(c.init.body).clientId));
  assert.equal(ids.size, 1, '同一页面内 clientId 必须稳定');
});

test('注册 visibilitychange 与 window focus/blur 监听', async () => {
  const { mod } = await boot();
  const types = mod.listeners.map(([t, ty]) => `${t}:${ty}`);
  assert.ok(types.includes('document:visibilitychange'));
  assert.ok(types.includes('window:focus'));
  assert.ok(types.includes('window:blur'));
});

test('标签页不可见时上报 visible=false', async () => {
  const { mod } = await boot();
  mod.documentStub.visibilityState = 'hidden';
  const handler = mod.listeners.find(([t, ty]) => t === 'document' && ty === 'visibilitychange')[2];
  handler();
  const last = JSON.parse(mod.fetchCalls.at(-1).init.body);
  assert.equal(last.visible, false);
});

test('窗口失焦时上报 focused=false', async () => {
  const { mod } = await boot();
  mod.documentStub.hasFocus = () => false;
  const handler = mod.listeners.find(([t, ty]) => t === 'window' && ty === 'blur')[2];
  handler();
  const last = JSON.parse(mod.fetchCalls.at(-1).init.body);
  assert.equal(last.focused, false);
});

test('拿不到当前会话时退化为页面级上报（仍发请求，但不带 sessionId）', async () => {
  // 注意：必须传空串而不是 undefined —— 解构默认值会把 undefined 还原成 's1'
  const { mod } = await boot({}, { current: '' });
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(presence.length >= 1, '即使没有会话 id 也必须上报，否则宿主无法做页面级抑制');
  const body = JSON.parse(presence.at(-1).init.body);
  assert.equal(body.op, 'presence');
  assert.equal('sessionId' in body, false);
  assert.equal(body.visible, true);
  assert.equal(body.focused, true);
});

// ── dsh 0.1.7：视图选择搬出 sessions 控制器 ─────────────────────────────────

test('0.1.7：快照没有 current 时，用 retainedBy.mainView 判定正在看的会话', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: {
        s1: { id: 's1', retainedBy: { other: 2 } },
        s2: { id: 's2', retainedBy: { mainView: 1 } },
      },
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(presence.length >= 1, '仍应上报');
  assert.equal(JSON.parse(presence.at(-1).init.body).sessionId, 's2', '应以 mainView retain 的那条为准');
});

test('0.1.7：byId 里没有任何 mainView retain 时退化为页面级上报', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: {
        s1: { id: 's1', retainedBy: {} },
        s2: { id: 's2', retainedBy: { other: 3 } },
      },
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  const body = JSON.parse(presence.at(-1).init.body);
  assert.equal('sessionId' in body, false, '没有归因就不该编造一个会话 id');
});

test('0.1.7：retainedBy 结构缺失/异常时不会崩，退化为页面级', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: { s1: { id: 's1' }, s2: { id: 's2', retainedBy: null } },
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(presence.length >= 1);
  assert.equal('sessionId' in JSON.parse(presence.at(-1).init.body), false);
});

// ── 主区域被插件面板占据：面板里的会话也算「正在看」 ────────────────────────
//
// 真机场景：super-agent 的 Router 面板占着主区域，它用 `source: 'superAgentUi'`
// retain Router 会话；主视图那条仍然是上一次打开的会话。只报主视图那条的话，
// Router 跑完一轮就会误弹通知——即使你正盯着它看。

test('面板占着主区域时，把面板 retain 的会话一起上报', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router', retainedBy: { superAgentUi: 1 } },
        background: { id: 'background', retainedBy: {} },
      },
      panel: 'super-agent',
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  const body = JSON.parse(presence.at(-1).init.body);
  assert.equal(body.sessionId, 'main', 'sessionId 仍是主视图那条（旧宿主只认这个字段）');
  assert.deepEqual(body.sessionIds, ['main', 'router'], '面板里的会话必须一并报给宿主');
  assert.equal(body.sessionIds.includes('background'), false, '没被任何 UI retain 的会话不该混进来');
});

test('面板没开时只报主视图那条，不会因为后台 retain 多静音', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router', retainedBy: { superAgentUi: 1 } },
      },
      panel: null,
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  const body = JSON.parse(presence.at(-1).init.body);
  assert.deepEqual(body.sessionIds, ['main'], '面板关着时行为与改动前一致');
});

test('面板会话来源由宿主配置下发（默认值之外可扩展）', async () => {
  const { mod } = await boot(
    { configReply: { titleTag: true, panelSessionSources: ['myPanel'] } },
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        mine: { id: 'mine', retainedBy: { myPanel: 1 } },
        router: { id: 'router', retainedBy: { superAgentUi: 1 } },
      },
      panel: 'my-panel',
    },
  );
  // op:'config' 的应答是异步落地的：等它到达后再触发一次常规上报
  await new Promise((resolve) => setTimeout(resolve, 0));
  mod.listeners.find(([target, type]) => target === 'window' && type === 'focus')[2]();
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  const body = JSON.parse(presence.at(-1).init.body);
  assert.deepEqual(body.sessionIds, ['main', 'mine'], '宿主配的来源生效，默认值被替换');
});

test('布局服务缺失（老版本）时不报面板会话，也不崩', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router', retainedBy: { superAgentUi: 1 } },
      },
      panel: null,
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(presence.length >= 1);
  assert.deepEqual(JSON.parse(presence.at(-1).init.body).sessionIds, ['main']);
});

test('切换会话时通过 list.subscribe 立刻重报新会话', async () => {
  const { mod, ctx } = await boot();
  assert.equal(ctx.subscribed.length, 1, '应订阅会话列表');
  const before = mod.fetchCalls.length;
  ctx.setCurrent('s2');
  ctx.subscribed[0]();
  assert.ok(mod.fetchCalls.length > before, '会话变化应触发重报');
  const body = JSON.parse(mod.fetchCalls.at(-1).init.body);
  assert.equal(body.sessionId, 's2');
});

test('状态没变时不上报（去重节流，避免订阅连续触发造成突刺）', async () => {
  const { mod, ctx } = await boot();
  const before = mod.fetchCalls.length;
  for (let i = 0; i < 12; i++) ctx.subscribed[0]();
  assert.equal(mod.fetchCalls.length, before, '载荷相同应被去重');
});

test('可见性变化立刻上报（不被节流吞掉）', async () => {
  const { mod } = await boot();
  const before = mod.fetchCalls.length;
  mod.documentStub.visibilityState = 'hidden';
  const handler = mod.listeners.find(([t, ty]) => t === 'document' && ty === 'visibilitychange')[2];
  handler();
  assert.equal(mod.fetchCalls.length, before + 1, '状态真正变化应立刻发出');
  const body = JSON.parse(mod.fetchCalls.at(-1).init.body);
  assert.equal(body.visible, false);
});

test('URL 带 focus 参数时会 open 对应会话', async () => {
  const { ctx } = await boot({ search: `?${FOCUS_PARAM}=s2` });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, ['s2']);
});

test('URL 带 focus 参数但会话不存在时不 open，也不会崩', async () => {
  const { ctx } = await boot({ search: `?${FOCUS_PARAM}=missing` }, { byId: { s1: {} }, phase: 'ready' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, []);
});

test('无 focus 参数时不会 open 任何会话', async () => {
  const { ctx } = await boot();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, []);
});

test('0.1.7：sessions 上无 open 时，回跳改走 uiWorkspace.openSession', async () => {
  const { ctx } = await boot(
    { search: `?${FOCUS_PARAM}=s2` },
    { sessionsOpen: false, withWorkspace: true },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedViaWorkspace, ['s2'], '应通过 uiWorkspace 切到目标会话');
  assert.deepEqual(ctx.opened, [], '0.1.7 不该再去碰已移除的 sessions.open');
});

test('0.1.7：待跳转回执同样走 uiWorkspace.openSession', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's2' },
    { sessionsOpen: false, withWorkspace: true },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedViaWorkspace, ['s2']);
});

test('0.1.7：uiWorkspace 晚于 sessions 就绪时仍能切过去（切换时现取）', async () => {
  // 先按「workspace 还没注入」建 ctx，apply 之后再挂上服务，模拟注入回调晚到
  const mod = await loadClientModule({ search: `?${FOCUS_PARAM}=s2` });
  const ctx = makeClientCtx({ sessionsOpen: false });
  mod.clientModule.apply(ctx);
  loaded.push({ mod, ctx });

  // switchTo 会重试；此时补上 uiWorkspace 服务
  const openedViaWorkspace = [];
  ctx.uiWorkspace = { openSession: (id) => openedViaWorkspace.push(id) };
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(openedViaWorkspace, ['s2']);
});

// ── 待跳转会话（点击 Toast 回跳的主通路）─────────────────────────────────────

test('加载时向宿主索取待跳转会话并切过去', async () => {
  const { mod, ctx } = await boot({ pendingFocusReply: 's2' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'pending-focus'),
    '应主动索取待跳转会话',
  );
  assert.deepEqual(ctx.opened, ['s2']);
});

test('切过去之后回执清除，避免重复跳转', async () => {
  const { mod } = await boot({ pendingFocusReply: 's2' });
  await new Promise((r) => setTimeout(r, 30));
  const ack = mod.fetchCalls.find((c) => JSON.parse(c.init.body).op === 'ack-focus');
  assert.ok(ack, '应发送 ack-focus');
  assert.equal(JSON.parse(ack.init.body).sessionId, 's2');
});

test('已经在目标会话上时不重复 open，但仍回执', async () => {
  const { mod, ctx } = await boot({ pendingFocusReply: 's1' }, { current: 's1' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, [], '已在目标会话上不应再 open');
  assert.ok(mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'ack-focus'));
});

test('宿主没有待跳转会话时什么都不做', async () => {
  const { mod, ctx } = await boot({ pendingFocusReply: null });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, []);
  assert.equal(
    mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'ack-focus'),
    false,
    '没有目标就不该回执',
  );
});

// ── 揭示目标：点通知回到插件自己的右栏 tab ──────────────────────────────────

const REVEAL = { resource: 'dsh-resource://btw/session/s-side', reason: 'dsh-btw-sidebar' };

test('带揭示目标时把资源开在右栏，而不是在主视图新开一条会话', async () => {
  const { mod, ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: REVEAL },
    { sessionsOpen: false, withWorkspace: true, sidebar: 'ok' },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedResources, [REVEAL.resource], '应交给右栏打开/聚焦那个 tab');
  assert.deepEqual(ctx.openedViaWorkspace, [], '不该再切主视图');
  const ack = mod.fetchCalls.find((c) => JSON.parse(c.init.body).op === 'ack-focus');
  assert.equal(JSON.parse(ack.init.body).sessionId, 's-side', '仍然要回执，避免重复跳转');
});

test('右栏拒绝打开（没有 tab 类型认领）时退回主视图', async () => {
  const { mod, ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: REVEAL },
    { byId: { s1: {}, s2: {}, 's-side': {} }, sessionsOpen: false, withWorkspace: true, sidebar: 'throws' },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedResources, []);
  assert.deepEqual(ctx.openedViaWorkspace, ['s-side'], '右栏打不开就必须退回主视图，别让点击变成没反应');
  assert.ok(mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'ack-focus'));
});

test('右栏服务缺失时退回主视图', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: REVEAL },
    { byId: { s1: {}, s2: {}, 's-side': {} }, sessionsOpen: false, withWorkspace: true },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedResources, []);
  assert.deepEqual(ctx.openedViaWorkspace, ['s-side']);
});

test('没有揭示目标时行为不变（切主视图）', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's2', reveal: null },
    { sessionsOpen: false, withWorkspace: true, sidebar: 'ok' },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedResources, []);
  assert.deepEqual(ctx.openedViaWorkspace, ['s2']);
});

test('已经在目标会话上时优先回执，不去开右栏', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's1', reveal: REVEAL },
    { current: 's1', sidebar: 'ok' },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedResources, [], '已经在目标会话上就不该再开面板');
});

// ── 揭示目标的归属会话（右栏按主视图会话分域）─────────────────────────────────

const OWNED_REVEAL = {
  resource: 'dsh-resource://btw/session/s-side',
  mainSessionId: 's-owner',
  reason: 'dsh-btw-sidebar',
};

test('跨会话揭示：先切回归属会话，再在它的右栏里打开（而不是开进当前会话）', async () => {
  const { mod, ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: OWNED_REVEAL },
    {
      current: 's-other',
      byId: { 's-other': {}, 's-owner': {}, 's-side': {} },
      sessionsOpen: false,
      withWorkspace: true,
      sidebar: 'ok',
      autoMountSession: true,
      mountedInitial: 's-other',
    },
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(ctx.openedViaWorkspace, ['s-owner'], '必须先把主视图切回归属会话');
  assert.deepEqual(ctx.openedResources, [OWNED_REVEAL.resource], '资源要交给右栏打开/聚焦');
  assert.deepEqual(ctx.openedMounts, ['s-owner'], '打开时右栏必须已经挂载在归属会话上');
  const ack = mod.fetchCalls.find((c) => JSON.parse(c.init.body).op === 'ack-focus');
  assert.equal(JSON.parse(ack.init.body).sessionId, 's-side', '仍然要回执，避免重复跳转');
});

test('跨会话揭示：归属会话的右栏还没挂载时绝不硬开（否则就开进了当前会话）', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: OWNED_REVEAL },
    {
      current: 's-other',
      byId: { 's-other': {}, 's-owner': {}, 's-side': {} },
      sessionsOpen: false,
      withWorkspace: true,
      sidebar: 'ok',
      autoMountSession: false,
      mountedInitial: 's-other',
    },
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(ctx.openedViaWorkspace, ['s-owner'], '主视图先切过去');
  assert.deepEqual(ctx.openedResources, [], '右栏还挂在 s-other 上，这时打开就会开错会话');

  // seat 随后 bind 到归属会话 → 这时才打开
  ctx.setMounted('s-owner');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ctx.openedResources, [OWNED_REVEAL.resource]);
  assert.deepEqual(ctx.openedMounts, ['s-owner']);
});

test('揭示目标没有归属信息时行为不变（直接开在当前会话）', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: REVEAL },
    {
      current: 's-other',
      byId: { 's-other': {}, 's-side': {} },
      sessionsOpen: false,
      withWorkspace: true,
      sidebar: 'ok',
      autoMountSession: true,
      mountedInitial: 's-other',
    },
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(ctx.openedViaWorkspace, [], '没有归属就不该乱切主视图');
  assert.deepEqual(ctx.openedResources, [REVEAL.resource]);
});

test('归属就是当前会话时不重复切换，直接开右栏', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: OWNED_REVEAL },
    {
      current: 's-owner',
      byId: { 's-owner': {}, 's-side': {} },
      sessionsOpen: false,
      withWorkspace: true,
      sidebar: 'ok',
      mountedInitial: 's-owner',
    },
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(ctx.openedViaWorkspace, [], '已经在归属会话上，不需要再切');
  assert.deepEqual(ctx.openedResources, [OWNED_REVEAL.resource]);
  assert.deepEqual(ctx.openedMounts, ['s-owner']);
});

test('页面刚加载、右栏还没有 seat 挂载时：就算归属会话已是当前会话也要等它 bind，不能立刻开', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: OWNED_REVEAL },
    {
      current: 's-owner',
      byId: { 's-owner': {}, 's-side': {} },
      sessionsOpen: false,
      withWorkspace: true,
      sidebar: 'ok',
      autoMountSession: false,
      // mounted 可观察量存在，但此刻还没有任何 seat bind（值为 undefined → null）
      mountedInitial: null,
    },
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(ctx.openedResources, [], '右栏还没挂载就开，会落进一个不存在/过期的 binding');

  ctx.setMounted('s-owner');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ctx.openedResources, [OWNED_REVEAL.resource]);
  assert.deepEqual(ctx.openedMounts, ['s-owner']);
  assert.deepEqual(ctx.openedViaWorkspace, [], '已经在归属会话上，不需要重复切');
});

test('老版本右栏没有 mounted 可观察量时，退化为看主视图是否已切过去', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: OWNED_REVEAL },
    {
      current: 's-other',
      byId: { 's-other': {}, 's-owner': {}, 's-side': {} },
      sessionsOpen: false,
      withWorkspace: true,
      sidebar: 'ok',
      autoMountSession: true,
      mountedInitial: 's-other',
      withoutMountedObservable: true,
    },
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(ctx.openedViaWorkspace, ['s-owner']);
  assert.deepEqual(ctx.openedResources, [OWNED_REVEAL.resource]);
});

test('归属会话的右栏打不开时，退回老规矩：切主视图那条会话（别让点击没反应）', async () => {
  const { mod, ctx } = await boot(
    { pendingFocusReply: 's-side', reveal: OWNED_REVEAL },
    {
      current: 's-other',
      byId: { 's-other': {}, 's-owner': {}, 's-side': {} },
      sessionsOpen: false,
      withWorkspace: true,
      sidebar: 'throws',
      autoMountSession: true,
      mountedInitial: 's-other',
    },
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(ctx.openedViaWorkspace, ['s-owner', 's-side'], '先切回归属会话开右栏，失败才退回目标会话');
  assert.deepEqual(ctx.openedResources, []);
  assert.ok(mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'ack-focus'));
});

test('重新获得焦点时再次索取待跳转会话（浏览器只聚焦不重载的场景）', async () => {
  const { mod, ctx } = await boot({ pendingFocusReply: null });
  await new Promise((r) => setTimeout(r, 20));
  const before = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'pending-focus').length;

  const handler = mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2];
  handler();
  await new Promise((r) => setTimeout(r, 20));

  const after = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'pending-focus').length;
  assert.ok(after > before, '获得焦点时应再取一次');
});

test('页面不可见时不去索取待跳转会话', async () => {
  const { mod } = await boot({ pendingFocusReply: null });
  await new Promise((r) => setTimeout(r, 20));
  const before = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'pending-focus').length;

  mod.documentStub.visibilityState = 'hidden';
  const handler = mod.listeners.find(([t, ty]) => t === 'document' && ty === 'visibilitychange')[2];
  handler();
  await new Promise((r) => setTimeout(r, 20));

  const after = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'pending-focus').length;
  assert.equal(after, before, '不可见时不该索取');
});

test('上报失败（fetch reject）不会抛出未处理异常', async () => {
  const mod = await loadClientModule();
  loaded.push({ mod });
  globalThis.fetch = () => Promise.reject(new Error('network down'));
  const ctx = makeClientCtx();
  assert.doesNotThrow(() => mod.clientModule.apply(ctx));
  await new Promise((r) => setTimeout(r, 20));
  ctx.dispose();
});

// ── 实例标题 tag（多实例窗口区分）────────────────────────────────────────────

test('启动即给标题追加本实例端口 tag', async () => {
  const { mod } = await boot();
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness [dsh:3081]');
});

test('标题被布局插件重写后自动补回 tag（且不会重复叠加）', async () => {
  const { mod } = await boot();
  assert.ok(mod.observerInstances.length > 0, '应挂上 MutationObserver');

  mod.overwriteTitle('另一个会话 — DeepSeek Harness');
  assert.equal(mod.documentStub.title, '另一个会话 — DeepSeek Harness [dsh:3081]');

  // 再触发一次：已经带 tag，不应叠加成两个
  mod.overwriteTitle('另一个会话 — DeepSeek Harness [dsh:3081]');
  assert.equal(mod.documentStub.title, '另一个会话 — DeepSeek Harness [dsh:3081]');
});

test('宿主配置 titleTag=false 时撤下 tag 并断开观察者', async () => {
  const { mod } = await boot({ titleTagReply: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness', '应还原成原始标题');
  assert.ok(
    mod.observerInstances.every((o) => o.disconnected),
    '应断开观察者，避免继续改写标题',
  );
});

test('config 请求失败时保持 tag 开着（与宿主脚本默认一致）', async () => {
  const mod = await loadClientModule();
  loaded.push({ mod });
  globalThis.fetch = () => Promise.reject(new Error('network down'));
  const ctx = makeClientCtx();
  mod.clientModule.apply(ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness [dsh:3081]');
  ctx.dispose();
});

test('dispose 时撤下 tag', async () => {
  const { mod, ctx } = await boot();
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness [dsh:3081]');
  ctx.dispose();
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness');
});

// ── 点击落点：会话在哪个面板里就回哪个面板 ──────────────────────────────────
//
// 真机场景：super-agent 的 Router 面板占着主区域，Router 跑完一轮弹通知；用户点
// 通知后原来落到「主视图打开 Router 会话」——因为 uiWorkspace.openSession 内部会
// `selectPanel(null)`，把面板关掉了。面板的会话由插件自己的 retain 来源标识
// （`superAgentUi`），这里验证浏览器半部能自己学会这个对应关系，而不是写死名字。

const PANEL_MEMORY_KEY = 'dshAwayNotify.panelMemory.v1';

/** 打开面板 → 面板挂载 retain 会话 → 订阅回调触发学习（保留原有会话）。 */
function openPanelWithRetainedSession(ctx, { panelId = 'super-agent', source = 'superAgentUi', sessionId = 'router' } = {}) {
  ctx.setPanel(panelId);
  const byId = { ...ctx.sessions.list.getSnapshot().byId };
  byId[sessionId] = { ...(byId[sessionId] ?? {}), id: sessionId, retainedBy: { [source]: 1 } };
  ctx.setById(byId);
  ctx.subscribed[0]();
}

test('会话在面板中：点通知激活该面板，而不是在主视图重开（并回执）', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );
  openPanelWithRetainedSession(ctx);

  mod.setPendingFocus('router');
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.selectedPanels, ['super-agent'], '应通过 layout.selectPanel 激活会话所在面板');
  assert.deepEqual(ctx.openedViaWorkspace, [], '不能走 openSession——它会先 selectPanel(null) 把面板关掉');
  assert.ok(mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'ack-focus'), '仍然要回执');
});

test('面板关掉后：靠归属记忆重新打开面板，而不是切主视图', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );
  openPanelWithRetainedSession(ctx);

  // 用户切回会话视图：面板卸载 → retain 释放
  ctx.setPanel(null);
  ctx.setById({
    main: { id: 'main', retainedBy: { mainView: 1 } },
    router: { id: 'router' },
  });
  ctx.subscribed[0]();

  mod.setPendingFocus('router');
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.selectedPanels, ['super-agent'], '面板没开时也要能打开它');
  assert.deepEqual(ctx.openedViaWorkspace, []);
});

test('刷新后仍记得会话属于哪个面板（持久化归属记忆）', async () => {
  const { mod, ctx } = await boot(
    {
      panelMemory: {
        version: 1,
        sessions: { router: { panelId: 'super-agent', at: Date.now() } },
      },
    },
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );

  mod.setPendingFocus('router');
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.selectedPanels, ['super-agent'], '新页面里没有画面板的内存态，靠持久化记忆补齐');
  assert.deepEqual(ctx.openedViaWorkspace, []);
});

test('会话不在面板中：点通知仍走原来的主视图路径', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
        other: { id: 'other' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );
  openPanelWithRetainedSession(ctx);

  mod.setPendingFocus('other');
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.selectedPanels, [], '不在任何面板里的会话不该触发面板切换');
  assert.deepEqual(ctx.openedViaWorkspace, ['other'], '保持旧行为：在主视图打开');
});

test('布局服务缺失（老版本）时：即使有面板记忆也只降级到主视图，不报错', async () => {
  const { mod, ctx } = await boot(
    {
      panelMemory: {
        version: 1,
        sessions: { router: { panelId: 'super-agent', at: Date.now() } },
      },
    },
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: false,
      sessionsOpen: false,
      withWorkspace: true,
    },
  );

  mod.setPendingFocus('router');
  assert.doesNotThrow(() => mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]());
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.openedViaWorkspace, ['router'], '面板 API 缺失时必须退回主视图');
  assert.deepEqual(ctx.selectedPanels, []);
});

test('selectPanel 抛错（面板未注册 / 版本不兼容）时退回主视图，点击不变成没反应', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      selectPanelMode: 'throws',
      sessionsOpen: false,
      withWorkspace: true,
    },
  );
  openPanelWithRetainedSession(ctx);

  mod.setPendingFocus('router');
  assert.doesNotThrow(() => mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]());
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.openedViaWorkspace, ['router'], '面板激活失败必须退回主视图');
  assert.deepEqual(ctx.selectedPanels, ['super-agent'], 'selectPanel 被尝试过（随后抛错）');
});

test('面板已卸载：归属记忆指向的面板未注册时清掉记忆并退回主视图', async () => {
  const { mod, ctx } = await boot(
    {
      panelMemory: {
        version: 1,
        sessions: { router: { panelId: 'uninstalled-panel', at: Date.now() } },
      },
    },
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );

  mod.setPendingFocus('router');
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.selectedPanels, [], '未注册的面板不能被选中');
  assert.deepEqual(ctx.openedViaWorkspace, ['router']);
  const stored = JSON.parse(mod.storage.getItem(PANEL_MEMORY_KEY) ?? '{}');
  assert.equal(stored.sessions?.router, undefined, '过期记忆应被清掉，避免每次点击都白试');
});

test('面板插件显式注册来源 + showSession：点击激活面板并让面板切到该会话', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router', retainedBy: { myPanelUi: 1 } },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['my-panel'],
    },
  );

  const shown = [];
  const registry = ctx.provided.awayNotifyPanels;
  assert.equal(registry?.version, 1, '应提供客户端 awayNotifyPanels 服务');
  const dispose = registry.register({
    panelId: 'my-panel',
    source: 'myPanelUi',
    showSession: (sessionId) => shown.push(sessionId),
  });

  mod.setPendingFocus('router');
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.selectedPanels, ['my-panel']);
  assert.deepEqual(shown, ['router'], '显式注册的 showSession 应被调用');
  assert.deepEqual(ctx.openedViaWorkspace, []);
  dispose();
});

test('主视图与面板都 retain 着目标会话时：当前打开的面板优先', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );
  openPanelWithRetainedSession(ctx);

  // 用户此前点过面板里的「打开会话」：主视图也 retain 着同一条，之后又回到了面板
  const byId = { ...ctx.sessions.list.getSnapshot().byId };
  byId.router = { id: 'router', retainedBy: { mainView: 1, superAgentUi: 1 } };
  ctx.setById(byId);
  ctx.subscribed[0]();

  mod.setPendingFocus('router');
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.selectedPanels, ['super-agent'], '你正看着面板，就不该被拉回主视图');
  assert.deepEqual(ctx.openedViaWorkspace, []);
});

test('面板激活前就存在的 retain 来源不会被误绑成该面板的（右栏会话仍回主视图）', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        side: { id: 'side', retainedBy: { sidebarView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );

  // 打开面板时右栏已经开着：它的来源在激活快照里，不属于这个面板
  ctx.setPanel('super-agent');
  openPanelWithRetainedSession(ctx);

  mod.setPendingFocus('side');
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(ctx.selectedPanels, [], 'sidebarView 不该被认成 super-agent 面板的来源');
  assert.deepEqual(ctx.openedViaWorkspace, ['side']);
});

test('URL 兼容通路也优先回到会话所在面板（与 pending-focus 同一落点）', async () => {
  const { ctx } = await boot(
    {
      search: `?${FOCUS_PARAM}=router`,
      panelMemory: {
        version: 1,
        sessions: { router: { panelId: 'super-agent', at: Date.now() } },
      },
    },
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(ctx.selectedPanels, ['super-agent']);
  assert.deepEqual(ctx.openedViaWorkspace, []);
});

// ── 显式注册（awayNotifyPanels）与自动学习的分工 ─────────────────────────────
//
// 自动学习是「面板被选中后 15 秒内第一个新出现的 retain 来源」的猜测；面板插件
// 显式注册后，归属必须由注册说了算：注册优先、已注册的面板不再被学习追加来源、
// 已注册的来源不被学习改记到别的面板。注销后回到自动学习兜底。

/** 模拟「用户点了通知」：宿主返回待跳转会话 → 窗口获得焦点 → 浏览器半部处理。 */
async function clickNotification(mod, sessionId) {
  mod.setPendingFocus(sessionId);
  mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2]();
  await new Promise((r) => setTimeout(r, 40));
}

test('显式注册优先于自动学习：同一来源改注册给别的面板后，点击去新面板', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent', 'my-panel'],
    },
  );
  // 自动学习先把 superAgentUi 认给 super-agent
  openPanelWithRetainedSession(ctx);
  // 面板插件随后显式注册同一条来源（热重载后换了落点）
  const dispose = ctx.provided.awayNotifyPanels.register({
    panelId: 'my-panel',
    sources: ['superAgentUi'],
  });

  await clickNotification(mod, 'router');

  assert.deepEqual(ctx.selectedPanels, ['my-panel'], '显式注册必须压过自动学习');
  assert.deepEqual(ctx.openedViaWorkspace, []);
  dispose();
});

test('已显式注册的面板不会被自动学习追加第二个来源', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        side: { id: 'side' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );
  const dispose = ctx.provided.awayNotifyPanels.register({
    panelId: 'super-agent',
    sources: ['superAgentUi'],
  });

  // 面板被选中，随后出现一个**别的**来源（15 秒窗口内）
  ctx.setPanel('super-agent');
  const byId = { ...ctx.sessions.list.getSnapshot().byId };
  byId.side = { id: 'side', retainedBy: { sidebarView: 1 } };
  ctx.setById(byId);
  ctx.subscribed[0]();

  await clickNotification(mod, 'side');

  assert.deepEqual(ctx.selectedPanels, [], 'sidebarView 不能被学成已注册面板的来源');
  assert.deepEqual(ctx.openedViaWorkspace, ['side']);
  dispose();
});

test('自动学习不会把已显式注册的来源改记到别的面板（注销后也不会跳错面板）', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent', 'my-panel'],
    },
  );
  const dispose = ctx.provided.awayNotifyPanels.register({
    panelId: 'super-agent',
    sources: ['superAgentUi'],
  });

  // 另一个面板被选中，之后 superAgentUi 的 retain 才出现：旧实现会把它学给 my-panel
  ctx.setPanel('my-panel');
  const byId = { ...ctx.sessions.list.getSnapshot().byId };
  byId.router = { id: 'router', retainedBy: { superAgentUi: 1 } };
  ctx.setById(byId);
  ctx.subscribed[0]();

  dispose();
  await clickNotification(mod, 'router');

  assert.deepEqual(ctx.selectedPanels, [], '注销后点击不该被「学错的面板」接走');
  assert.deepEqual(ctx.openedViaWorkspace, ['router']);
});

test('重复注册同一面板/来源只生效一份：后注册者优先，注销其中一个不影响另一个', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router', retainedBy: { superAgentUi: 1 } },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['my-panel'],
    },
  );
  const shown = [];
  const first = ctx.provided.awayNotifyPanels.register({
    panelId: 'my-panel',
    sources: ['superAgentUi'],
    showSession: (id) => shown.push(`first:${id}`),
  });
  const second = ctx.provided.awayNotifyPanels.register({
    panelId: 'my-panel',
    sources: ['superAgentUi'],
    showSession: (id) => shown.push(`second:${id}`),
  });

  // 注销其中一个句柄（同一个句柄重复注销是 no-op）：另一份注册必须仍然有效
  first();
  first();
  await clickNotification(mod, 'router');
  assert.deepEqual(ctx.selectedPanels, ['my-panel'], '只激活一次，且另一份注册仍然活着');
  assert.deepEqual(shown, ['second:router'], '后注册的 showSession 生效，且只调用一次');

  second();
  shown.length = 0;
  await clickNotification(mod, 'router');
  assert.deepEqual(shown, [], '两个句柄都注销后不再有 showSession 声明');
});

test('全部注册句柄注销后回退：不再按显式注册激活面板', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router', retainedBy: { superAgentUi: 1 } },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['my-panel'],
    },
  );
  const first = ctx.provided.awayNotifyPanels.register({ panelId: 'my-panel', sources: ['superAgentUi'] });
  const second = ctx.provided.awayNotifyPanels.register({ panelId: 'my-panel', sources: ['superAgentUi'] });
  first();
  second();

  await clickNotification(mod, 'router');

  assert.deepEqual(ctx.selectedPanels, []);
  assert.deepEqual(ctx.openedViaWorkspace, ['router']);
});

test('注销后回落自动学习：面板再次被选中时仍能把来源学给该面板', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router' },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['super-agent'],
    },
  );
  const dispose = ctx.provided.awayNotifyPanels.register({
    panelId: 'super-agent',
    sources: ['superAgentUi'],
  });
  dispose();

  // 面板被选中 → 面板 retain 会话 → 自动学习接管
  ctx.setPanel('super-agent');
  const byId = { ...ctx.sessions.list.getSnapshot().byId };
  byId.router = { id: 'router', retainedBy: { superAgentUi: 1 } };
  ctx.setById(byId);
  ctx.subscribed[0]();

  await clickNotification(mod, 'router');

  assert.deepEqual(ctx.selectedPanels, ['super-agent'], '没有注册时自动学习仍然生效');
  assert.deepEqual(ctx.openedViaWorkspace, []);
});

test('非法注册参数被忽略：不产生绑定、不抛错、返回可调用的注销函数', async () => {
  const { mod, ctx } = await boot(
    {},
    {
      current: '',
      byId: {
        main: { id: 'main', retainedBy: { mainView: 1 } },
        router: { id: 'router', retainedBy: { superAgentUi: 1 } },
      },
      layout: true,
      panel: null,
      sessionsOpen: false,
      withWorkspace: true,
      registeredPanels: ['my-panel'],
    },
  );
  const registry = ctx.provided.awayNotifyPanels;
  const disposeNoPanel = registry.register({ sources: ['superAgentUi'] });
  const disposeNoSource = registry.register({ panelId: 'my-panel', sources: ['mainView', ''] });
  assert.equal(typeof disposeNoPanel, 'function');
  assert.doesNotThrow(() => {
    disposeNoPanel();
    disposeNoSource();
  });

  await clickNotification(mod, 'router');

  assert.deepEqual(ctx.selectedPanels, [], 'mainView / 空来源都不能变成面板绑定');
  assert.deepEqual(ctx.openedViaWorkspace, ['router']);
});
