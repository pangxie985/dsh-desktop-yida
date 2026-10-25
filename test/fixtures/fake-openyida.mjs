/**
 * 测试用的假 OpenYida CLI：按 argv 输出 JSON，绝不联网。
 * 用法：node fake-openyida.mjs <command> [...args]
 */
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)

if (has('--help') || has('-h')) {
  console.log('fake openyida')
  process.exit(0)
}

const command = args[0]

if (command === 'agent-capabilities') {
  console.log(
    JSON.stringify({
      version: '2026.10.10-1',
      login: { status: 'logged_in', auth_mode: 'token', next_step: null },
      workdir: process.cwd(),
    }),
  )
  process.exit(0)
}

if (command === 'commands') {
  console.log(
    JSON.stringify({
      schema_version: 1,
      version: '2026.10.10-1',
      groups: [{ id: 'app', title: '应用管理', commands: ['app-list', 'update-app'] }],
    }),
  )
  process.exit(0)
}

if (command === 'app-list') {
  console.log(
    JSON.stringify([
      { appType: 'APP_TEST0001', name: '演示应用', description: '来自假 CLI' },
      { appType: 'APP_TEST0002', name: '第二个应用' },
    ]),
  )
  process.exit(0)
}

if (command === 'list-forms') {
  console.log(
    JSON.stringify([
      { formUuid: 'FORM-TEST01', title: '客户登记' },
      { formUuid: 'FORM-TEST02', title: '拜访记录' },
    ]),
  )
  process.exit(0)
}

if (command === 'get-schema') {
  console.log(JSON.stringify({ content: { pages: [], componentsMap: [] }, gmtModified: 1719705600000 }))
  process.exit(0)
}

if (command === 'app-entry') {
  console.log(JSON.stringify({ frontend: 'https://www.aliwork.com/APP_TEST0001/workbench', management: null }))
  process.exit(0)
}

if (command === 'data') {
  console.log(JSON.stringify({ data: [{ id: 1 }], totalCount: 1 }))
  process.exit(0)
}

// 写入类命令：默认成功；FAKE_REJECT_WRITES=1 时失败，用于验证错误路径。
const WRITE_COMMANDS = ['create-app', 'create-form', 'publish', 'app-online', 'app-offline']
if (WRITE_COMMANDS.includes(command)) {
  if (process.env.FAKE_REJECT_WRITES === '1') {
    console.error('fake: 远程写入被拒绝')
    process.exit(3)
  }
  console.log(JSON.stringify({ ok: true, accepted: args.join(' '), argv: args }))
  process.exit(0)
}

console.error('fake openyida: 未知命令 ' + args.join(' '))
process.exit(2)
