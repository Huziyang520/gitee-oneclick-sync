/**
 * Gitee 一键同步 · content script
 * 仓库列表页批量、单仓库页单独，调用站点自身的强制同步接口从 GitHub 拉取。
 *
 * 站点接口（取自 gitee 前端 bundle，勿臆改）：
 *   POST /{owner}/{repo}/force_sync_project   sync_wiki / prune / authenticity_token
 *   GET  /{owner}/{repo}/check_fetch          { in_fetch, error_msg }
 *   status === 0 为失败，其余视为已受理
 */
(() => {
  "use strict";
  if (window.__giteeSyncInjected) return;
  window.__giteeSyncInjected = true;

  const OPT_KEY = "gsOpts";
  const CACHE_KEY = "gsCache";
  const POS_KEY = "gsPos";
  const CACHE_TTL = 24 * 60 * 60 * 1000;

  const SCAN_GAP = [220, 420];
  const SUBMIT_GAP = [900, 1500];
  const POLL_INTERVAL = 5000;
  const POLL_TIMEOUT = 15 * 60 * 1000;
  const STOP_STREAK = 3;
  const HOST_ID = "gitee-sync-host";

  const CHIP = {
    idle: ["待扫描", ""],
    checking: ["扫描中", "busy"],
    ready: ["待同步", "ready"],
    noimport: ["非导入", "muted"],
    submitting: ["提交中", "busy"],
    queued: ["已受理", "queued"],
    syncing: ["同步中", "busy"],
    done: ["完成", "ok"],
    error: ["失败", "err"],
  };

  const state = {
    mode: "",
    path: "",
    items: [],
    scanning: false,
    running: false,
    stopFlag: false,
    token: "",
    opts: { syncWiki: false, prune: false },
    cache: {},
    log: "",
    lastHref: location.href,
    dragEndedAt: 0,
  };

  const ui = {
    host: null,
    root: null,
    fab: null,
    panel: null,
    listEl: null,
    bar: null,
    barText: null,
    logEl: null,
    btnScan: null,
    btnAll: null,
    btnRun: null,
    btnStop: null,
    swWiki: null,
    swPrune: null,
    subEl: null,
    rows: new Map(),
    drag: null,
  };

  /* ---------- 基础工具 ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => Math.floor(a + Math.random() * (b - a));

  function errText(e) {
    const m = (e && e.message) || String(e || "");
    if (/HTTP 401|HTTP 403/.test(m)) return "没有权限或未登录";
    if (/HTTP 419|HTTP 422/.test(m)) return "页面校验失效，刷新后重试";
    if (/Failed to fetch|NetworkError/.test(m)) return "网络异常";
    return m || "未知错误";
  }

  function storeGet() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([OPT_KEY, CACHE_KEY, POS_KEY], (v) => resolve(v || {}));
      } catch (_) {
        resolve({});
      }
    });
  }

  let cacheTimer = null;
  function saveCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ [CACHE_KEY]: state.cache });
      } catch (_) {}
    }, 400);
  }

  function saveOpts() {
    try {
      chrome.storage.local.set({ [OPT_KEY]: state.opts });
    } catch (_) {}
  }

  /* ---------- 页面识别 ---------- */

  function detectPage() {
    const p = location.pathname.replace(/\/+$/, "");
    let m = /^\/([^/]+)\/projects$/.exec(p);
    if (m) return { mode: "list", path: "" };
    m = /^\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) return { mode: "repo", path: m[1] + "/" + m[2] };
    return { mode: "", path: "" };
  }

  async function collectRepoPathsAll() {
    const out = [];
    collectRepoPaths().forEach((p) => out.push(p));
    const base = location.pathname;
    for (let page = 2; page <= 8; page++) {
      let html = "";
      try {
        html = await fetchText(base + "?page=" + page);
      } catch (_) {
        break;
      }
      const found = [];
      // 服务端直出用双引号，XHR 返回的分页片段用单引号，两种都要吃
      const re = /data-path=(["'])([^"'\s>]+\/[^"'\s>]+)\1/g;
      let m;
      while ((m = re.exec(html))) if (!found.includes(m[2])) found.push(m[2]);
      let added = 0;
      found.forEach((p) => {
        if (!out.includes(p)) {
          out.push(p);
          added++;
        }
      });
      if (!added) break;
      await sleep(rand(SCAN_GAP));
    }
    return out;
  }

  function collectRepoPaths() {
    const out = [];
    document.querySelectorAll(".project.list-warpper[data-path]").forEach((el) => {
      const path = (el.getAttribute("data-path") || "").trim();
      if (/^[^/\s]+\/[^/\s]+$/.test(path) && !out.includes(path)) out.push(path);
    });
    return out;
  }

  /* ---------- 网络 ---------- */

  function parseRepoPage(text) {
    if (!/<html/i.test(text)) throw new Error("页面返回异常");
    const imp = /var\s+title_import_url\s*=\s*("([^"]*)"|null)/.exec(text);
    const tok = /var\s+title_form_authenticity_token\s*=\s*"([^"]*)"/.exec(text);
    return {
      importUrl: imp && imp[2] ? imp[2].trim() : "",
      token: tok ? tok[1] : "",
      waitFetch: /gon\.wait_fetch\s*=\s*(?:true|!0)/.test(text),
    };
  }

  function csrfFromDom() {
    const m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : "";
  }

  async function fetchText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        credentials: "include",
        signal: ctrl.signal,
        // Gitee 对默认 Accept 的请求会返回给 AI 用的 markdown 摘要，必须显式要 html
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("请求超时");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshToken(item) {
    try {
      const info = parseRepoPage(await fetchText("/" + item.path));
      if (info.token) {
        state.token = info.token;
        if (state.cache[item.path]) state.cache[item.path].token = info.token;
        saveCache();
      }
    } catch (_) {}
  }

  async function submitOne(item, retried) {
    const body = new URLSearchParams();
    body.set("sync_wiki", state.opts.syncWiki ? "true" : "false");
    body.set("prune", state.opts.prune ? "true" : "false");
    if (state.token) body.set("authenticity_token", state.token);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      res = await fetch("/" + item.path + "/force_sync_project", {
        method: "POST",
        credentials: "include",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json, text/javascript, */*; q=0.01",
        },
        body: body.toString(),
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("提交超时");
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }
    if ((res.status === 419 || res.status === 422) && !retried) {
      await refreshToken(item);
      return submitOne(item, true);
    }
    if (!res.ok) {
      const msg = json && json.message ? String(json.message) : "";
      if (res.status === 401 || res.status === 403) throw new Error(msg || "未登录或登录已过期");
      throw new Error(msg || "接口返回 HTTP " + res.status);
    }
    if (!json || typeof json !== "object") throw new Error("接口返回异常（HTTP " + res.status + "），可能已改版");
    if (json.status === 0) throw new Error(json.message || "仓库同步失败");
    return json.message || "";
  }

  async function pollOne(item) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch("/" + item.path + "/check_fetch", {
        credentials: "include",
        signal: ctrl.signal,
        headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- 扫描 ---------- */

  function setItem(item, st, msg) {
    item.state = st;
    item.msg = msg || "";
    updateRow(item);
    updateSummary();
  }

  async function scan(paths, useCurrentDoc) {
    if (state.scanning || state.running) return;
    if (!paths.length) {
      state.log = "这一页没有找到仓库";
      renderSummary();
      return;
    }
    state.scanning = true;
    state.stopFlag = false;
    state.items = paths.map((p) => ({
      path: p,
      name: p.split("/")[1],
      importUrl: "",
      checked: false,
      state: "idle",
      msg: "",
    }));
    state.log = "正在识别哪些仓库是从 GitHub 导入的…";
    renderList();
    renderSummary();

    let found = 0;
    for (const item of state.items) {
      if (state.stopFlag) break;
      setItem(item, "checking");
      try {
        let info = null;
        if (useCurrentDoc && item.path === state.path) {
          info = parseRepoPage(document.documentElement.outerHTML);
        } else {
          const hit = state.cache[item.path];
          if (hit && Date.now() - hit.at < CACHE_TTL) {
            info = hit;
            if (hit.token) state.token = hit.token;
          }
          else {
            info = parseRepoPage(await fetchText("/" + item.path));
            state.cache[item.path] = { importUrl: info.importUrl, token: info.token, at: Date.now() };
            saveCache();
          }
        }
        if (info.token) state.token = info.token;
        if (!info.importUrl) {
          setItem(item, "noimport", "不是从 GitHub 导入的仓库");
        } else {
          item.importUrl = info.importUrl;
          item.checked = true;
          found++;
          setItem(item, info.waitFetch ? "syncing" : "ready", info.waitFetch ? "站点正在同步中" : "");
        }
      } catch (e) {
        setItem(item, "error", errText(e));
      }
      if (!(useCurrentDoc && item.path === state.path)) await sleep(rand(SCAN_GAP));
    }

    state.scanning = false;
    if (!state.token) state.token = csrfFromDom();
    state.log = found
      ? "识别到 " + found + " 个从 GitHub 导入的仓库"
      : "没有识别到从 GitHub 导入的仓库";
    updateSummary();
    renderSummary();
  }

  /* ---------- 执行 ---------- */

  function pickTargets() {
    return state.items.filter((i) => i.checked && i.state !== "noimport");
  }

  async function run() {
    if (state.running) return;
    const targets = pickTargets();
    if (!targets.length) {
      state.log = "请先勾选要同步的仓库";
      renderSummary();
      return;
    }
    if (!state.token) state.token = csrfFromDom();
    state.running = true;
    state.stopFlag = false;
    renderSummary();

    let streak = 0;
    let submitted = 0;
    for (const item of targets) {
      if (state.stopFlag) break;
      if (item.state === "syncing") {
        submitted++;
        continue;
      }
      setItem(item, "submitting", "");
      state.log = "正在提交 " + item.path;
      renderSummary();
      try {
        const msg = await submitOne(item);
        setItem(item, "queued", msg || "已进入后台队列");
        submitted++;
        streak = 0;
      } catch (e) {
        setItem(item, "error", errText(e));
        streak++;
        if (streak >= STOP_STREAK) {
          state.log = "连续 " + STOP_STREAK + " 次提交失败，已停止";
          state.stopFlag = true;
          break;
        }
      }
      if (state.stopFlag) break;
      await sleep(rand(SUBMIT_GAP));
    }

    const startAt = Date.now();
    while (!state.stopFlag && Date.now() - startAt < POLL_TIMEOUT) {
      const pending = targets.filter((i) => i.state === "queued" || i.state === "syncing");
      if (!pending.length) break;
      await sleep(POLL_INTERVAL);
      if (state.stopFlag) break;
      for (const item of pending) {
        if (state.stopFlag) break;
        try {
          const j = await pollOne(item);
          if (!j || j.in_fetch !== true) {
            if (j && j.error_msg) setItem(item, "error", String(j.error_msg));
            else setItem(item, "done", "已完成");
          } else {
            setItem(item, "syncing", "后台同步中");
          }
        } catch (_) {
          /* 单次轮询失败不改变状态，下一轮再试 */
        }
      }
      state.log = "已提交 " + submitted + " 个，等待后台完成…";
      renderSummary();
    }

    if (!state.stopFlag) {
      targets.forEach((i) => {
        if (i.state === "queued" || i.state === "syncing") setItem(i, "error", "等待超时，请到仓库页确认");
      });
    }
    state.running = false;
    const done = targets.filter((i) => i.state === "done").length;
    const bad = targets.filter((i) => i.state === "error").length;
    const skip = state.items.filter((i) => i.state === "noimport").length;
    state.log =
      (state.stopFlag ? "已停止：" : "同步结束：") +
      "完成 " + done + "，失败 " + bad + (skip ? "，跳过 " + skip : "");
    renderSummary();
  }

  /* ---------- UI ---------- */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px 10px 13px; border-radius: 999px; cursor: pointer;
      background: linear-gradient(135deg, #ff9a3c 0%, #fe7300 100%);
      color: #fff; font: 600 13px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      box-shadow: 0 6px 20px rgba(254, 115, 0, .38), 0 1px 0 rgba(255,255,255,.35) inset;
      user-select: none; transition: transform .16s ease, box-shadow .16s ease;
    }
    .fab:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(254, 115, 0, .45); }
    .fab:active { transform: translateY(0) scale(.985); }
    .fab svg { width: 15px; height: 15px; }
    .fab .dot {
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      background: rgba(255,255,255,.26); font-size: 11px; line-height: 18px; text-align: center;
    }
    .panel {
      position: fixed; right: 22px; bottom: 82px; z-index: 2147483001;
      width: 392px; max-height: min(82vh, 720px); display: none; flex-direction: column;
      background: #fff; border: 1px solid #e9edf5; border-radius: 16px; overflow: hidden;
      box-shadow: 0 18px 48px rgba(23, 31, 51, .16), 0 2px 8px rgba(23, 31, 51, .06);
      font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #1f2637;
    }
    .panel.open { display: flex; animation: gs-in .18s ease-out; }
    @keyframes gs-in { from { opacity: 0; transform: translateY(8px) scale(.99); } to { opacity: 1; transform: none; } }
    .head { padding: 15px 16px 11px; display: flex; align-items: flex-start; gap: 10px; }
    .head .txt { flex: 1; min-width: 0; }
    .head h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .2px; }
    .head p { margin: 4px 0 0; font-size: 11.5px; color: #8b93a7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x {
      width: 24px; height: 24px; border-radius: 7px; border: 0; background: #f2f4f9; color: #6b7488;
      cursor: pointer; font-size: 14px; line-height: 1; display: grid; place-items: center; flex: none;
    }
    .x:hover { background: #e8ebf3; color: #1f2637; }
    .opts { display: flex; gap: 8px; padding: 0 16px 12px; }
    .opt {
      flex: 1; display: flex; align-items: center; gap: 8px; padding: 7px 9px;
      border: 1px solid #eaeef6; border-radius: 10px; cursor: pointer; background: #fbfcfe;
      font-size: 11.5px; color: #4a5468; user-select: none; transition: border-color .15s, background .15s;
    }
    .opt:hover { border-color: #dfe5f1; background: #f8fafd; }
    .opt .sw {
      width: 30px; height: 17px; border-radius: 9px; background: #d9dfea; position: relative; flex: none;
      transition: background .16s ease;
    }
    .opt .sw::after {
      content: ""; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 3px rgba(23,31,51,.28); transition: transform .16s ease;
    }
    .opt.on .sw { background: linear-gradient(135deg, #ff9a3c, #fe7300); }
    .opt.on[data-k="prune"] { border-color: #ffd9bd; background: #fffaf5; }
    .opt.on[data-k="prune"] span { color: #c56a12; }
    .opt.on .sw::after { transform: translateX(13px); }
    .opt span { line-height: 1.25; }
    .toolbar {
      display: flex; align-items: center; gap: 8px; padding: 9px 16px;
      border-top: 1px solid #f0f3f9; border-bottom: 1px solid #f0f3f9; background: #fcfdff;
    }
    .toolbar .count { flex: 1; font-size: 11.5px; color: #8b93a7; }
    .ghost {
      border: 1px solid #e4e9f2; background: #fff; color: #4a5468; border-radius: 8px;
      padding: 5px 10px; font-size: 11.5px; cursor: pointer; white-space: nowrap;
    }
    .ghost:hover:not(:disabled) { border-color: #cfd8e8; color: #1f2637; }
    .ghost:disabled { opacity: .45; cursor: default; }
    .list { overflow: auto; padding: 6px 8px 10px; flex: 1; min-height: 56px; max-height: 384px; }
    .list::-webkit-scrollbar { width: 8px; }
    .list::-webkit-scrollbar-thumb { background: #e2e7f1; border-radius: 4px; }
    .row {
      display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 9px;
      cursor: pointer; transition: background .12s;
    }
    .row:hover { background: #f7f9fd; }
    .row.on { background: #fffaf4; }
    .row.on:hover { background: #fff5e9; }
    .row.hide { display: none; }
    .cb {
      width: 15px; height: 15px; border-radius: 4px; border: 1.5px solid #cbd3e2; flex: none;
      position: relative; background: #fff; transition: background .12s, border-color .12s;
    }
    .row.on .cb { background: linear-gradient(135deg, #ff9a3c, #fe7300); border-color: #fe7300; }
    .row.on .cb::after {
      content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
      border: solid #fff; border-width: 0 1.6px 1.6px 0; transform: rotate(42deg);
    }
    .row.locked .cb { opacity: .35; }
    .meta { flex: 1; min-width: 0; }
    .nm { font-size: 12.5px; color: #1f2637; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .src { font-size: 10.5px; color: #a2aabc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    .src.err { color: #d15959; }
    .chip {
      font-size: 10.5px; padding: 2px 7px; border-radius: 6px; flex: none;
      background: #f1f3f8; color: #7b8496; white-space: nowrap;
    }
    .chip.busy { background: #fff2e6; color: #d9660a; }
    .chip.busy::before {
      content: ""; display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #fe7300;
      margin-right: 4px; vertical-align: 1px; animation: gs-pulse 1.1s ease-in-out infinite;
    }
    @keyframes gs-pulse { 0%,100% { opacity: .3 } 50% { opacity: 1 } }
    .chip.ready { background: #eef2fb; color: #47579b; }
    .chip.queued { background: #eaf1ff; color: #2f6bd8; }
    .chip.ok { background: #e8f7ef; color: #1d8a5a; }
    .chip.err { background: #fdecec; color: #cc4040; }
    .chip.muted { background: #f1f3f7; color: #8b93a7; }
    .foot { padding: 11px 16px 14px; border-top: 1px solid #f0f3f9; background: #fcfdff; }
    .bar { height: 5px; border-radius: 3px; background: #e9eef7; overflow: hidden; margin-bottom: 9px; }
    .bar i { display: block; height: 100%; width: 0; border-radius: 3px;
      background: linear-gradient(90deg, #ffb066, #fe7300); transition: width .3s ease, background .3s ease; }
    .bar i.ok { background: linear-gradient(90deg, #63d69a, #1fa864); }
    .bar i.err { background: linear-gradient(90deg, #ffb1b1, #e05a5a); }
    .log { font-size: 11px; color: #8b93a7; margin-bottom: 10px; min-height: 15px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { display: flex; gap: 8px; }
    .primary {
      flex: 1; border: 0; border-radius: 10px; padding: 10px 12px; cursor: pointer;
      background: linear-gradient(135deg, #ff9a3c 0%, #fe7300 100%); color: #fff;
      font: 600 12.5px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      box-shadow: 0 4px 12px rgba(254,115,0,.28); transition: filter .15s, transform .12s;
    }
    .primary:hover:not(:disabled) { filter: brightness(1.04); }
    .primary:active:not(:disabled) { transform: translateY(1px); }
    .primary:disabled { opacity: .5; cursor: default; box-shadow: none; }
    .stop { border: 1px solid #f0d6d6; background: #fff; color: #cc4040; border-radius: 10px;
      padding: 10px 14px; cursor: pointer; font-size: 12.5px; }
    .stop:hover:not(:disabled) { background: #fdf2f2; }
    .stop:disabled { opacity: .4; cursor: default; }
  `;

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.2-6.9"/><path d="M21 3v6h-6"/></svg>';

  function mount() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;

    const wrap = document.createElement("div");

    const fab = document.createElement("div");
    fab.className = "fab";
    fab.innerHTML = ICON + '<span class="lbl">同步</span><span class="dot" style="display:none">0</span>';

    const panel = document.createElement("div");
    panel.className = "panel";
    /* 静态模板：不含任何用户数据，数据一律走 textContent */
    panel.innerHTML = `
      <div class="head">
        <div class="txt"><h1>Gitee 一键同步</h1><p class="sub"></p></div>
        <button class="x" title="收起">×</button>
      </div>
      <div class="opts">
        <div class="opt" data-k="syncWiki"><i class="sw"></i><span>同步 Wiki</span></div>
        <div class="opt" data-k="prune"><i class="sw"></i><span>删除多余分支/标签</span></div>
      </div>
      <div class="toolbar">
        <span class="count"></span>
        <button class="ghost btn-scan">扫描</button>
        <button class="ghost btn-all">全选</button>
      </div>
      <div class="list"></div>
      <div class="foot">
        <div class="bar"><i></i></div>
        <div class="log"></div>
        <div class="actions">
          <button class="primary btn-run">开始同步</button>
          <button class="stop btn-stop" disabled>停止</button>
        </div>
      </div>`;

    wrap.appendChild(fab);
    wrap.appendChild(panel);
    root.appendChild(style);
    root.appendChild(wrap);

    ui.host = host;
    ui.root = root;
    ui.fab = fab;
    ui.panel = panel;
    ui.listEl = panel.querySelector(".list");
    ui.bar = panel.querySelector(".bar i");
    ui.barText = panel.querySelector(".count");
    ui.logEl = panel.querySelector(".log");
    ui.subEl = panel.querySelector(".sub");
    ui.btnScan = panel.querySelector(".btn-scan");
    ui.btnAll = panel.querySelector(".btn-all");
    ui.btnRun = panel.querySelector(".btn-run");
    ui.btnStop = panel.querySelector(".btn-stop");
    ui.swWiki = panel.querySelector('[data-k="syncWiki"]');
    ui.swPrune = panel.querySelector('[data-k="prune"]');

    bind();
  }

  function bind() {
    ui.fab.addEventListener("mousedown", onDragStart);
    document.addEventListener(
      "mousedown",
      (e) => {
        if (!ui.panel.classList.contains("open")) return;
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(ui.host)) togglePanel(false);
      },
      true
    );

    ui.panel.querySelector(".x").addEventListener("click", () => togglePanel(false));

    ui.swWiki.addEventListener("click", () => {
      state.opts.syncWiki = !state.opts.syncWiki;
      saveOpts();
      renderOpts();
    });
    ui.swPrune.addEventListener("click", () => {
      state.opts.prune = !state.opts.prune;
      saveOpts();
      renderOpts();
    });

    ui.btnScan.addEventListener("click", async () => {
      if (state.scanning || state.running) return;
      if (state.mode === "repo") {
        scan([state.path], true);
        return;
      }
      state.scanning = true;
      state.log = "正在收集仓库列表…";
      renderSummary();
      const paths = await collectRepoPathsAll();
      state.scanning = false;
      scan(paths, false);
    });

    ui.btnAll.addEventListener("click", () => {
      const usable = state.items.filter((i) => i.state !== "noimport");
      const allOn = usable.length > 0 && usable.every((i) => i.checked);
      usable.forEach((i) => {
        i.checked = !allOn;
      });
      renderList();
      updateSummary();
    });

    ui.btnRun.addEventListener("click", run);
    ui.btnStop.addEventListener("click", () => {
      state.stopFlag = true;
      ui.btnStop.disabled = true;
      state.log = "正在停止…";
      renderSummary();
    });
  }

  /* 拖拽 + 点击抑制 */
  function onDragStart(e) {
    if (e.button !== 0) return;
    const rect = ui.fab.getBoundingClientRect();
    ui.drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false, at: 0 };
    const move = (ev) => {
      if (!ui.drag) return;
      const dx = ev.clientX - ui.drag.x;
      const dy = ev.clientY - ui.drag.y;
      if (!ui.drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      ui.drag.moved = true;
      const w = ui.fab.offsetWidth;
      const h = ui.fab.offsetHeight;
      const left = Math.min(Math.max(0, ui.drag.left + dx), window.innerWidth - w);
      const top = Math.min(Math.max(0, ui.drag.top + dy), window.innerHeight - h);
      ui.fab.style.left = left + "px";
      ui.fab.style.top = top + "px";
      ui.fab.style.right = "auto";
      ui.fab.style.bottom = "auto";
    };
    const up = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      if (ui.drag && ui.drag.moved) {
        const r = ui.fab.getBoundingClientRect();
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
        } catch (_) {}
        state.dragEndedAt = Date.now();
      }
      setTimeout(() => {
        ui.drag = null;
      }, 0);
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  }

  function fabClick() {
    if (Date.now() - state.dragEndedAt < 250) return;
    togglePanel();
  }

  function togglePanel(force) {
    const open = typeof force === "boolean" ? force : !ui.panel.classList.contains("open");
    if (open) {
      // 先按悬浮入口当前位置定位，再隐藏入口（隐藏后它的 rect 会变 0）
      const r = ui.fab.getBoundingClientRect();
      const w = ui.panel.offsetWidth || 392;
      const bottom = Math.max(10, window.innerHeight - r.top + 10);
      const right = Math.max(8, Math.min(window.innerWidth - w - 8, window.innerWidth - r.right));
      ui.panel.style.top = "";
      ui.panel.style.bottom = bottom + "px";
      ui.panel.style.right = right + "px";
    }
    ui.panel.classList.toggle("open", open);
    // 面板打开时收起悬浮入口，避免两个主按钮并存
    ui.fab.style.display = open ? "none" : "";
    syncPanelPos();
    if (open) {
      if (state.mode === "repo" && !state.items.length) {
        state.items = [
          { path: state.path, name: state.path.split("/")[1], importUrl: "", checked: false, state: "idle", msg: "" },
        ];
        renderList();
        updateSummary();
        scan([state.path], true);
      }
    }
  }

  function syncPanelPos() {
    try {
      const pos = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (pos && typeof pos.x === "number") {
        ui.fab.style.left = pos.x + "px";
        ui.fab.style.top = pos.y + "px";
        ui.fab.style.right = "auto";
        ui.fab.style.bottom = "auto";
      }
    } catch (_) {}
  }

  function renderOpts() {
    ui.swWiki.classList.toggle("on", !!state.opts.syncWiki);
    ui.swPrune.classList.toggle("on", !!state.opts.prune);
  }

  function renderList() {
    ui.listEl.textContent = "";
    ui.rows.clear();
    state.items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "row" + (item.checked ? " on" : "");
      const cb = document.createElement("i");
      cb.className = "cb";
      const meta = document.createElement("div");
      meta.className = "meta";
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = item.name;
      const src = document.createElement("div");
      src.className = "src";
      src.textContent = item.path;
      meta.appendChild(nm);
      meta.appendChild(src);
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = "待扫描";
      row.appendChild(cb);
      row.appendChild(meta);
      row.appendChild(chip);
      row.addEventListener("click", () => {
        if (state.running || state.scanning) return;
        if (item.state === "noimport") return;
        item.checked = !item.checked;
        row.classList.toggle("on", item.checked);
        updateSummary();
      });
      ui.listEl.appendChild(row);
      ui.rows.set(item.path, { row, chip, src });
      updateRow(item);
    });
  }

  function updateRow(item) {
    const r = ui.rows.get(item.path);
    if (!r) return;
    const [text, kind] = CHIP[item.state] || CHIP.idle;
    r.chip.textContent = text;
    r.chip.className = "chip" + (kind ? " " + kind : "");
    r.row.classList.toggle("on", !!item.checked);
    r.row.classList.toggle("locked", item.state === "noimport");
    if (item.state === "error" && item.msg) {
      r.src.textContent = item.msg;
      r.src.classList.add("err");
    } else {
      r.src.classList.remove("err");
      r.src.textContent = item.importUrl
        ? item.importUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "github: ")
        : item.path;
    }
    r.src.title = item.msg || item.importUrl || item.path;
  }

  function updateSummary() {
    const usable = state.items.filter((i) => i.state !== "noimport");
    const on = usable.filter((i) => i.checked);
    const total = on.length;
    const finish = on.filter((i) => i.state === "done" || i.state === "error").length;
    const done = on.filter((i) => i.state === "done").length;
    ui.bar.style.width = total ? Math.min(100, Math.round((finish / total) * 100)) + "%" : "0%";
    ui.bar.classList.toggle("ok", total > 0 && finish === total && done === total);
    ui.bar.classList.toggle("err", total > 0 && finish === total && done < total);
    ui.barText.textContent = state.items.length
      ? "已选 " + on.length + " / " + usable.length + " 个仓库"
      : "未扫描";
    const dot = ui.fab.querySelector(".dot");
    // 徽标只提示还等着同步的数量，全部完成后消失
    const pending = on.filter((i) => i.state !== "done" && i.state !== "error").length;
    if (pending > 0) {
      dot.style.display = "";
      dot.textContent = String(pending);
    } else {
      dot.style.display = "none";
    }
  }

  function renderSummary() {
    ui.logEl.textContent = state.log || "";
    ui.btnRun.disabled = state.running || state.scanning || pickTargets().length === 0;
    ui.btnStop.disabled = !state.running;
    ui.btnScan.disabled = state.running || state.scanning;
    ui.btnAll.disabled = state.running || state.scanning || !state.items.length;
    const on = state.items.filter((i) => i.checked && i.state !== "noimport");
    const allDone = on.length > 0 && on.every((i) => i.state === "done");
    ui.btnRun.textContent = state.running ? "同步中…" : allDone ? "再次同步" : "开始同步";
    updateSummary();
  }

  /* ---------- 入口 ---------- */

  function isImportedPage() {
    return typeof window.title_import_url === "string" && !!window.title_import_url;
  }

  function mountRepoButton() {
    if (!state.path || !isImportedPage()) return;
    const bar = document.querySelector(".git-project-header-actions");
    if (!bar || bar.querySelector(".gs-head-btn")) return;
    const btn = document.createElement("a");
    btn.className = "gs-head-btn";
    btn.href = "javascript:void(0)";
    btn.title = "从 GitHub 强制同步";
    btn.innerHTML = ICON;
    btn.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:4px;" +
      "border-radius:6px;color:#fe7300;vertical-align:middle;transition:background .15s";
    btn.addEventListener("mouseenter", () => (btn.style.background = "#fff3e8"));
    btn.addEventListener("mouseleave", () => (btn.style.background = "transparent"));
    btn.addEventListener("click", () => togglePanel(true));
    bar.insertBefore(btn, bar.firstChild);
  }

  function init() {
    const page = detectPage();
    state.mode = page.mode;
    state.path = page.path;
    if (!state.mode) return;

    mount();
    syncPanelPos();
    renderOpts();
    ui.fab.addEventListener("click", fabClick);
    ui.subEl.textContent =
      state.mode === "repo" ? state.path : location.pathname.replace(/^\//, "") + " · 批量同步";
    renderSummary();

    if (state.mode === "repo") {
      mountRepoButton();
      const paths = [state.path];
      if (window.title_import_url === undefined) {
        // 仓库页服务端渲染，变量缺失说明不是导入仓库，等卡片打开时再判定
      }
      state.items = [
        { path: state.path, name: state.path.split("/")[1], importUrl: "", checked: false, state: "idle", msg: "" },
      ];
      renderList();
      updateSummary();
      scan(paths, true).then(() => {
        const btn = document.querySelector(".gs-head-btn");
        if (btn && !state.items.some((i) => i.importUrl)) btn.remove();
      });
    }
  }

  /* 站内切换页面时重新识别 */
  function watchNav() {
    setInterval(() => {
      if (location.href === state.lastHref) return;
      state.lastHref = location.href;
      const page = detectPage();
      if (page.mode === state.mode && page.path === state.path) return;
      if (state.running) return;
      state.mode = page.mode;
      state.path = page.path;
      state.items = [];
      state.log = "";
      renderList();
      renderSummary();
      if (state.mode) {
        ui.subEl.textContent =
          state.mode === "repo" ? state.path : location.pathname.replace(/^\//, "") + " · 批量同步";
        if (state.mode === "repo") {
          mountRepoButton();
          state.items = [
            { path: state.path, name: state.path.split("/")[1], importUrl: "", checked: false, state: "idle", msg: "" },
          ];
          renderList();
          updateSummary();
          scan([state.path], true);
        }
      }
    }, 1000);
  }

  async function boot() {
    const saved = await storeGet();
    if (saved[OPT_KEY]) state.opts = Object.assign(state.opts, saved[OPT_KEY]);
    if (saved[CACHE_KEY]) state.cache = saved[CACHE_KEY];
    init();
    watchNav();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "gs-toggle") togglePanel();
    });
  } catch (_) {}
})();
