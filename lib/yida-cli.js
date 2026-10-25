/**
 * `dsh-desktop-yida` 的 OpenYida CLI 调用层。
 *
 * 职责边界：
 *   1. 定位 `openyida` 可执行入口（插件自带 → 设置 → 环境变量 → PATH）；
 *   2. 把工具入参编译成 CLI 参数向量（纯函数，便于单测）；
 *   3. 执行 CLI 并解析 stdout（OpenYida 的列表类命令直接输出 JSON）；
 *   4. 由 `appType`/`formUuid` 推导宜搭页面 URL（口径与 OpenYida 的
 *      `lib/app/application-entry-urls.js` 保持一致）。
 *
 * 本模块不依赖任何 `@deepseek-ai/*` 运行时包，也不做任何网络请求。
 *
 * @module dsh-desktop-yida/yida-cli
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录（`lib/` 的上一级）。 */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 宜搭公有云默认站点；Enterprise 专属版可改。 */
export const DEFAULT_BASE_URL = 'https://www.aliwork.com'

/** `appType` 形态：OpenYida 自身也按这个正则校验。 */
const APP_TYPE_RE = /^APP_[A-Za-z0-9_-]+$/
/** `formUuid` 形态。 */
const FORM_UUID_RE = /^FORM[-_][A-Za-z0-9_-]+$/

/**
 * 枚举 CLI 定位候选，按优先级排列。
 * @param {{cliPath?: string}} [settings] - 插件设置。
 * @returns {Array<{kind: 'file'|'path', path?: string, command?: string, source: string}>} 候选列表。
 */
export function cliCandidates(settings = {}) {
  const list = []
  if (settings.cliPath) list.push({ kind: 'file', path: settings.cliPath, source: 'settings.cliPath' })
  if (process.env.OPENYIDA_CLI) {
    list.push({ kind: 'file', path: process.env.OPENYIDA_CLI, source: 'env.OPENYIDA_CLI' })
  }
  for (const rel of [
    ['node_modules', 'openyida', 'bin', 'yida.js'],
    ['vendor', 'openyida', 'bin', 'yida.js'],
  ]) {
    list.push({ kind: 'file', path: join(PLUGIN_ROOT, ...rel), source: 'bundled' })
  }
  list.push({ kind: 'path', command: 'openyida', source: 'PATH' })
  return list
}

/**
 * 解析出可执行的 CLI 入口。
 * @param {{cliPath?: string}} [settings] - 插件设置。
 * @returns {{command: string, prefix: string[], source: string}} 执行描述；PATH 候选可能仍不可用（由 spawn 的 ENOENT 暴露）。
 * @throws {Error} 当显式配置的路径不存在时。
 */
export function resolveCli(settings = {}) {
  for (const candidate of cliCandidates(settings)) {
    if (candidate.kind === 'file') {
      if (existsSync(candidate.path)) {
        return { command: process.execPath, prefix: [candidate.path], source: candidate.source }
      }
      if (candidate.source !== 'bundled') {
        throw new Error(
          `openyida CLI 路径不存在：${candidate.path}（来源 ${candidate.source}）。` +
            '请修正插件设置 cliPath，或先安装 OpenYida：npm i -g openyida',
        )
      }
      continue
    }
    return { command: candidate.command, prefix: [], source: candidate.source }
  }
  throw new Error('openyida CLI 未找到：请 npm i -g openyida，或在插件设置里指定 cliPath。')
}

/** 断言非空字符串参数。 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填参数 ${field}`)
  }
  return value.trim()
}

/** 断言 appType 形态。 */
export function requireAppType(value) {
  const appType = requireString(value, 'appType')
  if (!APP_TYPE_RE.test(appType)) {
    throw new Error(`appType 形态不对（应形如 APP_XXXXXXXX）：${appType}`)
  }
  return appType
}

