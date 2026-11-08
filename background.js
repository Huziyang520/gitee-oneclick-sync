/**
 * Gitee 一键同步 · service worker
 * 点击工具栏图标时让内容脚本开合面板。
 */
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !/^https:\/\/gitee\.com\//.test(tab.url || "")) return;
  chrome.tabs.sendMessage(tab.id, { type: "gs-toggle" }, () => void chrome.runtime.lastError);
});
