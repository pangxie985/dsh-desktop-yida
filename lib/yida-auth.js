/**
 * 登录态与「直接打接口」的桥接层。
 *
 * 为什么需要它：OpenYida 的 `app-list` 每次都硬编码 `creator: <我的 userId>`
 * （见 vendor/openyida/lib/app/app-list.js:39），于是它只返回**我自己创建**的应用；
 * 若应用是别人建的（即使我是管理员），结果永远是 0 条。
 * 这里复用 CLI 自带的客户端（同一套登录态 / CSRF / 站点解析）去查同一个只读接口，
 * 但不加 creator 过滤，从而拿到「我是管理员的」与「我能访问的」应用。
 *
 * 另外它暴露当前登录站点：企业专属宜搭不在 www.aliwork.com（例：https://xxxxxx.aliwork.com），
 * 页面地址必须按真实站点推导。
 *
 * 只读模块：只调用 `/query/app/getAppList.json`。
 *
 * @module dsh-desktop-yida/yida-auth
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { PLUGIN_ROOT, cliCandidates } from './yida-cli.js'

/** 应用列表接口（与 CLI 完全一致）。 */
const APP_LIST_PATH = '/query/app/getAppList.json'

/** 记住已加载的 CLI 内部模块，避免重复 require。 */
let internalsCache = null
let internalsKey = ''

/** 由 CLI 入口路径推出包根目录（…/bin/yida.js → …）。 */
function cliRootFromPath(cliPath) {
  if (typeof cliPath !== 'string' || cliPath === '') return null
  const resolved = isAbsolute(cliPath) ? cliPath : resolve(cliPath)
  if (!existsSync(resolved)) return null
  const root = dirname(dirname(resolved))
  return existsSync(join(root, 'lib', 'core', 'yida-client.js')) ? root : null
}

/**
 * 定位「CLI 包根目录」：优先设置里的 cliPath，其次自带 vendor，其次环境变量。
 * @param {{cliPath?: string}} [settings] - 插件设置。
 * @returns {string|null} 包根目录；CLI 只存在于 PATH 时返回 null（拿不到内部模块）。
 */
export function resolveCliRoot(settings = {}) {
  const explicit = []
  if (settings.cliPath) explicit.push(settings.cliPath)
  if (process.env.OPENYIDA_CLI) explicit.push(process.env.OPENYIDA_CLI)
  for (const candidate of cliCandidates(settings)) {
    if (candidate.kind === 'file' && candidate.path) explicit.push(candidate.path)
  }
  for (const candidate of explicit) {
    const root = cliRootFromPath(candidate)
    if (root !== null) return root
  }
  return null
}

/** 加载 CLI 的内部客户端（createAuthRef / createYidaClient）。 */
function loadInternals(settings) {
  const root = resolveCliRoot(settings)
  if (root === null) return null
  if (internalsCache !== null && internalsKey === root) return internalsCache
  try {
    const require = createRequire(join(root, 'package.json'))
    const client = require('./lib/core/yida-client.js')
    if (typeof client.createAuthRef !== 'function' || typeof client.createYidaClient !== 'function') {
      return null
    }
    internalsCache = client
    internalsKey = root
    return client
  } catch {
    return null
  }
}

/**
 * 读当前登录态（站点与 userId）。
 * @param {{cliPath?: string}} [settings] - 插件设置。
 * @returns {{baseUrl: string, userId: string}|null} 登录态信息；读不到返回 null。
 */
export function currentAuth(settings = {}) {
  const internals = loadInternals(settings)
  if (internals === null) return null
  try {
    const auth = internals.createAuthRef()
    if (!auth || typeof auth.baseUrl !== 'string' || auth.baseUrl === '') return null
    return { baseUrl: auth.baseUrl, userId: typeof auth.userId === 'string' ? auth.userId : '' }
  } catch {
    return null
  }
}

/**
 * 直接查应用列表接口。
 *
 * @param {{cliPath?: string}} settings - 插件设置。
 * @param {{scope?: 'admin'|'all', page?: number, size?: number}} [input] - 查询条件。
 *   `admin` → isAdmin=true（我是管理员的应用）；`all` → isAdmin=false（我能访问的应用）。
 * @returns {Promise<{ok: true, baseUrl: string, userId: string, totalCount: number, apps: object[]}>} 查询结果。
 * @throws {Error} 当 CLI 内部模块不可用或接口返回失败时。
 */
export async function listAppsViaApi(settings, input = {}) {
  const internals = loadInternals(settings)
  if (internals === null) {
    throw new Error(
      '拿不到 OpenYida 内部客户端（CLI 只能从 PATH 解析？）。请把插件设置 cliPath 指向 bin/yida.js，或使用 scope: "mine"。',
    )
  }
  const auth = internals.createAuthRef()
  const client = internals.createYidaClient({ authRef: auth })
  const isAdmin = input.scope !== 'all'
  const result = await client.get(APP_LIST_PATH, {
    _api: 'nattyFetch',
    _mock: 'false',
    pageIndex: Number.isFinite(input.page) ? input.page : 1,
    pageSize: Number.isFinite(input.size) ? input.size : 50,
    isAdmin,
    _stamp: Date.now(),
  })
  if (!result || result.success !== true) {
    throw new Error(`应用列表接口返回失败：${(result && result.errorMsg) || '未知错误'}`)
  }
  const content = result.content || {}
  const apps = Array.isArray(content.data) ? content.data : []
  return {
    ok: true,
    baseUrl: auth.baseUrl,
    userId: auth.userId,
    scope: isAdmin ? 'admin' : 'all',
    totalCount: Number.isFinite(Number(content.totalCount)) ? Number(content.totalCount) : apps.length,
    apps: apps.map((app) => ({
      appName: (app.appName && app.appName.zh_CN) || app.appName || '',
      appType: app.appType || '',
      systemLink: app.systemLink || '',
    })),
  }
}

/** 供测试：清掉内部模块缓存。 */
export function __resetInternalsCache() {
  internalsCache = null
  internalsKey = ''
}

export { PLUGIN_ROOT }
