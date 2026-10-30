# dsh-desktop-yida

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）装上一双手：**用 AI 直接创建、修改钉钉宜搭（Yida）应用**，并在右侧栏「宜搭工作台」里查看与打开应用。

这是一个 DSH 插件，基于开源 CLI [OpenYida](https://github.com/openyida/openyida)（MIT）封装。你用自然语言描述需求，AI 读 Schema、生成变更、跑命令、回读校验，最后把应用丢进右侧内置浏览器里给你看。

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

## 目录

- [它是什么](#它是什么)
- [16 个工具](#16-个工具)
- [右侧栏「宜搭工作台」](#右侧栏宜搭工作台)
- [登录 / 登出](#登录--登出)
- [安装](#安装)
- [第一次使用](#第一次使用)
- [用法](#用法)
- [安全闸门](#安全闸门)
- [配置项](#配置项)
- [常见问题](#常见问题)
- [兼容性](#兼容性)
- [合规提醒（请先读）](#合规提醒请先读)
- [维护者文档](#维护者文档)

## 它是什么

| 参与方 | 是什么 | 与本插件的关系 |
|---|---|---|
| **钉钉** | 阿里旗下的企业协同办公平台 | 宜搭运行在钉钉生态内，账号/组织/权限都来自钉钉 |
| **宜搭** | 钉钉的低代码平台：拖拽配置页面、表单、流程 | 本插件操作的目标系统。企业专属站点形如 `https://xxxxxx.aliwork.com` |
| **OpenYida** | 开源（MIT）宜搭命令行工具，npm 包 `openyida` | 本插件的「手」：所有真实操作都通过它执行 |
| **DSH** | 本插件运行的宿主（AI Agent 桌面端） | 提供工具注册、右侧栏、内置浏览器 |

关于 OpenYida 的能力边界，先说结论：**官方 OpenAPI 只能操作数据**（表单实例、流程实例、审批任务、附件），元数据只有只读接口；**创建/修改应用与表单结构**走的是登录态接口路径。它需要**你自己的宜搭登录态**，不占用钉钉开放平台的授权包。

## 16 个工具

| 工具 | 类型 | 作用 |
|---|---|---|
| `yida_status` | 只读 | CLI 版本、登录态、工作目录 —— 开工前先跑它 |
| `yida_login` | 本地 | 发起登录：拿钉钉授权 URL 并交给右侧栏，用 DSH 内置浏览器完成授权 |
| `yida_logout` | 本地 | 退出登录（`confirm: true`，只清本机凭据） |
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

## 右侧栏「宜搭工作台」

- 登录态徽标、CLI 来源；
- **「登录」/「登出」按钮**；
- 口径切换：**我管理的** / **我能访问**；
- 应用列表 → 一键「打开（工作台）」「管理台」「表单」；
- 表单列表 → 打开表单页；
- 地址框：粘贴任意宜搭地址，直接在内置浏览器里打开；
- 后台轮询：AI 侧调用 `yida_urls { open: true }` / `yida_login` 后，工作台会自动把页面开进内置浏览器。

> 内置浏览器是 DSH 桌面版自带的 Electron `<webview>`，能带登录态打开宜搭。
> 它**不向模型暴露页面操作能力**——本插件的分工是「AI 负责改，浏览器负责看」。

## 登录 / 登出

工作台工具栏两个按钮，以及对应的 `yida_login` / `yida_logout` 工具：

| 操作 | 行为 |
|---|---|
| **登录** | 后台启动 `openyida login`（`OPENYIDA_NO_BROWSER=1`，不拉起系统浏览器），从 CLI 输出抓出钉钉授权 URL，**交给 DSH 内置浏览器打开**；随后轮询登录态，成功即刷新列表 |
| **登出** | 调用 `openyida logout`，清空本机登录态 |

**这条链路不需要 `dsh-browser-agent`**：只用到 DSH 自带的「浏览器」标签页（`ctx.sidebarRight.openTab('browser', …)`）。
钉钉授权完成后，回调打到 CLI 自己起的 `127.0.0.1` loopback（默认 5 分钟超时），登录态落盘到 `%APPDATA%\openyida\auth`，desktop / web 两个 profile 共用。

## 安装

**前置**：DSH 桌面版 + 一个能登录宜搭的钉钉账号。
**不需要**全局安装 openyida，也不需要手动改 DSH 配置。

```bash
git clone https://github.com/pangxie985/dsh-desktop-yida.git
cd dsh-desktop-yida
node scripts/install.mjs
```

安装脚本做的事情（幂等，改前自动备份 `.bak-<时间戳>`）：

1. 在插件目录装好 OpenYida CLI —— 按 `npm` → `pnpm` → **DSH 自带 pnpm** 顺序尝试（「只有 DSH、没有 npm」的机器也能装上）；
2. **实测 CLI 能跑**（`agent-capabilities --json`），跑不起来就 **exit 1**，绝不打印"安装完成"；
3. 在 profile 的 `node_modules` 里建目录联接（Windows 用 junction，不需要管理员）；
4. 往 profile 的 `package.json` 写 `"dsh-desktop-yida": "link:<插件目录>"` 并加入 `dsh.profile.bundles`；
5. 清理 `cordis.patch.yml` 里**历史版本**写过的挂载行（新版本不再写这个文件）。

装完看最后几行提示：**硬刷新 `Ctrl+Shift+R`** → **`Ctrl+Alt+B` 展开右侧栏** → 新建「宜搭工作台」标签 → 点工具栏「登录」。

其他用法：

```bash
node scripts/install.mjs --profile web        # 装到 web profile（web 端没有右侧栏，见「兼容性」）
node scripts/install.mjs --uninstall          # 卸载
node scripts/install.mjs --skip-cli           # 不自动装 openyida（你自己保证 CLI 可用）
node scripts/install.mjs --cli-tarball ./openyida-2026.10.30.tgz   # 离线安装 CLI
```

### 装不上 / 装完不能用？先看这里

| 现象 | 原因 | 处理 |
|---|---|---|
| `'npm' is not recognized …`，但仍打印"安装完成" | **旧版安装器**只 warn 不退出 | 更新到最新版后重跑；新版会用 DSH 自带 pnpm，装不上直接 exit 1 |
| 所有工具报 `openyida CLI 未找到` | CLI 没装上 | `--cli-tarball` 离线装，或按脚本给出的三条路处理 |
| DSH 起不来：`failed to parse overlay … (7:1)` | **旧版安装器**把空 `[]` patch 拼成了非法 YAML | 把 `cordis.patch.yml` 恢复成 `[]`（或删掉里面 `dsh-desktop-yida` 那几行）后重启；新版不会再写这个文件 |
| 配置里出现两个 `id: dsh-desktop-yida` | **旧版安装器**同时写 `bundles` 和 patch | 新版只写 `bundles`；重跑一次安装脚本即可自动清掉历史 patch 行 |
| 装完右侧栏找不到工作台 | client bundle 需要重新注入 | `Ctrl+Shift+R` 硬刷新，再 `Ctrl+Alt+B` 展开侧栏 |

> **GUI 插件管理器里装不了**：npm 上还没有这个包，GUI 走 pnpm + git 源，需要 git。
> 「没有 git / npm」的机器请用上面的 `git clone`（或 Download ZIP 解压）+ `node scripts/install.mjs`。

## 第一次使用

1. 装完先硬刷新（`Ctrl+Shift+R`）；
2. 右侧栏 `Ctrl+Alt+B` → 新建「宜搭工作台」→ 点 **「登录」**，在内置浏览器里完成钉钉授权；
3. 让 AI 调 `yida_status`，看到 `loginStatus: "ok"` 就通了。

多组织账号可以 `yida_org_list` 看有哪些组织、`yida_org_switch` 切过去。

## 用法

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

### 字段定义示例

建表单时传给 `yida_create_form` 的 `fieldsFile`：

```json
[
  { "type": "Divider", "title": "设备信息", "dividerType": "bold-with-thin" },
  { "type": "TextField", "label": "设备名称", "required": true, "placeholder": "请输入设备名称" },
  { "type": "TextField", "label": "设备编号", "required": true },
  { "type": "SelectField", "label": "设备类型", "options": ["烟感", "燃气"] },
  { "type": "AddressField", "label": "设备定位" }
]
```

常用组件：`TextField`、`TextareaField`、`NumberField`、`SelectField`、`RadioField`、`CheckboxField`、`DateField`、`EmployeeField`、`AddressField`、`AttachmentField`、`ImageField`、`TableField`、`Divider`、`ColumnContainer`。
完整清单见 [OpenYida 字段速查](https://github.com/openyida/openyida/blob/main/yida-skills/references/field-and-url-reference.md)。

## 安全闸门

写入类工具必须**同时**满足两个条件才会真正执行：

1. 插件设置里 `allowRemoteWrites` 为真（默认开，可关死）；
2. 调用时显式传 `confirm: true`。

任何一条不满足，工具**不执行**，只回显将要运行的完整命令。所有写工具都支持 `dryRun: true`，先看命令再决定。

此外：`/yida/api/*` 只暴露只读接口且只接受回环 Host（防 DNS rebinding）；不做批量、无人值守的改造。

## 配置项

在 DSH 的插件设置里改（对应 `cordis.patch.yml` 的 `config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `cliPath` | 空 | openyida 入口绝对路径；留空依次找：插件自带 `node_modules` → `OPENYIDA_CLI` → 模块解析 → `PATH` |
| `projectDir` | 空 | CLI 工作目录（生成的 `.cache/openyida` 落这里）；留空用宿主进程 cwd |
| `baseUrl` | 空 | 宜搭站点；**留空自动用当前登录站点**（企业专属站点不是 `www.aliwork.com`，强烈建议留空） |
| `allowRemoteWrites` | `true` | 关掉后所有写入工具一律拒绝 |
| `timeoutMs` | `180000` | 单次 CLI 调用超时 |
| `maxInlineBytes` | `24000` | 工具返回给模型的最大字符数 |

## 常见问题

**Q：`yida_apps` 返回 0 个应用，但我明明有应用？**
OpenYida 的 `app-list` 硬编码 `creator=<我的 userId>`，只列「我自己创建的」。别人创建、而你是管理员的应用不会出现。
用 `yida_apps { scope: "admin" }`（我是管理员）或 `{ scope: "all" }`（我能访问的全部），右侧栏工作台也有对应切换。

**Q：生成的链接打不开 / 指向 `www.aliwork.com`？**
你的宜搭是专属站点（形如 `https://xxxxxx.aliwork.com`）。`baseUrl` 留空时插件会自动读登录站点；手工填了 `baseUrl` 请改成自己的站点。

**Q：右侧栏找不到「宜搭工作台」？**
① 先硬刷新（`Ctrl+Shift+R`）让 client 半加载；② 右侧栏默认收起，按 `Ctrl+Alt+B` 展开；③ 展开后在 guide / 新建标签里找。

**Q：登录按钮点了没反应？**
确认「宜搭工作台」标签页开着（授权 URL 是通过它交给内置浏览器的）。也可以直接对 AI 说「登录宜搭」，效果一样。

**Q：改了代码什么时候生效？**
`lib/client.js`（client 半）热加载；`lib/index.js`（Host 半）**必须重启 DSH**。

**Q：登录态过期？**
点工作台「登录」重新授权；登录态存在 `%APPDATA%\openyida\auth`，与 DSH profile 无关。

## 兼容性

| 环境 | 工具（Host 半） | 右侧栏（Client 半） | 内置浏览器看应用 |
|---|---|---|---|
| **DSH 桌面版**（0.2.x） | ✅ 实测通过 | ✅ | ✅（Electron `<webview>`） |
| DSH web profile | ⚠️ 理论可用，未实测 | ❌ 不可用 | ❌ 不可用 |

web 端不可用是载体限制，不是插件问题：web profile 的 DSH 运行时没有官方右侧栏/内置浏览器包，侧栏由生态插件提供另一套 API；且 web 版内置浏览器是 sandbox iframe，而宜搭返回 `X-Frame-Options: SAMEORIGIN`，浏览器直接拒绝嵌入。web 端建议只当「执行工具」用：AI 干活，结果用系统浏览器看。

平台：Windows 实测通过；macOS / Linux 未实测（路径与进程调用均使用 Node API，理论上可用，欢迎 PR 反馈）。

## 合规提醒（请先读）

- **OpenYida 不是钉钉官方授权工具**。它通过**登录态**调用宜搭接口，其中「创建/修改应用与表单结构」走内部接口路径。
- 《钉钉服务协议》第八条（软件使用规范）包含禁止「通过非钉钉公司开发、授权的第三方软件、插件、外挂、系统，登录或使用软件及服务」的条款；《宜搭服务使用规则》另有系统配置、反向工程等条款。**是否适用、如何解释，认定权在钉钉**。
- 建议：**只对你自己有权限的应用使用；写入前保留确认；不要在公司内部分发、运营这类工具；不要把批量导出组织数据当作常规操作。**
- 用到生产环境前，请让公司合规/法务确认，或向宜搭官方书面确认。**这不是法律意见**，条款以钉钉官网最新版本为准。

## 维护者文档

开发、测试、发布、插件市场上架等维护者向内容见 [docs/MAINTAINER.md](./docs/MAINTAINER.md)。

## License

[MIT](./LICENSE)

本插件与钉钉、阿里云、阿里巴巴集团无隶属关系；OpenYida 由其各自作者维护，遵循其自身的 MIT 许可。
