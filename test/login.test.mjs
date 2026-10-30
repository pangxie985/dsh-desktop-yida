/**
 * `lib/yida-login.js` 的单元测试：授权 URL 抽取、登录进程状态机。
 *
 * 用假的 spawn 实现 + 临时日志文件，不真正启动 openyida，也不联网。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetLoginState, cancelLogin, extractAuthUrl, loginState, startLogin } from '../lib/yida-login.js'

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

const DIR = mkdtempSync(join(tmpdir(), 'dsh-yida-login-test-'))
/** 假进程号：不存在，但配合 isAlive 覆盖使用。 */
const FAKE_PID = 999_999

/** 造一个假的子进程对象。 */
function fakeChild() {
  const child = new EventEmitter()
  child.pid = FAKE_PID
  child.stdout = null
  child.stderr = null
  child.unref = () => {}
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

/** 造一个「日志里出现 URL 就成功」假 spawn。 */
function spawnWriting(logPath, text, delayMs = 5) {
  return () => {
    const child = fakeChild()
    setTimeout(() => writeFileSync(logPath, text, { flag: 'a' }), delayMs)
    return child
  }
}

test('extractAuthUrl：识别 openyida 的授权 URL 标记', () => {
  const text = 'some log\nOpen this URL to login:\nhttps://login.dingtalk.com/oauth2/auth?client_id=x&state=y\nWaiting...'
  assert.equal(extractAuthUrl(text), 'https://login.dingtalk.com/oauth2/auth?client_id=x&state=y')
})

test('extractAuthUrl：标记与 URL 在同一行也能识别', () => {
  assert.equal(extractAuthUrl('Open this URL to login: https://a.example.com/x?y=1'), 'https://a.example.com/x?y=1')
})

test('extractAuthUrl：没有标记时退回第一个 http(s) 链接', () => {
  const text = 'logo https://cdn.example.com/a.png then https://login.example.com/auth'
  assert.equal(extractAuthUrl(text), 'https://cdn.example.com/a.png')
})

test('extractAuthUrl：没有 URL 返回 undefined', () => {
  assert.equal(extractAuthUrl('nothing here'), undefined)
  assert.equal(extractAuthUrl(undefined), undefined)
})

test('startLogin：日志里出现 URL 后 resolve', async () => {
  __resetLoginState()
  const logPath = join(DIR, 'a.log')
  const result = await startLogin({}, {
    spawnImpl: spawnWriting(logPath, 'Open this URL to login:\nhttps://login.example.com/auth?state=zz\n'),
    logPath,
    timeoutMs: 2000,
    pollMs: 20,
    isAlive: () => true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.url, 'https://login.example.com/auth?state=zz')
  assert.equal(loginState().url, 'https://login.example.com/auth?state=zz')
  assert.equal(cancelLogin(), true)
  assert.equal(loginState().running, false)
})

test('startLogin：重复调用复用已有 URL', async () => {
  __resetLoginState()
  const logPath = join(DIR, 'b.log')
  const options = {
    spawnImpl: spawnWriting(logPath, 'Open this URL to login:\nhttps://login.example.com/auth?state=reuse\n'),
    logPath,
    timeoutMs: 2000,
    pollMs: 20,
    isAlive: () => true,
  }
  const first = await startLogin({}, options)
  assert.equal(first.ok, true)
  const second = await startLogin({}, options)
  assert.equal(second.ok, true)
  assert.equal(second.reused, true)
  cancelLogin()
})

test('startLogin：等不到 URL 时超时失败', async () => {
  __resetLoginState()
  const logPath = join(DIR, 'c.log')
  const result = await startLogin({}, {
    spawnImpl: () => fakeChild(),
    logPath,
    timeoutMs: 80,
    pollMs: 20,
    isAlive: () => true,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /超时/)
})

test('startLogin：进程退出且没给 URL 时失败，并带回输出尾巴', async () => {
  __resetLoginState()
  const logPath = join(DIR, 'd.log')
  const child = fakeChild()
  const spawnImpl = () => {
    setTimeout(() => {
      writeFileSync(logPath, 'boom: something failed\n', { flag: 'a' })
      child.emit('exit', 3, null)
    }, 10)
    return child
  }
  const result = await startLogin({}, { spawnImpl, logPath, timeoutMs: 1000, pollMs: 20, isAlive: () => true })
  assert.equal(result.ok, false)
  assert.match(result.error, /code 3/)
  assert.match(result.tail, /boom/)
})

for (const [name, fn] of cases) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error && error.stack}`)
    process.exitCode = 1
  }
}
console.log(`\nlogin.test.mjs: ${passed}/${cases.length} 通过`)
