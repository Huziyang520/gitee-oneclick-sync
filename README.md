# Gitee 一键同步

Chrome / Edge（Manifest V3）扩展：在 Gitee 仓库列表页批量、在单仓库页单独，强制从 GitHub 同步。

## 加载

`chrome://extensions` → 打开开发者模式 → 加载已解压的扩展程序 → 选择本目录。
Edge 同理（`edge://extensions`）。

## 使用

- 批量：打开 `gitee.com/<用户名>/projects`，点右下角「同步」→「扫描」（自动翻页收集全部仓库）→ 勾选 →「开始同步」。
- 单个：打开仓库主页，点标题栏左侧的橙色同步图标，或在右下角面板里操作。

两个选项（同步 Wiki、删除远端不存在的分支和标签）对本次同步全部生效，选择会记住。

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单，仅申请 `storage` 与 `https://gitee.com/*` |
| `content.js` | 扫描、提交同步、轮询状态与 Shadow DOM 面板 |
| `background.js` | 工具栏图标点击时开合面板 |
| `icons/` | 16 / 48 / 128 图标 |

## 接口

同步走 Gitee 页面自身使用的接口，不模拟点击：

- `POST /{owner}/{repo}/force_sync_project` — 参数 `sync_wiki`、`prune`、`authenticity_token`；返回 `status === 0` 为失败
- `GET /{owner}/{repo}/check_fetch` — 返回 `{ in_fetch, error_msg }`
