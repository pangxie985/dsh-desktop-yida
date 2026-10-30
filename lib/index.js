/**
 * `dsh-desktop-yida` Host 半：把 OpenYida CLI 的能力暴露成 DSH 工具，并给右侧栏
 * 「宜搭工作台」提供只读的 HTTP 接口。
 *
 * 安全闸门：
 *   - 只读工具（status / apps / forms / schema / urls / dataQuery / appEntry）
 *     直接执行，不做任何确认；
 *   - 远程写入工具（createApp / createForm / updateForm / publishPage）
 *     必须同时满足「插件设置 allowRemoteWrites」与「本次调用 confirm: true」；
 *     任一不满足即拒绝执行，并把将要执行的命令原样返回；
 *   - 所有工具都支持 `dryRun: true`，只回显命令不执行。
 *
 * 本模块零运行时依赖：`defineTool`/`defineConfig` 使用自带的 `./schema.js`
 * 同形实现（`@deepseek-ai/*` 不从 profile 的 node_modules 解析）。
 *
 * @module dsh-desktop-yida
 */
import { defineConfig, defineTool } from './schema.js'
import { currentAuth, listAppsViaApi } from './yida-auth.js'
import { cancelLogin, loginState, startLogin } from './yida-login.js'
import {
  DEFAULT_BASE_URL,
  buildArgs,
  parseJsonOutput,
  resolveCli,
  runCli,
  stripAnsi,
  summarize,
  urlsFor,
} from './yida-cli.js'

/** Cordis 插件名。 */
export const name = 'dsh-desktop-yida'

/** 需要的 Host 服务：`tools` 注册工具，`webServer` 提供右侧栏数据接口。 */
export const inject = ['tools', 'webServer']

/** 插件设置。 */
export const Config = defineConfig({
  cliPath: {
    type: 'string',
    default: '',
    description: 'openyida 入口的绝对路径；留空则依次尝试插件自带、OPENYIDA_CLI 环境变量、PATH 上的 openyida。',
  },
  projectDir: {
    type: 'string',
    default: '',
    description: 'CLI 的工作目录；留空用当前进程工作目录。生成的 .cache/openyida 产物会落在该目录下。',
  },
  baseUrl: {
    type: 'string',
    default: '',
    description:
      '宜搭站点地址；留空则自动使用当前登录站点（企业专属宜搭形如 https://xxxxxx.aliwork.com，推荐留空）。',
  },
  allowRemoteWrites: {
    type: 'boolean',
    default: true,
    description: '是否允许「远程写入」类工具（建应用/建表单/改表单/发布页面）。关闭后这些工具一律拒绝执行。',
  },
  timeoutMs: {
    type: 'integer',
    default: 180000,
    min: 5000,
    max: 1800000,
    description: '单次 CLI 调用的超时（毫秒）。',
  },
  maxInlineBytes: {
    type: 'integer',
    default: 24000,
    min: 1000,
    max: 400000,
    description: '工具返回给模型的最大字符数，超出会截断并保留结构。',
  },
})

/** 渲染成 `ContentBlock[]`。 */
function textRender(args, value) {
  const body = summarize(value)
  return [{ type: 'text', text: body }]
}

/**
 * 递归剔除 `undefined`：工具输出必须是无损 JSON 值，缺省字段直接省略。
 * @param {unknown} value - 任意值。
 * @returns {unknown} 清理后的值。
 */
export function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = clean(item)
    }
    return out
  }
  return value
}

/** 统一的工具输出声明。 */
const JSON_OUTPUT = { schema: { type: 'json' }, render: textRender }

/** 只读/写入工具共用的说明尾注。 */
const READ_NOTE = '只读命令，不会修改宜搭侧任何数据。'
const WRITE_NOTE =
  '这是远程写入命令：会真实修改宜搭租户。调用前必须先向用户说明将要执行的操作与命令并获得同意，再传 confirm: true。' +
  '想先看命令不执行，传 dryRun: true。'

/**
 * 判定一次写入调用是否放行。
 * @param {Record<string, unknown>} input - 工具入参。
 * @param {string[]} args - 已编译的命令参数。
 * @param {{allowRemoteWrites: boolean}} settings - 插件设置。
 * @returns {{allowed: true} | {allowed: false, reason: string, args: string[]}} 判定结果。
 */
