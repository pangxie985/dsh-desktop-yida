/**
 * `lib/index.js`（Host 半）的端到端测试。
 *
 * 说明：本仓库的自动化测试跑在 DSH 的文件沙箱里，沙箱内 Node 无法用管道
 * stdio 派生子进程（`spawn EPERM`），因此这里通过 `__setRunner` 注入一个
 * 在进程内模拟 OpenYida 输出（含 JSON、退出码、stderr）的执行器替身；
 * 真实的子进程链路由 `test/smoke.mjs` 在放开权限时单独验证。
 *
 * 覆盖点：工具/路由注册、只读工具解析、写入门禁、HTTP 路由的校验与载荷。
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, __setAppLister, __setAuthResolver, __setRunner, apply } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 存在即可，用于让 resolveCli 通过；执行由替身接管。 */
const FAKE_CLI = join(HERE, 'fixtures', 'fake-openyida.mjs')

/** 默认不读真实登录态（避免单测依赖本机 profile）；个别用例再覆盖。 */
__setAuthResolver(() => null)

/** 直接接口拿应用列表的替身（全是虚构数据，避免把任何真实租户信息写进仓库）。 */
const DEMO_BASE_URL = 'https://yida.example.com'
const DEMO_USER_ID = '10000001'
const DEMO_APP_ADMIN = 'APP_DEMO0000000000000001'
const DEMO_APP_ALL = 'APP_DEMO0000000000000002'

__setAppLister(async (_settings, input) => ({
  ok: true,
  baseUrl: DEMO_BASE_URL,
  userId: DEMO_USER_ID,
  scope: input.scope,
  totalCount: input.scope === 'admin' ? 3 : 266,
  apps: [
    {
      appName: input.scope === 'admin' ? '演示应用（我是管理员）' : '演示应用（我能访问）',
      appType: input.scope === 'admin' ? DEMO_APP_ADMIN : DEMO_APP_ALL,
    },
  ],
}))

const WRITE_COMMANDS = ['create-app', 'create-form', 'publish', 'app-online', 'app-offline']
let rejectWrites = false
let spawnedCommands = []

/** 进程内的 OpenYida 替身。 */
function fakeRunner(args) {
  const command = args[0]
  spawnedCommands.push(args.join(' '))
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  if (command === 'agent-capabilities') {
    return Promise.resolve(
      ok({ version: '2026.10.10-1', login: { status: 'logged_in', auth_mode: 'token', next_step: null }, workdir: process.cwd() }),
    )
  }
  if (command === 'commands') return Promise.resolve(ok({ version: '2026.10.10-1', groups: [{ id: 'app' }] }))
  if (command === 'org') {
    if (args[1] === 'list') {
      return Promise.resolve(
        ok({
          ok: true,
          current_corp_id: 'dingCURRENT',
          count: 2,
          organizations: [
            { corpId: 'dingCURRENT', corpName: '当前组织', isCurrent: true },
            { corpId: 'dingOTHER', corpName: '另一个组织', isCurrent: false },
          ],
        }),
      )
    }
    return Promise.resolve(ok({ ok: true, current_corp_id: args[3] }))
  }
  if (command === 'app-list') {
    return Promise.resolve(
      ok([
        { appType: 'APP_TEST0001', name: '演示应用', description: '来自假 CLI' },
        { appType: 'APP_TEST0002', name: '第二个应用' },
      ]),
    )
  }
  if (command === 'list-forms') {
    return Promise.resolve(ok([{ formUuid: 'FORM-TEST01', title: '客户登记' }, { formUuid: 'FORM-TEST02', title: '拜访记录' }]))
  }
  if (command === 'get-schema') return Promise.resolve(ok({ content: { pages: [] }, gmtModified: 1719705600000 }))
  if (command === 'data') return Promise.resolve(ok({ data: [{ id: 1 }], totalCount: 1 }))
  if (WRITE_COMMANDS.includes(command)) {
    if (rejectWrites) return Promise.resolve({ code: 3, stdout: '', stderr: 'fake: 远程写入被拒绝' })
    return Promise.resolve(ok({ ok: true, accepted: args.join(' '), argv: args }))
  }
  // 覆盖 stdout 混日志的场景，验证解析器容错。
  if (command === 'noisy') return Promise.resolve({ code: 0, stdout: '[info] 准备中\n[{"k":1}]\n', stderr: '' })
  return Promise.resolve({ code: 2, stdout: '', stderr: 'fake: 未知命令 ' + args.join(' ') })
}