/** 断言 formUuid 形态。 */
export function requireFormUuid(value) {
  const formUuid = requireString(value, 'formUuid')
  if (!FORM_UUID_RE.test(formUuid)) {
    throw new Error(`formUuid 形态不对（应形如 FORM-XXXX 或 FORM_XXXX）：${formUuid}`)
  }
  return formUuid
}

/** 把可选的数字参数收敛成合法整数。 */
function intOr(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * 编译工具入参 → CLI 参数向量（纯函数）。
 *
 * 只使用 OpenYida 文档里存在的命令与选项；破坏性命令由调用方另行确认。
 *
 * @param {string} tool - 内部工具名（见 {@link TOOLS}）。
 * @param {Record<string, unknown>} [input] - 工具入参。
 * @returns {string[]} 传给 `openyida` 的参数数组。
 * @throws {Error} 参数缺失或形态不对时抛出。
 */
export function buildArgs(tool, input = {}) {
  switch (tool) {
    case 'status':
      return ['agent-capabilities', '--summary-json']
    case 'version':
      return ['commands']
    case 'orgList':
      return ['org', 'list', '--json']
    case 'orgSwitch':
      return ['org', 'switch', '--corp-id', requireString(input.corpId, 'corpId')]
    case 'apps':
      return [
        'app-list',
        '--type',
        input.type === 'created' ? 'created' : 'managed',
        '--page',
        String(intOr(input.page, 1, 1, 1000)),
        '--size',
        String(intOr(input.size, 50, 1, 100)),
      ]
    case 'forms': {
      const args = ['list-forms', requireAppType(input.appType)]
      if (typeof input.keyword === 'string' && input.keyword.trim() !== '') {
        args.push('--keyword', input.keyword.trim())
      }
      return args
    }
    case 'schema': {
      const args = ['get-schema', requireAppType(input.appType)]
      if (input.all === true) args.push('--all')
      else args.push(requireFormUuid(input.formUuid))
      if (input.summary === true) args.push('--summary-json')
      return args
    }
    case 'appEntry':
      return ['app-entry', 'get', requireAppType(input.appType)]
    case 'dataQuery':
      return [
        'data',
        'query',
        'form',
        requireAppType(input.appType),
        requireFormUuid(input.formUuid),
        '--page',
        String(intOr(input.page, 1, 1, 1000)),
        '--size',
        String(intOr(input.size, 20, 1, 100)),
      ]
    case 'createApp': {
      const args = ['create-app', '--name', requireString(input.name, 'name')]
      if (typeof input.desc === 'string' && input.desc.trim() !== '') args.push('--desc', input.desc.trim())
      return args
    }
    case 'createForm':
      return [
        'create-form',
        'create',
        requireAppType(input.appType),
        requireString(input.title, 'title'),
        requireString(input.fieldsFile, 'fieldsFile'),
      ]
    case 'updateForm':
      return [
        'create-form',
        'update',
        requireAppType(input.appType),
        requireFormUuid(input.formUuid),
        requireString(input.changesFile, 'changesFile'),
      ]
    case 'patchForm':
      return [
        'create-form',
        'patch',
        requireAppType(input.appType),
        requireFormUuid(input.formUuid),
        requireString(input.patchFile, 'patchFile'),
      ]
    case 'publishPage':
      return [
        'publish',
        requireString(input.sourceFile, 'sourceFile'),
        requireAppType(input.appType),
        requireFormUuid(input.formUuid),
      ]
    case 'online':
      return ['app-online', requireAppType(input.appType)]
    case 'offline':
      return ['app-offline', requireAppType(input.appType)]
    default:
      throw new Error(`未知操作：${tool}`)
  }
}

/**
 * 执行一次 OpenYida CLI 调用。
 *
 * 强制 `OPENYIDA_NO_BROWSER_HANDOFF=1`，避免 CLI 反过来去开系统浏览器；
 * 强制 `NO_COLOR=1`，让输出保持可解析。
 *
 * @param {string[]} args - 参数向量。
 * @param {{
 *   resolved?: {command: string, prefix: string[]},
 *   settings?: {cliPath?: string},
 *   cwd?: string,
 *   timeoutMs?: number,
 * }} [options] - 执行选项。
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut?: boolean, spawnError?: string}>} 执行结果。
 */
export function runCli(args, options = {}) {
  const resolved = options.resolved ?? resolveCli(options.settings ?? {})
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 180_000
  return new Promise((settle) => {
    let child
    try {
      child = spawn(resolved.command, [...resolved.prefix, ...args], {
        cwd: options.cwd && options.cwd !== '' ? options.cwd : process.cwd(),
        env: {
          ...process.env,
          OPENYIDA_NO_BROWSER_HANDOFF: '1',
          NO_COLOR: '1',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      settle({ code: -2, stdout: '', stderr: '', spawnError: String(error && error.message) })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code, extra) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle({ code, stdout, stderr, ...extra })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 进程可能已退出 */
      }
      finish(-1, { timedOut: true })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(-2, { spawnError: String(error && error.message) }))
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1))
  })
}