export function gateWrite(input, args, settings) {
  if (input.dryRun === true) return { allowed: false, reason: 'dry-run', args }
  if (settings.allowRemoteWrites !== true) {
    return { allowed: false, reason: '插件设置 allowRemoteWrites=false，写入类工具已禁用', args }
  }
  if (input.confirm !== true) {
    return { allowed: false, reason: '缺少 confirm: true（远程写入必须显式确认）', args }
  }
  return { allowed: true }
}

/**
 * 仅供测试：替换 CLI 执行器，避免单测依赖子进程。
 * @type {null | ((args: string[], options: object) => Promise<{code: number, stdout: string, stderr: string}>) }
 */
let runnerOverride = null

/**
 * 安装测试用的 CLI 执行器替身（传 null 恢复）。
 * @param {null | Function} runner - 替身函数。
 */
export function __setRunner(runner) {
  runnerOverride = runner
}

/**
 * 登录态探测器；测试可替换（默认读 OpenYida 的登录 profile）。
 * @type {(settings: object) => ({baseUrl: string, userId: string}|null)}
 */
let authProbe = currentAuth

/**
 * 安装测试用的登录态探测器（传 null 恢复默认）。
 * @param {null | Function} probe - 替身函数。
 */
export function __setAuthResolver(probe) {
  authProbe = probe === null ? currentAuth : probe
}

/**
 * 「启动登录」的实现；测试可替换（真实实现会 spawn openyida login）。
 * @type {(settings: object, options?: object) => Promise<object>}
 */
let loginStarter = startLogin

/**
 * 安装测试用的登录启动器（传 null 恢复默认）。
 * @param {null | Function} starter - 替身函数。
 */
export function __setLoginStarter(starter) {
  loginStarter = starter === null ? startLogin : starter
}

/**
 * 「直接查接口拿应用列表」的实现；测试可替换。
 * @type {(settings: object, input: object) => Promise<object>}
 */
let appLister = listAppsViaApi

/**
 * 安装测试用的应用列表实现（传 null 恢复默认）。
 * @param {null | Function} lister - 替身函数。
 */
export function __setAppLister(lister) {
  appLister = lister === null ? listAppsViaApi : lister
}

/**
 * 插件主体。
 * @param {object} ctx - Cordis 上下文（已注入 tools / webServer）。
 * @param {object} config - 生效设置。
 */