__setRunner(fakeRunner)

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

/** 建一个只记录注册结果的假 ctx。 */
function makeCtx() {
  const tools = []
  const routes = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  return { ctx, tools, routes }
}

/** 启动插件。 */
function boot(overrides = {}) {
  const settings = Config.validate({ ...overrides })
  settings.cliPath = FAKE_CLI
  const harness = makeCtx()
  apply(harness.ctx, settings)
  const tool = (name) => {
    const found = harness.tools.find((item) => item.name === name)
    assert.ok(found, `工具 ${name} 未注册`)
    return found
  }
  return { ...harness, settings, tool }
}

/** 造一个最小 req/res。 */
function makeReqRes(url, { host = '127.0.0.1:19387', method = 'GET' } = {}) {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text ?? ''
    },
  }
  return { req: { url, method, headers: { host } }, res }
}

test('注册了全部 yida_* 工具', () => {
  const { tools } = boot()
  assert.deepEqual(
    tools.map((item) => item.name).sort(),
    [
      'yida_app_entry',
      'yida_apps',
      'yida_create_app',
      'yida_create_form',
      'yida_data_query',
      'yida_forms',
      'yida_org_list',
      'yida_org_switch',
      'yida_patch_form',
      'yida_publish_page',
      'yida_schema',
      'yida_status',
      'yida_update_form',
      'yida_urls',
    ],
  )
})

test('每个工具的 output.render 都能产出文本块', () => {
  const { tools } = boot()
  for (const tool of tools) {
    const blocks = tool.output.render({}, { ok: true })
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
  }
})

test('注册了 /yida/api 前缀路由', () => {
  const { routes } = boot()
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/yida/api')
  assert.equal(typeof routes[0].handler, 'function')
})

test('yida_status：解析登录态与版本', async () => {
  const { tool } = boot()
  const value = await tool('yida_status').execute({})
  assert.equal(value.ok, true)
  assert.equal(value.loginStatus, 'logged_in')
  assert.equal(value.authMode, 'token')
  assert.equal(value.version, '2026.10.10-1')
})

test('yida_org_list：列出组织并标出当前', async () => {
  const { tool } = boot()
  const value = await tool('yida_org_list').execute({})
  assert.equal(value.ok, true)
  assert.equal(value.command, 'openyida org list --json')
  assert.equal(value.data.current_corp_id, 'dingCURRENT')
  assert.equal(value.data.organizations.length, 2)
})

test('yida_org_switch：需要 confirm（写入门禁同样适用）', async () => {
  const { tool } = boot()
  const blocked = await tool('yida_org_switch').execute({ corpId: 'dingOTHER' })
  assert.equal(blocked.ok, false)
  assert.match(blocked.blocked, /confirm/)
  const done = await tool('yida_org_switch').execute({ corpId: 'dingOTHER', confirm: true })
  assert.equal(done.ok, true)
  assert.equal(done.command, 'openyida org switch --corp-id dingOTHER')
})

test('yida_apps：返回应用数组与命令行', async () => {
  const { tool } = boot()
  const value = await tool('yida_apps').execute({})
  assert.equal(value.ok, true)
  assert.equal(value.data.length, 2)
  assert.equal(value.data[0].appType, 'APP_TEST0001')
  assert.equal(value.command, 'openyida app-list --type managed --page 1 --size 50')
})

test('yida_forms：缺 appType 时执行器报错', async () => {
  const { tool } = boot()
  await assert.rejects(() => tool('yida_forms').execute({}), /appType/)
})

test('yida_schema：按 formUuid 读取', async () => {
  const { tool } = boot()
  const value = await tool('yida_schema').execute({ appType: 'APP_TEST0001', formUuid: 'FORM-TEST01' })
  assert.equal(value.ok, true)
  assert.equal(value.command, 'openyida get-schema APP_TEST0001 FORM-TEST01')
})

