/**
 * 登录 / 登出的 Host 侧支持。
 *
 * 设计要点：
 *   - `openyida login` 在 `OPENYIDA_NO_BROWSER=1` 时不会拉起系统浏览器，而是把授权 URL 打到 stderr：
 *       `Open this URL to login:` + 换行 + URL
 *     我们抓这个 URL 交给「DSH 内置浏览器」打开，用户在内置浏览器里完成钉钉授权，
 *     回调打到 CLI 自己起的 127.0.0.1 loopback 端口（默认 5 分钟超时），登录即完成。
 *   - 这里不依赖浏览器代理插件，也不依赖系统浏览器。
 *
 * @module dsh-desktop-yida/yida-login
 */
import { spawn } from 'node:child_process'
import { resolveCli } from './yida-cli.js'

/** 等待登录 URL 出现的上限。 */
const URL_WAIT_MS = 20_000

/** 当前登录进程（同一时间只允许一个）。 */
let active = null

/**
 * 从 CLI 输出里抽取登录 URL。
 * @param {string} text - CLI 的 stdout/stderr 文本。
 * @returns {string|undefined} 授权 URL。
 */
export function extractAuthUrl(text) {
  if (typeof text !== 'string') return undefined
  const labelled = text.match(/Open this URL to login:\s*\r?\n?\s*(https?:\/\/[^\s"'<>]+)/i)
  if (labelled !== null) return labelled[1]
  const any = text.match(/https?:\/\/[^\s"'<>]+/)
  return any === null ? undefined : any[0]
}

/**
 * 当前登录流程状态。
 * @returns {{running: boolean, url?: string, startedAt?: number, exitCode?: number|null}} 状态。
 */
export function loginState() {
  if (active === null) return { running: false }
  return {
    // running = 登录进程仍存活（拿到 URL 后它还在等 loopback 回调）
    running: active.exitCode === undefined,
    ...(active.url === undefined ? {} : { url: active.url }),
    startedAt: active.startedAt,
    ...(active.exitCode === undefined ? {} : { exitCode: active.exitCode }),
  }
}

/**
 * 中止进行中的登录流程（用户点取消时用）。
 * @returns {boolean} 是否确实中止了一个进程。
 */
export function cancelLogin() {
  if (active === null) return false
  const child = active.child
  active = null
  try {
    child.kill()
  } catch {
    /* 进程可能已退出 */
  }
  return true
}

/**
 * 启动登录：spawn `openyida login`（禁用自动开浏览器），拿到授权 URL 后返回。
 *
 * 进程会继续在后台等待 loopback 回调；URL 过期或用户取消时由调用方 `cancelLogin()`。
 *
 * @param {{cliPath?: string, projectDir?: string}} [settings] - 插件设置。
 * @param {{timeoutMs?: number, spawnImpl?: Function}} [options] - 覆盖项（测试用）。
 * @returns {Promise<{ok: true, url: string, reused?: boolean} | {ok: false, error: string}>} 结果。
 */
export function startLogin(settings = {}, options = {}) {
  if (active !== null && active.url !== undefined && active.exitCode === undefined) {
    return Promise.resolve({ ok: true, url: active.url, reused: true })
  }
  if (active !== null) cancelLogin()

  let resolved
  try {
    resolved = options.resolved ?? resolveCli(settings)
  } catch (error) {
    return Promise.resolve({ ok: false, error: String(error && error.message ? error.message : error) })
  }

  const limit = Number.isFinite(options.timeoutMs) ? options.timeoutMs : URL_WAIT_MS
  const spawnImpl = options.spawnImpl ?? spawn
  let child
  try {
    child = spawnImpl(resolved.command, [...resolved.prefix, 'login'], {
      cwd: settings.projectDir || process.cwd(),
      env: {
        ...process.env,
        OPENYIDA_NO_BROWSER: '1',
        OPENYIDA_NO_BROWSER_HANDOFF: '1',
        NO_COLOR: '1',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return Promise.resolve({ ok: false, error: String(error && error.message ? error.message : error) })
  }

  const entry = { child, url: undefined, startedAt: Date.now(), exitCode: undefined }
  active = entry

  return new Promise((settle) => {
    let buffer = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(value)
    }
    const timer = setTimeout(() => {
      if (entry.url !== undefined) return
      // 超时也要把进程收掉，否则它会一直占着 loopback 端口
      try {
        child.kill()
      } catch {
        /* 进程可能已退出 */
      }
      entry.exitCode = -1
      finish({ ok: false, error: `等待登录 URL 超时（${Math.round(limit / 1000)}s）` })
    }, limit)

    const onChunk = (chunk) => {
      buffer += chunk
      const url = extractAuthUrl(buffer)
      if (url === undefined) return
      entry.url = url
      finish({ ok: true, url })
    }

    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', onChunk)
    }
    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', onChunk)
    }
    child.on('error', (error) => finish({ ok: false, error: String(error && error.message ? error.message : error) }))
    child.on('close', (code) => {
      entry.exitCode = typeof code === 'number' ? code : -1
      if (entry.url === undefined) {
        finish({ ok: false, error: `登录进程已退出（code ${entry.exitCode}），未拿到授权 URL` })
        return
      }
      // URL 已经交出去了：进程退出说明授权完成或失败，状态由 loginState()/CLI 状态接口反映
    })
  })
}

/** 供测试重置模块状态。 */
export function __resetLoginState() {
  active = null
}
