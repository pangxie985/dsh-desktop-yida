# dsh-desktop-yida

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）装上一双手：**用 AI 直接创建、修改钉钉宜搭（Yida）应用**，并在右侧栏「宜搭工作台」里查看与打开应用。

这是一个 DSH 插件，基于开源 CLI [OpenYida](https://github.com/openyida/openyida) 封装。你用自然语言描述需求，AI 读 Schema、生成变更、跑命令、回读校验，最后把应用丢进右侧内置浏览器里给你看。

```
 你说话
   │
   ▼
 AI（DSH 里的模型）⇄ DSH 工具层 ⇄ dsh-desktop-yida（host 半）──spawn──▶ openyida CLI ──HTTPS──▶ 宜搭
                                        │
                                  /yida/api/*（只读，回环）
                                        │
                          client 半「宜搭工作台」⇄ DSH 内置浏览器标签页
```

---

## 目录

- [先认识四个名词](#先认识四个名词)
- [功能](#功能)
- [安装](#安装)
- [首次使用：登录宜搭](#首次使用登录宜搭)
- [使用方法](#使用方法)
- [安全闸门](#安全闸门)
- [配置项](#配置项)
- [常见问题](#常见问题)
- [兼容性](#兼容性)
- [合规提醒（请先读）](#合规提醒请先读)
- [开发](#开发)
- [License](#license)

---

## 先认识四个名词

| 名词 | 是什么 | 和本插件的关系 |
|---|---|---|
| **钉钉（DingTalk）** | 阿里旗下的企业协同办公平台 | 宜搭运行在钉钉生态内，账号、组织、权限都来自钉钉 |
| **宜搭（Yida）** | 钉钉的低代码平台：可视化拖拽配置页面、表单、流程，一键发布 | 本插件操作的目标系统。企业专属站点形如 `https://xxxxxx.aliwork.com` |
| **[OpenYida](https://github.com/openyida/openyida)** | 开源（MIT）的宜搭命令行工具，npm 包名 `openyida` | 本插件的「手」：所有真实操作都通过它执行 |
| **DSH（DeepSeek Harness）** | 本插件运行的宿主：带工具调用能力的 AI Agent 桌面端 | 提供工具注册、右侧栏、内置浏览器 |

关于 OpenYida 的能力边界，值得先知道两点：

- **官方 OpenAPI 只能操作「数据」**（表单实例、流程实例、审批任务、附件），元数据只有只读接口；**创建/修改应用与表单结构**只能用登录态的接口，OpenYida 封装的就是这条路。
- 它需要**你自己的宜搭登录态**（`openyida login`），不占用钉钉开放平台的授权包。

## 功能

### 1. 14 个 `yida_*` 工具

| 工具 | 类型 | 作用 |
|---|---|---|
| `yida_status` | 只读 | CLI 版本、登录态、工作目录 —— 开工前先跑它 |
| `yida_org_list` | 只读 | 列出登录态可访问的组织 |
| `yida_org_switch` | 写入 | 切换本地登录组织（只改本地凭据指针，不动宜搭数据） |
| `yida_apps` | 只读 | 列应用。`scope`：`mine` / `admin`（我是管理员）/ `all`（我能访问的全部） |
| `yida_forms` | 只读 | 列应用下的表单/页面 |
| `yida_schema` | 只读 | 读表单 Schema（字段、fieldId、校验规则）—— **改表单前必做** |
| `yida_app_entry` | 只读 | 读平台登记的前端入口 / 管理台地址 |
| `yida_data_query` | 只读 | 查表单数据实例（分页） |
| `yida_urls` | 只读 | 推导页面地址；`open: true` 时请求右侧内置浏览器打开 |
| `yida_create_app` | 写入 | 建应用 |
| `yida_create_form` | 写入 | 建表单页（字段 JSON 定义，支持 19 种业务组件 + 分组） |
| `yida_update_form` | 写入 | 增量改已有表单（保留其它现有组件） |
| `yida_patch_form` | 写入 | 按 JSON Pointer 深合并改表单 |
| `yida_publish_page` | 写入 | 编译并发布自定义页面（`.canvas.jsx`） |

### 2. 右侧栏「宜搭工作台」

- 登录态徽标、CLI 来源；
- **「登录」/「登出」按钮**（见下）；
- 口径切换：**我管理的** / **我能访问**；
- 应用列表 → 一键「打开（工作台）」「管理台」「表单」；
- 表单列表 → 打开表单页；
- 地址框：粘贴任意宜搭地址，直接在内置浏览器里打开；
- 后台轮询：AI 侧调用 `yida_urls { open: true }` / `yida_login` 后，工作台会自动把页面开进内置浏览器。

> 内置浏览器是 DSH 桌面版自带的 Electron `<webview>`，能带登录态打开宜搭。
> 它**不向模型暴露页面操作能力**——本插件的分工是「AI 负责改，浏览器负责看」。

### 3. 登录 / 登出（不依赖浏览器代理插件）

工作台工具栏上的两个按钮：

| 按钮 | 行为 |
|---|---|
| **登录** | 后台启动 `openyida login`（`OPENYIDA_NO_BROWSER=1`，不拉起系统浏览器），从 CLI 输出里抓出钉钉授权 URL，**交给 DSH 内置浏览器打开**；随后轮询登录态，成功即刷新应用列表 |
| **登出** | 调用 `openyida logout`，清空本机登录态 |

模型侧也有对应工具：

```
yida_login                 # 拿授权 URL，并把 URL 排进右侧栏打开队列
yida_logout { confirm: true }
```

**这条链路完全不需要 `dsh-browser-agent`**：只用到 DSH 自带的「浏览器」标签页（`ctx.sidebarRight.openTab('browser', …)`）。
钉钉授权完成后，回调会打到 CLI 自己起的 `127.0.0.1` loopback 端口（默认 5 分钟超时），登录态落盘到用户目录（`%APPDATA%\openyida\auth`），desktop / web profile 共用。

## 安装

**前置**：DSH 桌面版、Node.js ≥ 20、一个能登录宜搭的钉钉账号。

```bash
git clone https://github.com/pangxie985/dsh-desktop-yida.git
cd dsh-desktop-yida
node scripts/install.mjs
```

安装脚本做四件事（幂等，改前自动备份 `.bak-<时间戳>`）：

1. 在插件目录 `npm install openyida`（这样你不用全局装 CLI）；
2. 在 profile 的 `node_modules` 里建目录联接（Windows 用 junction，不需要管理员）；
3. 往 profile 的 `package.json` 写 `"dsh-desktop-yida": "link:<插件目录>"` 并加入 `dsh.profile.bundles`；
4. 最后才往 `cordis.patch.yml` 写挂载行。

> **顺序是有讲究的**：DSH 桌面版会热监听 profile 配置。如果配置先出现一个还解析不到的包名，加载器会失败甚至把宿主重启。所以脚本严格按「先让包可解析，再改配置」执行——这也是我自己踩过的坑。

**重启 DSH** 让 Host 半生效（会中断当前会话）。

其他用法：

```bash
node scripts/install.mjs --profile web   # 装到 web profile（注意：web 端侧栏不可用，见「兼容性」）
node scripts/install.mjs --uninstall     # 卸载
node scripts/install.mjs --skip-cli      # 不自动装 openyida（你自己管）
```

## 首次使用：登录宜搭

```bash
# 用插件目录里那份 CLI（推荐，版本和插件一起管）
node node_modules/openyida/bin/yida.js login

# 或者你已全局装过
openyida login
```

登录成功后，在 DSH 里让 AI 调 `yida_status`，看到 `loginStatus: "ok"` 就通了。
多组织账号可以 `yida_org_list` 看有哪些组织、`yida_org_switch` 切过去。

## 使用方法

### A. 直接对 AI 说人话（推荐）

| 你想做的事 | 这样说 |
|---|---|
| 盘点应用 | 「列出我是管理员的宜搭应用」 |
| 看结构 | 「读一下 APP_XXX 的表单列表」「把设备台账的 Schema 拉出来」 |
| 建应用 | 「新建一个叫『XX 管理』的宜搭应用」 |
| 建表单 | 「在 APP_XXX 建表单『客户登记』，字段：客户名称、客户编号、联系人手机、地址定位」 |
| 改表单 | 「给客户登记表加一个『是否重点客户』下拉字段（是/否）」 |
| 发布页面 | 「把这个页面发布到 APP_XXX / FORM-XXX」 |
| 看效果 | 「在右侧浏览器打开 APP_XXX 的工作台」 |

AI 会按固定节奏走：**读 → 改 → dry-run 给你看命令 → 你确认 → 写入 → 回读校验 → 打开给你看**。

### B. 右侧栏工作台

1. `Ctrl + Alt + B` 展开右侧栏（Web 版是 `Ctrl + Shift + B`）；
2. 在 guide 里选「**宜搭工作台**」；
3. 「我管理的 / 我能访问」切换口径，点应用上的「打开」即可在内置浏览器看到真实应用。

### C. 不经过 AI，直接用 CLI

```bash
node node_modules/openyida/bin/yida.js app-list --type managed
node node_modules/openyida/bin/yida.js list-forms APP_XXXXXXXX
node node_modules/openyida/bin/yida.js get-schema APP_XXXXXXXX FORM-XXXXXXXX --summary-json
node node_modules/openyida/bin/yida.js create-form create APP_XXXXXXXX "客户登记" fields.json
node node_modules/openyida/bin/yida.js data query form APP_XXXXXXXX FORM-XXXXXXXX --page 1 --size 20
```

### 一个真实的字段定义示例

建表单时传给 `yida_create_form` 的 `fieldsFile`：

```json
[
  { "type": "Divider", "title": "设备信息", "dividerType": "bold-with-thin" },
  { "type": "TextField", "label": "设备名称", "required": true, "placeholder": "请输入设备名称" },
  { "type": "TextField", "label": "设备编号", "required": true },
  { "type": "Divider", "title": "客户信息", "dividerType": "bold-with-thin" },
  { "type": "TextField", "label": "客户名称" },
  { "type": "TextField", "label": "客户编号" },
  { "type": "AddressField", "label": "设备定位" }
]
```

常用组件：`TextField` 单行文本、`TextareaField` 多行、`NumberField` 数字、`SelectField` 下拉、`RadioField` 单选、`CheckboxField` 多选、`DateField` 日期、`EmployeeField` 成员、`AddressField` 地址/定位、`AttachmentField` 附件、`ImageField` 图片、`TableField` 子表格、`Divider` 分组标题、`ColumnContainer` 分栏。
完整清单见 [OpenYida 字段速查](https://github.com/openyida/openyida/blob/main/yida-skills/references/field-and-url-reference.md)。

## 安全闸门

写入类工具必须**同时**满足两个条件才会真正执行：

1. 插件设置里 `allowRemoteWrites` 为真（默认开，可关死）；
2. 调用时显式传 `confirm: true`。

任何一条不满足，工具**不执行**，只回显将要运行的完整命令。所有写工具都支持 `dryRun: true`，先看命令再决定。

此外：

- `/yida/api/*` 只暴露只读接口，且只接受回环 Host（防 DNS rebinding）；
- 不做批量、无人值守的改造 —— 这类操作风险与合规成本都太高。

## 配置项

在 DSH 的插件设置里改（对应 `cordis.patch.yml` 的 `config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `cliPath` | 空 | openyida 入口绝对路径；留空则依次找：插件自带 `node_modules` → `OPENYIDA_CLI` 环境变量 → `PATH` |
| `projectDir` | 空 | CLI 工作目录（生成的 `.cache/openyida` 产物落这里）；留空用宿主进程 cwd |
| `baseUrl` | 空 | 宜搭站点；**留空自动用当前登录站点**（企业专属站点不是 `www.aliwork.com`，强烈建议留空） |
| `allowRemoteWrites` | `true` | 关掉后所有写入工具一律拒绝 |
| `timeoutMs` | `180000` | 单次 CLI 调用超时 |
| `maxInlineBytes` | `24000` | 工具返回给模型的最大字符数 |

## 常见问题

**Q：`yida_apps` 返回 0 个应用，但我明明有应用？**
OpenYida 的 `app-list` 会硬编码 `creator=<我的 userId>`，只列「我自己创建的」。别人创建、而你是管理员的应用不会出现。
用 `yida_apps { scope: "admin" }`（我是管理员）或 `{ scope: "all" }`（我能访问的全部），右侧栏工作台也有对应切换。

**Q：生成的链接打不开 / 指向 `www.aliwork.com`？**
你的宜搭是专属站点（形如 `https://xxxxxx.aliwork.com`）。`baseUrl` 留空时插件会自动读登录站点；如果你手工填了 `baseUrl`，请改成自己的站点。

**Q：右侧栏找不到「宜搭工作台」？**
① 先在 GUI 里硬刷新一次（`Ctrl+Shift+R`）让 client 半加载；② 右侧栏默认是收起的，按 `Ctrl+Alt+B` 展开；③ 展开后在 guide / 新建标签里找。

**Q：改了代码什么时候生效？**
`lib/client.js`（client 半）会自动热加载；`lib/index.js`（Host 半）**必须重启 DSH**。

**Q：安装时报 `Cannot find module '@babel/standalone'`？**
OpenYida CLI 的依赖没装全。执行 `npm install --prefix . openyida` 后重试（`scripts/install.mjs` 默认会做）。

**Q：登录态过期？**
重新 `openyida login`。登录态存在用户目录（`%APPDATA%\openyida\auth`），与 DSH profile 无关，desktop / web 两个 profile 共用。

## 兼容性

| 环境 | 工具（Host 半） | 右侧栏（Client 半） | 内置浏览器看应用 |
|---|---|---|---|
| **DSH 桌面版**（0.2.x） | ✅ 实测通过 | ✅ | ✅（Electron `<webview>`） |
| DSH web profile | ⚠️ 理论可用，未实测 | ❌ 不可用 | ❌ 不可用 |

web 端不可用的原因不是本插件的问题，而是载体限制：

1. web profile 的 DSH 运行时（0.1.x）**没有**官方的 `dsh-client-ui-sidebar-right` / `dsh-client-ui-slots` 这套右侧栏包，web 端的右侧栏由生态插件 `dsh-better-sidebar` 提供（另一套 `ctx.betterSidebar.registerTab` API）；
2. web 版的内置浏览器是 **sandbox iframe**，而宜搭返回 `X-Frame-Options: SAMEORIGIN`，浏览器直接拒绝嵌入。

所以 web 端建议只把它当「执行工具」用：AI 干活，结果用系统浏览器看。

平台：Windows 实测通过；macOS / Linux 未实测（路径与进程调用均使用 Node API，理论上可用，欢迎 PR 反馈）。

## 合规提醒（请先读）

- **OpenYida 不是钉钉官方授权工具**。它通过**登录态**调用宜搭的接口，其中「创建/修改应用与表单结构」走的是内部接口路径。
- 《钉钉服务协议》第八条（软件使用规范）包含「通过非钉钉公司开发、授权的第三方软件、插件、外挂、系统，登录或使用软件及服务」的禁止性条款；《宜搭服务使用规则》另有系统配置、反向工程等条款。**是否适用、如何解释，认定权在钉钉**。
- 因此建议：**只对你自己有权限的应用使用；写入前保留确认；不要在公司内部分发、运营这类工具；不要把批量导出组织数据当作常规操作。**
- 用到生产环境前，请让公司合规/法务确认，或向宜搭官方书面确认。
- **这不是法律意见**，条款以钉钉官网最新版本为准。

## 开发

```
dsh-desktop-yida/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # profile 挂载行
├── lib/
│   ├── index.js          # Host 半：14 个工具 + /yida/api/* 只读路由
│   ├── client.js         # Client 半：window.__ModuleLoader__ bundle（宜搭工作台）
│   ├── yida-cli.js       # CLI 定位 / 参数编译 / JSON 解析 / URL 推导
│   ├── yida-auth.js      # 登录态与只读接口桥接（应用列表口径、站点识别）
│   └── schema.js         # defineTool / defineConfig 同形实现（零外部依赖）
├── scripts/install.mjs   # 安装 / 卸载（步骤顺序有讲究）
├── tools/                # 排查脚本：组织清单、应用口径对比
└── test/                 # 58 项测试 + 假 CLI + 真实 CLI 冒烟
```

```bash
npm test        # 58 项：参数/URL/JSON、Host 工具与路由、client bundle 契约
npm run smoke   # 用真实 openyida CLI 跑只读命令（不写任何数据）
```

**加一个新工具**：在 `lib/yida-cli.js` 的 `buildArgs()` 里加一个 operation，再在 `lib/index.js` 的 tools 数组里用 `readTool(...)` / `writeTool(...)` 注册即可；测试里补一条参数编译用例。

### 为什么不用 bundler

client 半是手写的 `window.__ModuleLoader__.load({ id, factory })` 单文件，`require('react')` 由宿主的平台模块表解析。省掉构建链，改完直接生效。

## 插件市场 / 索引

**仓库被 fork 或 star 不会被任何市场自动收录。** DSH 的插件市场是「索引源驱动」的，需要主动登记：

### 官方市场（DSH 自带，「插件 → 发现」）

官方市场读的是**索引源 URL**（format 1 的 JSON）。本仓库已经准备好一份，并用官方校验器 `@deepseek-ai/dsh-plugin-market-index` 验证通过：

```
https://raw.githubusercontent.com/pangxie985/dsh-desktop-yida/main/market/index.json
```

添加方式：

1. 插件页 → **发现** → **添加索引源**；
2. 粘贴上面的 URL，保存；
3. 列表里就会出现「**宜搭 AI 开发（dsh-desktop-yida）**」，点安装。

> 索引里的安装源是 **git + commit 固定**（`git+https://github.com/...#<40位 SHA>`），所以装到的是可复现的版本，不会跟着 `main` 漂移。
> 发新版本时重新跑 `node scripts/build-market-index.mjs` 更新 commit，再提交即可。

### 第三方市场 dshmarket

[dshmarket](https://github.com/dsh-market/dsh-market) 的目录来自**它自己发布的 npm 包里的 `plugins.json`**（见其 `catalog-npm.ts`）。想被它收录需要：

1. 把插件**发布到 npm**（它优先安装「经仓库验证的 npm 包」）；
2. 向它的 catalog 仓库提 PR，在 `plugins.json` 里加一条条目。

### 让安装体验最好：发布到 npm

目前索引用的是 git 源，安装时 pnpm 会拉整仓源码。如果发布到 npm：

```bash
npm publish          # 之后可把 market/index.json 的 source 改成 { "type": "npm" }
```

这样安装只需数秒、无需本地构建，也更容易被第三方市场收录。

## License

[MIT](./LICENSE)

本插件与钉钉、阿里云、阿里巴巴集团无隶属关系；OpenYida 由其各自作者维护，遵循其自身的 MIT 许可。