export function apply(ctx, config) {
  const settings = {
    cliPath: typeof config?.cliPath === 'string' ? config.cliPath.trim() : '',
    projectDir: typeof config?.projectDir === 'string' ? config.projectDir.trim() : '',
    baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '',
    allowRemoteWrites: config?.allowRemoteWrites !== false,
    timeoutMs: Number.isFinite(config?.timeoutMs) ? config.timeoutMs : 180000,
    maxInlineBytes: Number.isFinite(config?.maxInlineBytes) ? config.maxInlineBytes : 24000,
  }

  /** 读当前登录态（失败返回 null）。 */
  function authInfo() {
    try {
      return authProbe(settings)
    } catch {
      return null
    }
  }

  /**
   * 页面地址要用的站点：显式配置优先，否则用登录站点。
   * 企业专属宜搭不在 www.aliwork.com，必须按登录站点推导。
   */
  function siteBaseUrl() {
    if (settings.baseUrl !== '') return settings.baseUrl
    const auth = authInfo()
    return (auth && auth.baseUrl) || DEFAULT_BASE_URL
  }

  /** 右侧栏待打开队列：Host 侧排队，client 半轮询后在内置浏览器打开。 */
  const pendingOpens = []
  let openSeq = 0

  const cap = (value) => summarize(value).slice(0, settings.maxInlineBytes)

  /** 执行一次 CLI 并返回结构化结果。 */
  async function exec(args, execCtx) {
    const resolved = resolveCli(settings)
    if (execCtx?.signal?.aborted) throw new Error('已取消')
    const runOptions = {
      resolved,
      cwd: settings.projectDir,
      timeoutMs: settings.timeoutMs,
    }
    const result = runnerOverride ? await runnerOverride(args, runOptions) : await runCli(args, runOptions)
    const parsed = parseJsonOutput(result.stdout)
    const stderrText = stripAnsi(result.stderr).trim()
    return clean({
      ok: result.code === 0,
      exitCode: result.code,
      cli: resolved.source,
      command: `openyida ${args.join(' ')}`,
      data: parsed,
      stdout: parsed === undefined ? cap(stripAnsi(result.stdout)) : undefined,
      stderr: stderrText === '' ? undefined : cap(stderrText),
      timedOut: result.timedOut === true ? true : undefined,
      spawnError: result.spawnError,
    })
  }

  /** 只读工具的统一包装。 */
  function readTool(operation, toolName, description, parameters) {
    return defineTool({
      name: toolName,
      description,
      parameters,
      output: JSON_OUTPUT,
      async execute(args, execCtx) {
        return exec(buildArgs(operation, args), execCtx)
      },
    })
  }

  /** 写入工具的统一包装。 */
  function writeTool(operation, toolName, description, parameters) {
    return defineTool({
      name: toolName,
      description,
      parameters,
      output: JSON_OUTPUT,
      async execute(args, execCtx) {
        const cliArgs = buildArgs(operation, args)
        const verdict = gateWrite(args, cliArgs, settings)
        if (!verdict.allowed) {
          return {
            ok: false,
            blocked: verdict.reason,
            command: `openyida ${cliArgs.join(' ')}`,
            hint:
              verdict.reason === 'dry-run'
                ? 'dry-run：仅回显命令，未执行。确认无误后去掉 dryRun 并传 confirm: true。'
                : '未执行任何远程写入。确认后请重新调用并传 confirm: true；若被插件设置禁用，请在插件设置里打开 allowRemoteWrites。',
          }
        }
        return exec(cliArgs, execCtx)
      },
    })
  }

  const tools = [
    defineTool({
      name: 'yida_status',
      description:
        '查看宜搭 CLI（OpenYida）的运行状态：CLI 来源、版本、登录态与组织信息。开始任何宜搭操作前先调它。' +
        READ_NOTE,
      parameters: {},
      output: JSON_OUTPUT,
      async execute(_args, execCtx) {
        const status = await exec(buildArgs('status'), execCtx)
        const version = await exec(buildArgs('version'), execCtx)
        return clean({
          ok: status.ok,
          cli: status.cli,
          version: version.data?.version,
          loginStatus: status.data?.login?.status,
          authMode: status.data?.login?.auth_mode,
          nextStep: status.data?.login?.next_step,
          workdir: status.data?.workdir,
          commandCount: version.data?.groups ? version.data.groups.length : undefined,
        })
      },
    }),

    readTool('orgList', 'yida_org_list', '列出当前登录态可访问的组织（corpId / corpName / 哪个是当前）。应用列表为空时先看这里。' + READ_NOTE, {}),

    writeTool('orgSwitch', 'yida_org_switch', '切换本地登录态使用的组织（只改本地 auth profile，不修改宜搭任何数据）。切完再调 yida_apps。', {
      corpId: { type: 'string', required: true, description: '目标组织 ID，形如 dingxxxxxxxx。' },
      confirm: { type: 'boolean', description: '确认执行切换。' },
      dryRun: { type: 'boolean', description: '只回显命令，不执行。' },
    }),

    defineTool({
      name: 'yida_apps',
      description:
        '列出宜搭应用。scope 决定口径：mine=我创建的（走 openyida app-list，注意该命令硬编码 creator=我，' +
        '别人建的应用不会返回）；admin=我是管理员的应用；all=我能访问的全部应用（后两者直接查只读接口，' +
        '不加 creator 过滤）。' + READ_NOTE,
      parameters: {
        scope: { type: 'string', description: 'mine（默认）/ admin / all。' },
        type: { type: 'string', description: 'scope=mine 时的 CLI 参数：managed（默认）或 created。' },
        page: { type: 'number', description: '页码，默认 1。' },
        size: { type: 'number', description: '每页条数，默认 50，上限 100。' },
      },
      output: JSON_OUTPUT,
      async execute(args, execCtx) {
        const scope = args.scope === 'admin' || args.scope === 'all' ? args.scope : 'mine'
        if (scope === 'mine') return exec(buildArgs('apps', args), execCtx)
        const result = await appLister(settings, {
          scope,
          page: Number.isFinite(args.page) ? args.page : 1,
          size: Number.isFinite(args.size) ? Math.min(100, args.size) : 50,
        })
        return clean({
          ok: true,
          mode: 'direct-api',
          command: `GET ${'/query/app/getAppList.json'}（isAdmin=${scope === 'admin'}，不限 creator）`,
          baseUrl: result.baseUrl,
          userId: result.userId,
          scope: result.scope,
          totalCount: result.totalCount,
          data: result.apps,
        })
      },
    }),

    readTool('forms', 'yida_forms', '列出某个宜搭应用下的表单/页面。' + READ_NOTE, {
      appType: { type: 'string', required: true, description: '应用 ID，形如 APP_XXXXXXXX。' },
      keyword: { type: 'string', description: '按名称过滤。' },
    }),

    readTool('schema', 'yida_schema', '读取某个表单的 Schema（字段、结构）。这是改表单前必须先做的一步。' + READ_NOTE, {
      appType: { type: 'string', required: true, description: '应用 ID。' },
      formUuid: { type: 'string', description: '表单 ID；传 all: true 时可省略。' },
      all: { type: 'boolean', description: '为 true 时读取该应用全部表单 Schema。' },
      summary: { type: 'boolean', description: '只取摘要，减少输出体积。' },
    }),

    readTool('appEntry', 'yida_app_entry', '读取宜搭平台为应用登记的前端入口与管理台地址（比本地推导更权威）。' + READ_NOTE, {
      appType: { type: 'string', required: true, description: '应用 ID。' },
    }),

    readTool('dataQuery', 'yida_data_query', '查询某个表单的数据实例（分页）。' + READ_NOTE, {
      appType: { type: 'string', required: true, description: '应用 ID。' },
      formUuid: { type: 'string', required: true, description: '表单 ID。' },
      page: { type: 'number', description: '页码，默认 1。' },
      size: { type: 'number', description: '每页条数，默认 20。' },
    }),

    defineTool({
      name: 'yida_urls',
      description:
        '推导宜搭页面地址：不传 appType 时给「应用列表/工作台首页」，传了则给工作台、管理台、表单页。' +
        'open: true 时同时请求右侧栏内置浏览器打开它。' + READ_NOTE,
      parameters: {
        appType: { type: 'string', description: '可选：应用 ID，形如 APP_XXXXXXXX；不传则只给宜搭首页。' },
        formUuid: { type: 'string', description: '可选：表单 ID，用于给出表单页地址。' },
        target: { type: 'string', description: 'open 时打开哪个：home（宜搭首页/应用列表）、workbench（默认）、admin 或 page。' },
        open: { type: 'boolean', description: '是否请求右侧栏内置浏览器打开。' },
      },
      output: JSON_OUTPUT,
      async execute(args) {
        const urls = urlsFor({ appType: args.appType, formUuid: args.formUuid, baseUrl: siteBaseUrl() })
        let opened
        if (args.open === true) {
          const target = ['home', 'admin', 'page'].includes(args.target) ? args.target : 'workbench'
          const url =
            target === 'home'
              ? urls.homeUrl
              : target === 'admin'
                ? urls.adminUrl
                : target === 'page'
                  ? urls.pageUrl
                  : urls.workbenchUrl
          if (url) {
            openSeq += 1
            const item = { id: `open-${openSeq}`, url, label: args.appType, at: Date.now() }
            pendingOpens.push(item)
            if (pendingOpens.length > 20) pendingOpens.shift()
            opened = item
          }
        }
        return clean({
          ok: true,
          ...urls,
          queuedOpen: opened ? opened.url : undefined,
          hint: opened
            ? '已排入右侧栏打开队列：请确认「宜搭工作台」标签页处于打开状态（它会轮询并调用内置浏览器打开）。'
            : 'open: false，未请求打开。把 open 设为 true 可请求右侧栏内置浏览器打开。',
        })
      },
    }),

    writeTool('createApp', 'yida_create_app', '创建一个新的宜搭应用。' + WRITE_NOTE, {
      name: { type: 'string', required: true, description: '应用名称。' },
      desc: { type: 'string', description: '应用描述。' },
      confirm: { type: 'boolean', description: '确认执行远程写入。' },
      dryRun: { type: 'boolean', description: '只回显命令，不执行。' },
    }),

    writeTool('createForm', 'yida_create_form', '在指定应用里新建一个表单页（需要字段定义 JSON 文件）。' + WRITE_NOTE, {
      appType: { type: 'string', required: true, description: '应用 ID。' },
      title: { type: 'string', required: true, description: '表单标题。' },
      fieldsFile: { type: 'string', required: true, description: '字段定义 JSON 的路径（可先用 yida_schema 参考现有结构）。' },
      confirm: { type: 'boolean', description: '确认执行远程写入。' },
      dryRun: { type: 'boolean', description: '只回显命令，不执行。' },
    }),

    writeTool('updateForm', 'yida_update_form', '增量修改已有表单（保留其它现有组件）。' + WRITE_NOTE, {
      appType: { type: 'string', required: true, description: '应用 ID。' },
      formUuid: { type: 'string', required: true, description: '表单 ID。' },
      changesFile: { type: 'string', required: true, description: '变更说明 JSON 的路径。' },
      confirm: { type: 'boolean', description: '确认执行远程写入。' },
      dryRun: { type: 'boolean', description: '只回显命令，不执行。' },
    }),

    writeTool('patchForm', 'yida_patch_form', '按 JSON Pointer 深合并方式修补表单字段。' + WRITE_NOTE, {
      appType: { type: 'string', required: true, description: '应用 ID。' },
      formUuid: { type: 'string', required: true, description: '表单 ID。' },
      patchFile: { type: 'string', required: true, description: 'patch JSON 的路径。' },
      confirm: { type: 'boolean', description: '确认执行远程写入。' },
      dryRun: { type: 'boolean', description: '只回显命令，不执行。' },
    }),

    writeTool('publishPage', 'yida_publish_page', '编译并发布自定义页面到指定表单。' + WRITE_NOTE, {
      sourceFile: { type: 'string', required: true, description: '页面源码文件（.canvas.jsx）。' },
      appType: { type: 'string', required: true, description: '应用 ID。' },
      formUuid: { type: 'string', required: true, description: '目标表单 ID。' },
      confirm: { type: 'boolean', description: '确认执行远程写入。' },
      dryRun: { type: 'boolean', description: '只回显命令，不执行。' },
    }),

    defineTool({
      name: 'yida_login',
      description:
        '发起宜搭登录：在后台启动 openyida login（不拉起系统浏览器），拿到钉钉授权 URL 后返回，' +
        '并把该 URL 排进右侧栏打开队列——「宜搭工作台」会把它交给 DSH 内置浏览器，用户在里面完成授权即可。' +
        '整个过程不依赖浏览器代理插件。' + READ_NOTE,
      parameters: {},
      output: JSON_OUTPUT,
      async execute() {
        const result = await loginStarter(settings)
        if (result.ok !== true) return clean({ ok: false, error: result.error })
        openSeq += 1
        const item = { id: `open-${openSeq}`, url: result.url, label: '宜搭登录', at: Date.now() }
        pendingOpens.push(item)
        if (pendingOpens.length > 20) pendingOpens.shift()
        return clean({
          ok: true,
          url: result.url,
          queuedOpen: result.url,
          hint:
            '已把授权 URL 排进右侧栏队列：请确认「宜搭工作台」标签页开着（它会用 DSH 内置浏览器打开）。' +
            '登录完成后再调 yida_status 确认。',
        })
      },
    }),

    defineTool({
      name: 'yida_logout',
      description:
        '退出宜搭登录（openyida logout，清空本地凭据）。只影响本机登录态，不改宜搭侧任何数据。' +
        '注销后需要重新 yida_login 才能继续操作。',
      parameters: {
        confirm: { type: 'boolean', description: '确认执行登出。' },
      },
      output: JSON_OUTPUT,
      async execute(args, execCtx) {
        if (args.confirm !== true) {
          return clean({
            ok: false,
            blocked: '缺少 confirm: true（登出会清空本地登录态）',
            command: 'openyida logout',
            hint: '确认要退出登录后重新调用并传 confirm: true。',
          })
        }
        return exec(['logout'], execCtx)
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)

  // ---- 右侧栏数据接口（只读） ----------------------------------------------

  /** 只接受回环 Host，避免 DNS rebinding。 */
  function hostAllowed(req) {
    const host = String(req.headers?.host ?? '')
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload, null, 2)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  async function handle(req, res) {
    if (!hostAllowed(req)) {
      sendJson(res, 403, { ok: false, error: 'host not allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice('/yida/api'.length) || '/'
    // 登录/登出需要 POST；其余接口只读，仍只接受 GET。
    const POST_ROUTES = new Set(['/login/start', '/login/cancel', '/logout'])
    if (req.method !== 'GET' && !(req.method === 'POST' && POST_ROUTES.has(route))) {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      if (route === '/login/start') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST /yida/api/login/start' })
          return
        }
        const result = await loginStarter(settings)
        if (result.ok === true) {
          openSeq += 1
          const item = { id: `open-${openSeq}`, url: result.url, label: '宜搭登录', at: Date.now() }
          pendingOpens.push(item)
          if (pendingOpens.length > 20) pendingOpens.shift()
        }
        sendJson(res, result.ok === true ? 200 : 502, result)
        return
      }
      if (route === '/login/state') {
        const status = await exec(buildArgs('status'))
        sendJson(res, 200, {
          ok: true,
          ...loginState(),
          loginStatus: status.data?.login?.status,
          nextStep: status.data?.login?.next_step,
          userId: authInfo()?.userId,
        })
        return
      }
      if (route === '/login/cancel') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST /yida/api/login/cancel' })
          return
        }
        sendJson(res, 200, { ok: true, cancelled: cancelLogin() })
        return
      }
      if (route === '/logout') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST /yida/api/logout' })
          return
        }
        const result = await exec(['logout'])
        sendJson(res, result.ok ? 200 : 502, result)
        return
      }
      if (route === '/status') {
        const status = await exec(buildArgs('status'))
        sendJson(res, 200, {
          ok: status.ok,
          cli: status.cli,
          loginStatus: status.data?.login?.status,
          nextStep: status.data?.login?.next_step,
          version: status.data?.version,
        })
        return
      }
      if (route === '/apps') {
        const scope = url.searchParams.get('scope')
        const page = url.searchParams.get('page') ?? '1'
        const size = url.searchParams.get('size') ?? '50'
        // scope=admin|all：直接查只读接口（不限 creator），否则走 CLI 的 app-list。
        if (scope === 'admin' || scope === 'all') {
          const result = await appLister(settings, { scope, page: Number(page), size: Number(size) })
          sendJson(res, 200, {
            ok: true,
            mode: 'direct-api',
            baseUrl: result.baseUrl,
            totalCount: result.totalCount,
            data: result.apps,
          })
          return
        }
        const type = url.searchParams.get('type') === 'created' ? 'created' : 'managed'
        const result = await exec(buildArgs('apps', { type, page, size }))
        sendJson(res, result.ok ? 200 : 502, result)
        return
      }
      if (route === '/forms') {
        const appType = url.searchParams.get('appType') ?? ''
        const keyword = url.searchParams.get('keyword') ?? undefined
        const result = await exec(buildArgs('forms', { appType, keyword }))
        sendJson(res, result.ok ? 200 : 502, result)
        return
      }
      if (route === '/urls') {
        const appType = url.searchParams.get('appType') ?? ''
        const formUuid = url.searchParams.get('formUuid') ?? undefined
        sendJson(res, 200, { ok: true, ...urlsFor({ appType, formUuid, baseUrl: siteBaseUrl() }) })
        return
      }
      if (route === '/pending') {
        const items = pendingOpens.splice(0, pendingOpens.length)
        sendJson(res, 200, { ok: true, items })
        return
      }
      if (route === '/config') {
        const auth = authInfo()
        sendJson(res, 200, {
          ok: true,
          baseUrl: siteBaseUrl(),
          baseUrlSource: settings.baseUrl !== '' ? 'config' : auth ? 'login' : 'default',
          userId: auth ? auth.userId : undefined,
          allowRemoteWrites: settings.allowRemoteWrites,
          cliPath: settings.cliPath === '' ? null : settings.cliPath,
        })
        return
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${route}` })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/yida/api', handler: handle }))
}