test('yida_urls：推导地址并排队打开', async () => {
  const { tool, routes } = boot()
  const value = await tool('yida_urls').execute({ appType: 'APP_TEST0001', formUuid: 'FORM-TEST01', open: true })
  assert.equal(value.workbenchUrl, 'https://www.aliwork.com/APP_TEST0001/workbench')
  assert.equal(value.queuedOpen, 'https://www.aliwork.com/APP_TEST0001/workbench')
  const { req, res } = makeReqRes('/yida/api/pending')
  await routes[0].handler(req, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].url, 'https://www.aliwork.com/APP_TEST0001/workbench')
  // 队列取出后即空，避免重复打开。
  const second = makeReqRes('/yida/api/pending')
  await routes[0].handler(second.req, second.res)
  assert.equal(JSON.parse(second.res.body).items.length, 0)
})

test('yida_urls：target=admin 时排队管理台', async () => {
  const { tool, routes } = boot()
  await tool('yida_urls').execute({ appType: 'APP_TEST0001', open: true, target: 'admin' })
  const { req, res } = makeReqRes('/yida/api/pending')
  await routes[0].handler(req, res)
  assert.equal(JSON.parse(res.body).items[0].url, 'https://www.aliwork.com/APP_TEST0001/admin')
})

test('yida_urls：不传 appType 时排队宜搭首页', async () => {
  const { tool, routes } = boot()
  const value = await tool('yida_urls').execute({ open: true, target: 'home' })
  assert.equal(value.homeUrl, 'https://www.aliwork.com/workPlatform')
  assert.equal(value.queuedOpen, 'https://www.aliwork.com/workPlatform')
  const { req, res } = makeReqRes('/yida/api/pending')
  await routes[0].handler(req, res)
  assert.equal(JSON.parse(res.body).items[0].url, 'https://www.aliwork.com/workPlatform')
})

test('写入工具：dryRun 不执行', async () => {
  const { tool } = boot()
  spawnedCommands = []
  const value = await tool('yida_create_app').execute({ name: 'CRM', dryRun: true })
  assert.equal(value.ok, false)
  assert.match(value.blocked, /dry-run/)
  assert.equal(value.command, 'openyida create-app --name CRM')
  assert.equal(spawnedCommands.length, 0)
})

test('写入工具：缺 confirm 被拒', async () => {
  const { tool } = boot()
  const value = await tool('yida_create_app').execute({ name: 'CRM' })
  assert.equal(value.ok, false)
  assert.match(value.blocked, /confirm/)
})

test('写入工具：allowRemoteWrites=false 时被拒', async () => {
  const { tool } = boot({ allowRemoteWrites: false })
  const value = await tool('yida_create_app').execute({ name: 'CRM', confirm: true })
  assert.equal(value.ok, false)
  assert.match(value.blocked, /allowRemoteWrites/)
})

test('写入工具：confirm + 放行后真执行', async () => {
  const { tool } = boot()
  const value = await tool('yida_create_app').execute({ name: 'CRM', confirm: true })
  assert.equal(value.ok, true)
  assert.equal(value.data.ok, true)
  assert.equal(value.data.accepted, 'create-app --name CRM')
})

test('写入工具：CLI 失败时把退出码与 stderr 带回来', async () => {
  const { tool } = boot()
  rejectWrites = true
  try {
    const value = await tool('yida_create_app').execute({ name: 'CRM', confirm: true })
    assert.equal(value.ok, false)
    assert.equal(value.exitCode, 3)
    assert.match(value.stderr, /远程写入被拒绝/)
  } finally {
    rejectWrites = false
  }
})

test('路由：apps 返回 JSON', async () => {
  const { routes } = boot()
  const { req, res } = makeReqRes('/yida/api/apps?size=10')
  await routes[0].handler(req, res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.length, 2)
  assert.match(res.headers['content-type'], /application\/json/)
})

test('路由：status 只回传登录态与版本', async () => {
  const { routes } = boot()
  const { req, res } = makeReqRes('/yida/api/status')
  await routes[0].handler(req, res)
  const payload = JSON.parse(res.body)
  assert.deepEqual(Object.keys(payload).sort(), ['cli', 'loginStatus', 'nextStep', 'ok', 'version'])
  assert.equal(payload.loginStatus, 'logged_in')
})

