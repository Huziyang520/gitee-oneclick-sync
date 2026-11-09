# Gitee 一键同步

Chrome / Edge（Manifest V3）扩展：在 Gitee 仓库列表页批量、在单仓库页单独，强制从 GitHub 同步，可选同时把发行版（Release）与附件搬到 Gitee。

## 加载

`chrome://extensions` → 打开开发者模式 → 加载已解压的扩展程序 → 选择本目录。
Edge 同理（`edge://extensions`）。

## 使用

- 批量：打开 `gitee.com/<用户名>/projects`，点右下角「同步」→「扫描」（自动翻页收集全部仓库）→ 勾选 →「开始同步」。
- 单个：打开仓库主页，点标题栏左侧的橙色同步图标，或在右下角面板里操作。

三个选项（同步 Wiki、删除远端不存在的分支和标签、同步发行版与附件）对本次同步全部生效，选择会记住。

### 发行版同步

勾选「同步发行版与附件」后，代码同步完成的仓库会继续把 GitHub 的 Release 搬到 Gitee：

1. 读取 GitHub 的发行版（跳过草稿），按 `tag_name` 与 Gitee 侧已有的发行版去重；
2. 缺少的按 `tag_name` / 标题 / 说明 / 预发布标记创建；
3. 逐个下载附件并上传，同名附件跳过；单个附件超过 100MB（Gitee 上限）直接跳过并在行内注明。

需要令牌：
- **Gitee 私人令牌**（必需）：Gitee → 设置 → 私人令牌，勾选 `projects` 权限。
- **GitHub Token**（可选）：不填时受 60 次/小时的限制，只适合少量仓库。

令牌只存在本机 `chrome.storage.local`，不上传任何地方。

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单，申请 `storage` 与 gitee / github / api.github.com / objects.githubusercontent.com 的访问权 |
| `content.js` | 扫描、提交同步、轮询状态与 Shadow DOM 面板 |
| `background.js` | 工具栏图标开合面板；发行版同步引擎（网络请求放这里以绕开页面 CORS） |
| `icons/` | 16 / 48 / 128 图标 |

## 接口

同步走 Gitee 页面自身使用的接口，不模拟点击：

- `POST /{owner}/{repo}/force_sync_project` — 参数 `sync_wiki`、`prune`、`authenticity_token`；返回 `status === 0` 为失败
- `GET /{owner}/{repo}/check_fetch` — 返回 `{ in_fetch, error_msg }`

发行版走 Gitee OpenAPI v5（需要 access_token）：

- `GET/POST /api/v5/repos/{owner}/{repo}/releases`
- `GET/POST /api/v5/repos/{owner}/{repo}/releases/{id}/attach_files`（multipart，字段 `file`）