/**
 * 从混有日志的输出里提取第一个 JSON 值（对象或数组）。
 * @param {string} text - CLI 原始输出。
 * @returns {unknown} 解析结果；没有 JSON 时返回 `undefined`。
 */
export function parseJsonOutput(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  const starts = []
  for (let i = 0; i < trimmed.length && starts.length < 200; i += 1) {
    const ch = trimmed[i]
    if (ch === '{' || ch === '[') starts.push(i)
  }
  for (const start of starts) {
    const closer = trimmed[start] === '{' ? '}' : ']'
    let end = trimmed.lastIndexOf(closer)
    let attempts = 0
    while (end > start && attempts < 200) {
      attempts += 1
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        end = trimmed.lastIndexOf(closer, end - 1)
      }
    }
  }
  return undefined
}

/**
 * 由 appType / formUuid 推导宜搭页面 URL。
 *
 * 口径与 OpenYida 的 `application-entry-urls.js` 一致：
 * 工作台 `{origin}/{appType}/workbench`，管理台 `{origin}/{appType}/admin`，
 * 表单页 `{origin}/{appType}/workbench/{formUuid}`。
 *
 * @param {{appType?: string, formUuid?: string, baseUrl?: string}} input - 输入。
 * @returns {{origin?: string, workbenchUrl?: string, adminUrl?: string, pageUrl?: string}} 可用的 URL；无法推导时字段缺省。
 */
export function urlsFor(input = {}) {
  let origin
  try {
    const base = new URL(input.baseUrl || DEFAULT_BASE_URL)
    if (!['https:', 'http:'].includes(base.protocol)) return {}
    origin = base.origin
  } catch {
    return {}
  }
  const appType = typeof input.appType === 'string' ? input.appType : ''
  const result = {
    origin,
    // 宜搭的应用列表/工作台首页（CLI 的 project/config.json 里 loginUrl 即此地址）。
    homeUrl: `${origin}/workPlatform`,
  }
  if (!APP_TYPE_RE.test(appType)) return result
  result.workbenchUrl = `${origin}/${appType}/workbench`
  result.adminUrl = `${origin}/${appType}/admin`
  if (typeof input.formUuid === 'string' && FORM_UUID_RE.test(input.formUuid)) {
    result.pageUrl = `${origin}/${appType}/workbench/${input.formUuid}`
  }
  return result
}

/** 去掉 ANSI 颜色/控制序列（CLI 的告警会带色）。 */
export function stripAnsi(text) {
  if (typeof text !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** 生成给模型看的单行摘要。 */
export function summarize(result) {
  if (result === undefined || result === null) return '（无输出）'
  if (typeof result === 'string') return result.slice(0, 4000)
  try {
    return JSON.stringify(result, null, 2).slice(0, 8000)
  } catch {
    return String(result)
  }
}
