# 维护者文档

面向要**改代码、跑测试、发布、上架市场**的人。普通使用者看 [README](../README.md) 就够了。

## 仓库结构

```
dsh-desktop-yida/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle 自带的挂载行（由 dsh.profile.bundles 触发）
├── lib/
│   ├── index.js          # Host 半：16 个工具 + /yida/api/* 路由
│   ├── client.js         # Client 半：window.__ModuleLoader__ bundle（宜搭工作台）
│   ├── yida-cli.js       # CLI 定位 / 参数编译 / JSON 解析 / URL 推导
│   ├── yida-auth.js      # 登录态与只读接口桥接（应用列表口径、站点识别）
│   ├── yida-login.js     # 登录进程（detached + 日志轮询）
│   ├── patch-file.mjs    # cordis.patch.yml 纯文本清理（安装/卸载共用）
│   └── schema.js         # defineTool / defineConfig 同形实现（零外部依赖）
├── scripts/
│   ├── install.mjs       # 安装 / 卸载（步骤顺序有讲究）
│   └── build-market-index.mjs
├── tools/                # 排查脚本：组织清单、应用口径对比
├── test/                 # 82 项测试 + 假 CLI + 真实 CLI 冒烟
├── market/               # 官方市场索引源 + 投稿条目
└── docs/                 # 维护者文档（本文件）
```

```bash
npm test        # 82 项：参数/URL/JSON、Host 工具与路由、登录状态机、patch 清理、client bundle 契约
npm run smoke   # 用真实 openyida CLI 跑只读命令（不写任何数据）
```

**加一个新工具**：在 `lib/yida-cli.js` 的 `buildArgs()` 里加一个 operation，再在 `lib/index.js` 的 tools 数组里用 `readTool(...)` / `writeTool(...)` 注册；测试补一条参数编译用例。

### 为什么不用 bundler

client 半是手写的 `window.__ModuleLoader__.load({ id, factory })` 单文件，`require('react')` 由宿主的平台模块表解析。省掉构建链，改完直接生效。

### 安装脚本的两条铁律

1. **先让包可解析，再改配置**：DSH 桌面版热监听 profile 配置，配置里出现解析不到的包名会触发加载失败甚至宿主重启。顺序固定为「联接 → package.json → 配置」。
2. **「装上了」≠「能用」**：CLI 装完必须真实执行一次 `agent-capabilities --json`；失败就 `exit 1`，绝不能打印"安装完成"。

### 为什么只写 `dsh.profile.bundles`、不写 `cordis.patch.yml`

实测（去掉 profile patch 里的挂载行后 `/yida/api/status` 仍返回 200）证明 `bundles` 单独就足以挂载。两者都写会导致同一 id **挂载两次**，且往 `[]` 空文档里追加文本会写出非法 YAML，整个 profile 起不来（已由 `lib/patch-file.mjs` 兜住历史脏数据）。

## 插件市场上架

**仓库被 fork 或 star 不会被任何市场自动收录。** DSH 的插件市场是「索引源驱动」的，需要主动登记。

### 官方市场（DSH 自带，「插件 → 发现」）

官方市场读 format 1 的 JSON 索引源。本仓库已备好一份，并用官方校验器 `@deepseek-ai/dsh-plugin-market-index` 验证通过：

```
https://raw.githubusercontent.com/pangxie985/dsh-desktop-yida/main/market/index.json
```

用户添加方式：插件页 → **发现** → **添加索引源** → 粘贴上面的 URL → 保存。

> 索引里的安装源是 **git + commit 固定**（`git+https://github.com/...#<40位 SHA>`），装到的是可复现版本。
> 发新版本时重跑 `node scripts/build-market-index.mjs` 更新 commit 再提交。

### 第三方市场 dshmarket

dshmarket 的目录来自它自己发布的 npm 包里的 `plugins.json`。想被收录需要：① 把插件发布到 npm；② 向其 catalog 仓库提 PR，在 `plugins.json` 里加一条。

### 发布到 npm（提升安装体验）

目前索引用 git 源，装的时候 pnpm 会拉整仓源码。发布到 npm 后：

```bash
npm publish          # 之后可把 market/index.json 的 source 改成 { "type": "npm" }
```

安装只需数秒、无需本地构建，也更容易被第三方市场与 DSH GUI 插件管理器收录（GUI 走 pnpm，没有 git 的机器只能靠 npm 包安装）。

发布前检查：

- `package.json` 的 `files` 覆盖 `lib/**/*`、`scripts/**/*`、`cordis.patch.yml`、`README.md`、`LICENSE`；
- `dsh.client` 的 bundle（`lib/client.js`）会被 `exports["./client"]` 导出；
- `openyida` 已声明为 `dependencies`，让 npm 安装时一并装好 CLI；
- `lib/yida-cli.js` 的候选里包含 `require.resolve('openyida/bin/yida.js')`，兼容 pnpm 的嵌套/提升布局。
