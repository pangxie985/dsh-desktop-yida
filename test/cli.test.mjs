/**
 * `lib/yida-cli.js` 的单元测试：参数编译、URL 推导、JSON 解析。
 * 零依赖，直接 `node test/cli.test.mjs` 运行。
 */
import assert from 'node:assert/strict'
import { buildArgs, cliCandidates, parseJsonOutput, urlsFor } from '../lib/yida-cli.js'

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

test('orgList：走 org list --json', () => {
  assert.deepEqual(buildArgs('orgList', {}), ['org', 'list', '--json'])
})

test('orgSwitch：带 corpId', () => {
  assert.deepEqual(buildArgs('orgSwitch', { corpId: 'dingabc123' }), ['org', 'switch', '--corp-id', 'dingabc123'])
})

test('orgSwitch：缺 corpId 抛错', () => {
  assert.throws(() => buildArgs('orgSwitch', {}), /corpId/)
})

test('apps：默认 managed / page 1 / size 50', () => {
  assert.deepEqual(buildArgs('apps', {}), ['app-list', '--type', 'managed', '--page', '1', '--size', '50'])
})

test('apps：type=created 与分页收敛', () => {
  assert.deepEqual(buildArgs('apps', { type: 'created', page: 3, size: 999 }), [
    'app-list',
    '--type',
    'created',
    '--page',
    '3',
    '--size',
    '100',
  ])
})

test('forms：拼接 keyword', () => {
  assert.deepEqual(buildArgs('forms', { appType: 'APP_ABC123', keyword: '客户' }), [
    'list-forms',
    'APP_ABC123',
    '--keyword',
    '客户',
  ])
})

test('forms：缺 appType 抛错', () => {
  assert.throws(() => buildArgs('forms', {}), /appType/)
})

test('forms：appType 形态不对抛错', () => {
  assert.throws(() => buildArgs('forms', { appType: 'abc' }), /形态不对/)
})

test('schema：all 与 summary', () => {
  assert.deepEqual(buildArgs('schema', { appType: 'APP_ABC123', all: true, summary: true }), [
    'get-schema',
    'APP_ABC123',
    '--all',
    '--summary-json',
  ])
})

test('schema：指定 formUuid', () => {
  assert.deepEqual(buildArgs('schema', { appType: 'APP_ABC123', formUuid: 'FORM-X1' }), [
    'get-schema',
    'APP_ABC123',
    'FORM-X1',
  ])
})

test('schema：formUuid 形态不对抛错', () => {
  assert.throws(() => buildArgs('schema', { appType: 'APP_ABC123', formUuid: 'X1' }), /formUuid/)
})

test('updateForm：走 create-form update', () => {
  assert.deepEqual(
    buildArgs('updateForm', { appType: 'APP_ABC123', formUuid: 'FORM-X1', changesFile: 'changes.json' }),
    ['create-form', 'update', 'APP_ABC123', 'FORM-X1', 'changes.json'],
  )
})

test('createApp：带描述', () => {
  assert.deepEqual(buildArgs('createApp', { name: 'CRM', desc: '客户管理' }), [
    'create-app',
    '--name',
    'CRM',
    '--desc',
    '客户管理',
  ])
})

test('publishPage：sourceFile 在前', () => {
  assert.deepEqual(buildArgs('publishPage', { sourceFile: 'home.canvas.jsx', appType: 'APP_ABC123', formUuid: 'FORM-X1' }), [
    'publish',
    'home.canvas.jsx',
    'APP_ABC123',
    'FORM-X1',
  ])
})

test('未知操作抛错', () => {
  assert.throws(() => buildArgs('nope', {}), /未知操作/)
})

test('urlsFor：工作台/管理台/表单页', () => {
  const urls = urlsFor({ appType: 'APP_ABC123', formUuid: 'FORM-X1' })
  assert.equal(urls.workbenchUrl, 'https://www.aliwork.com/APP_ABC123/workbench')
  assert.equal(urls.adminUrl, 'https://www.aliwork.com/APP_ABC123/admin')
  assert.equal(urls.pageUrl, 'https://www.aliwork.com/APP_ABC123/workbench/FORM-X1')
})

test('urlsFor：appType 非法时给首页但不出页面地址', () => {
  const urls = urlsFor({ appType: 'bad' })
  assert.equal(urls.workbenchUrl, undefined)
  assert.equal(urls.homeUrl, 'https://www.aliwork.com/workPlatform')
  assert.equal(urls.origin, 'https://www.aliwork.com')
})

test('urlsFor：不传 appType 也能给首页', () => {
  const urls = urlsFor({})
  assert.equal(urls.homeUrl, 'https://www.aliwork.com/workPlatform')
  assert.equal(urls.workbenchUrl, undefined)
})

test('urlsFor：专属版域名走 baseUrl', () => {
  const urls = urlsFor({ appType: 'APP_ABC123', baseUrl: 'https://yida.example.com/portal' })
  assert.equal(urls.workbenchUrl, 'https://yida.example.com/APP_ABC123/workbench')
})

test('parseJsonOutput：跳过前置日志', () => {
  const value = parseJsonOutput('[info] 正在读取\n[{"appType":"APP_A"}]\n')
  assert.deepEqual(value, [{ appType: 'APP_A' }])
})

test('parseJsonOutput：无 JSON 返回 undefined', () => {
  assert.equal(parseJsonOutput('登录过期，请重新登录'), undefined)
})

test('cliCandidates：settings 优先于环境变量与 PATH', () => {
  const list = cliCandidates({ cliPath: 'D:/x/yida.js' })
  assert.equal(list[0].source, 'settings.cliPath')
  assert.equal(list[0].path, 'D:/x/yida.js')
  assert.equal(list[list.length - 1].source, 'PATH')
})

for (const [testName, fn] of cases) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${testName}`)
  } catch (error) {
    console.error(`FAIL  ${testName}\n      ${error && error.message}`)
    process.exitCode = 1
  }
}
console.log(`\ncli.test.mjs: ${passed}/${cases.length} 通过`)
