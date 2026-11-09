/**
 * Gitee 一键同步 · service worker
 * 1) 工具栏图标点击 → 让内容脚本开合面板
 * 2) 发行版（Release）同步引擎：GitHub → Gitee
 *
 * 网络请求必须放在这里：content script 的 fetch 受页面 CORS 约束，
 * 跨域下载 GitHub 附件会被拦；service worker 有 host_permissions 就能直连。
 *
 * 用到的接口：
 *   GET    api.github.com/repos/{o}/{r}/releases
 *   GET    gitee.com/api/v5/repos/{o}/{r}/releases
 *   POST   gitee.com/api/v5/repos/{o}/{r}/releases
 *   GET    gitee.com/api/v5/repos/{o}/{r}/releases/{id}/attach_files
 *   POST   gitee.com/api/v5/repos/{o}/{r}/releases/{id}/attach_files   (multipart, 字段 file)
 */

const GITEE_API = "https://gitee.com/api/v5";
const GH_API = "https://api.github.com";
const GH_ACCEPT = { Accept: "application/vnd.github+json" };
const MAX_ASSET_DEFAULT = 100 * 1024 * 1024;

function ghHeaders(token) {
  const h = Object.assign({}, GH_ACCEPT);
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}

async function callJson(url, opt, label) {
  let res;
  try {
    res = await fetch(url, opt);
  } catch (e) {
    throw new Error(label + "：网络错误");
  }
  const json = await readJson(res);
  if (!res.ok) {
    const raw = json && (json.message || json.error) ? String(json.message || json.error) : "HTTP " + res.status;
    const err = new Error(label + "：" + raw);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function listGithubReleases(ghRepo, token) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const url = GH_API + "/repos/" + ghRepo + "/releases?per_page=100&page=" + page;
    const arr = await callJson(url, { headers: ghHeaders(token) }, "拉取 GitHub 发行版");
    if (!Array.isArray(arr) || !arr.length) break;
    out.push.apply(out, arr);
    if (arr.length < 100) break;
  }
  return out.filter((r) => r && !r.draft);
}

async function listGiteeReleases(repo, token) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const url =
      GITEE_API + "/repos/" + repo + "/releases?access_token=" + encodeURIComponent(token) +
      "&per_page=100&page=" + page;
    const arr = await callJson(url, {}, "读取 Gitee 发行版");
    if (!Array.isArray(arr) || !arr.length) break;
    out.push.apply(out, arr);
    if (arr.length < 100) break;
  }
  return out;
}

async function listGiteeAssets(repo, releaseId, token) {
  const url =
    GITEE_API + "/repos/" + repo + "/releases/" + releaseId + "/attach_files?access_token=" +
    encodeURIComponent(token) + "&per_page=100";
  const arr = await callJson(url, {}, "读取 Gitee 附件");
  return Array.isArray(arr) ? arr : [];
}

async function createGiteeRelease(repo, token, rel) {
  const body = new URLSearchParams();
  body.set("access_token", token);
  body.set("tag_name", rel.tag_name);
  body.set("name", rel.name || rel.tag_name);
  body.set("body", rel.body || "");
  body.set("prerelease", rel.prerelease ? "true" : "false");
  if (rel.target_commitish) body.set("target_commitish", rel.target_commitish);
  return callJson(
    GITEE_API + "/repos/" + repo + "/releases",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    "创建发行版 " + (rel.tag_name || "")
  );
}

async function uploadAsset(repo, releaseId, token, asset) {
  let res;
  try {
    res = await fetch(asset.browser_download_url, { redirect: "follow" });
  } catch (_) {
    throw new Error("下载附件失败：网络错误");
  }
  if (!res.ok) throw new Error("下载附件失败：HTTP " + res.status);
  const blob = await res.blob();
  const fd = new FormData();
  fd.append("file", blob, asset.name);
  const url =
    GITEE_API + "/repos/" + repo + "/releases/" + releaseId + "/attach_files?access_token=" +
    encodeURIComponent(token);
  return callJson(url, { method: "POST", body: fd }, "上传附件 " + asset.name);
}

/**
 * 把一个仓库的发行版从 GitHub 同步到 Gitee。
 * opts: { repo, ghRepo, giteeToken, githubToken, maxAssetBytes }
 * onProgress: ({ phase, msg }) => void
 */
async function syncReleases(opts, onProgress) {
  const repo = opts.repo;
  const ghRepo = opts.ghRepo;
  const token = opts.giteeToken;
  const maxBytes = opts.maxAssetBytes || MAX_ASSET_DEFAULT;
  const emit = typeof onProgress === "function" ? onProgress : function () {};
  const result = { repo: repo, total: 0, created: 0, existed: 0, assets: 0, assetSkipped: [], errors: [] };

  const ghList = await listGithubReleases(ghRepo, opts.githubToken);
  result.total = ghList.length;
  if (!ghList.length) return result;

  const giteeList = await listGiteeReleases(repo, token);
  const byTag = {};
  giteeList.forEach((r) => {
    if (r && r.tag_name) byTag[r.tag_name] = r;
  });

  for (let i = 0; i < ghList.length; i++) {
    const gh = ghList[i];
    const label = gh.tag_name || gh.name || "#" + gh.id;
    emit({ phase: "release", msg: "发行版 " + (i + 1) + "/" + ghList.length + "：" + label });
    let target = byTag[gh.tag_name];
    try {
      if (!target) {
        target = await createGiteeRelease(repo, token, gh);
        result.created++;
        byTag[gh.tag_name] = target;
      } else {
        result.existed++;
      }

      const assets = Array.isArray(gh.assets) ? gh.assets : [];
      if (!assets.length) continue;

      const have = {};
      try {
        const exist = await listGiteeAssets(repo, target.id, token);
        exist.forEach((a) => {
          if (a && a.name) have[a.name] = true;
        });
      } catch (_) {
        /* 附件列表读不到就当作全缺，靠上传失败兜底 */
      }

      for (const a of assets) {
        if (!a || !a.name || !a.browser_download_url) continue;
        if (a.state && a.state !== "uploaded") continue;
        if (have[a.name]) continue;
        if (typeof a.size === "number" && a.size > maxBytes) {
          result.assetSkipped.push(a.name + "（" + Math.round(a.size / 1048576) + "MB 超过单附件上限）");
          continue;
        }
        try {
          await uploadAsset(repo, target.id, token, a);
          result.assets++;
        } catch (e) {
          result.errors.push(label + " / " + a.name + "：" + (e.message || e));
        }
      }
    } catch (e) {
      result.errors.push(label + "：" + (e.message || e));
    }
  }
  return result;
}

/* ---------- 消息路由 ---------- */

function replyTo(tabId, payload) {
  if (!tabId) return;
  try {
    chrome.tabs.sendMessage(tabId, payload, () => void chrome.runtime.lastError);
  } catch (_) {}
}

const gsReleaseApi = { syncReleases: syncReleases };

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.action.onClicked.addListener((tab) => {
    if (!tab.id || !/^https:\/\/gitee\.com\//.test(tab.url || "")) return;
    chrome.tabs.sendMessage(tab.id, { type: "gs-toggle" }, () => void chrome.runtime.lastError);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "gs-release-sync") return;
    const tabId = sender && sender.tab ? sender.tab.id : 0;
    syncReleases(msg.payload, (p) => replyTo(tabId, { type: "gs-release-progress", repo: msg.payload.repo, msg: p.msg }))
      .then((result) => sendResponse({ ok: true, result: result }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  });
}

if (typeof globalThis !== "undefined") globalThis.__gsRelease = gsReleaseApi;