test('路由：forms 缺 appType 时返回 500 且不抛出', async () => {
  const { routes } = boot()
  const { req, res } = makeReqRes('/yida/api/forms')
  await routes[0].handler(req, res)
  assert.equal(res.status, 500)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('路由：非回环 Host 返回 403', async () => {
  const { routes } = boot()
  const { req, res } = makeReqRes('/yida/api/apps', { host: 'evil.example.com' })
  await routes[0].handler(req, res)
  assert.equal(res.status, 403)
})

test('路由：非 GET 返回 405', async () => {
  const { routes } = boot()
  const { req, res } = makeReqRes('/yida/api/apps', { method: 'POST' })
  await routes[0].handler(req, res)
  assert.equal(res.status, 405)
})

test('路由：未知子路径返回 404', async () => {
  const { routes } = boot()
  const { req, res } = makeReqRes('/yida/api/nope')
  await routes[0].handler(req, res)
  assert.equal(res.status, 404)
})

test('路由：config 暴露站点与写入开关', async () => {
  const { routes } = boot({ baseUrl: 'https://yida.example.com' })
  const { req, res } = makeReqRes('/yida/api/config')
  await routes[0].handler(req, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.baseUrl, 'https://yida.example.com')
  assert.equal(payload.baseUrlSource, 'config')
  assert.equal(payload.allowRemoteWrites, true)
})

test('yida_apps：scope=admin 走直接接口（不加 creator 过滤）', async () => {
  const { tool } = boot()
  const value = await tool('yida_apps').execute({ scope: 'admin' })
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'direct-api')
  assert.equal(value.totalCount, 3)
  assert.equal(value.data[0].appType, DEMO_APP_ADMIN)
})

test('yida_apps：scope=all 走直接接口', async () => {
  const { tool } = boot()
  const value = await tool('yida_apps').execute({ scope: 'all' })
  assert.equal(value.totalCount, 266)
  assert.equal(value.scope, 'all')
})

test('yida_apps：默认 scope=mine 仍走 CLI', async () => {
  const { tool } = boot()
  spawnedCommands = []
  const value = await tool('yida_apps').execute({})
  assert.equal(value.command, 'openyida app-list --type managed --page 1 --size 50')
  assert.equal(spawnedCommands[0], 'app-list --type managed --page 1 --size 50')
})

test('路由：apps?scope=all 走直接接口', async () => {
  const { routes } = boot()
  const { req, res } = makeReqRes('/yida/api/apps?scope=all&size=20')
  await routes[0].handler(req, res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.mode, 'direct-api')
  assert.equal(payload.totalCount, 266)
})

test('站点地址默认取登录站点（企业专属不在 www.aliwork.com）', async () => {
  __setAuthResolver(() => ({ baseUrl: DEMO_BASE_URL, userId: DEMO_USER_ID }))
  try {
    const { tool, routes } = boot()
    const value = await tool('yida_urls').execute({ appType: DEMO_APP_ADMIN })
    assert.equal(value.workbenchUrl, `${DEMO_BASE_URL}/${DEMO_APP_ADMIN}/workbench`)
    const { req, res } = makeReqRes('/yida/api/config')
    await routes[0].handler(req, res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.baseUrl, DEMO_BASE_URL)
    assert.equal(payload.baseUrlSource, 'login')
    assert.equal(payload.userId, DEMO_USER_ID)
  } finally {
    __setAuthResolver(() => null)
  }
})

test('路由：urls 返回三段地址', async () => {
  const { routes } = boot()
  const { req, res } = makeReqRes('/yida/api/urls?appType=APP_TEST0001&formUuid=FORM-TEST01')
  await routes[0].handler(req, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.workbenchUrl, 'https://www.aliwork.com/APP_TEST0001/workbench')
  assert.equal(payload.adminUrl, 'https://www.aliwork.com/APP_TEST0001/admin')
  assert.equal(payload.pageUrl, 'https://www.aliwork.com/APP_TEST0001/workbench/FORM-TEST01')
})

for (const [testName, fn] of cases) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${testName}`)
  } catch (error) {
    console.error(`FAIL  ${testName}\n      ${error && error.stack}`)
    process.exitCode = 1
  }
}
console.log(`\nplugin.test.mjs: ${passed}/${cases.length} 通过`)
