/**
 * `lib/patch-file.mjs` 的单元测试：空 overlay 判定、insert 条目删除。
 *
 * 覆盖他人反馈的两类事故：`[]` 文档被拼接成非法 YAML、以及残留孤立条目。
 */
import assert from 'node:assert/strict'
import { isEmptyOverlay, stripPatchComments, stripPatchEntry } from '../lib/patch-file.mjs'

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

const BLOCK = [
  '# dsh-desktop-yida：AI 辅助创建/编辑钉钉宜搭应用 + 右侧栏「宜搭工作台」',
  '- insert:',
  '    - id: dsh-desktop-yida',
  '      name: dsh-desktop-yida',
].join('\n')

test('isEmptyOverlay：空文件 / [] / 仅注释都算空', () => {
  assert.equal(isEmptyOverlay(''), true)
  assert.equal(isEmptyOverlay('[]\n'), true)
  assert.equal(isEmptyOverlay('[]'), true)
  assert.equal(isEmptyOverlay('\n\n'), true)
  assert.equal(isEmptyOverlay('# only comment\n'), true)
  assert.equal(isEmptyOverlay('---\n[]\n'), true)
})

test('isEmptyOverlay：有真实条目就不算空', () => {
  assert.equal(isEmptyOverlay('- id: plugin-market\n  name: x\n'), false)
})

test('stripPatchEntry：删除末尾条目，其余内容不动', () => {
  const input = ['- id: plugin-market', '  name: "@deepseek-ai/dsh-plugin-market"', '', BLOCK, ''].join('\n')
  const { text, removed } = stripPatchEntry(input, ['dsh-desktop-yida'])
  assert.deepEqual(removed, ['dsh-desktop-yida'])
  assert.ok(!text.includes('dsh-desktop-yida'))
  assert.ok(text.includes('plugin-market'))
  // 不能残留孤立的 - insert:
  assert.ok(!/- insert:\s*$/m.test(text))
})

test('stripPatchEntry：删除中间条目后不会产生孤立 insert', () => {
  const input = ['- id: a', '  name: a', '- insert:', '    - id: dsh-desktop-yida', '      name: dsh-desktop-yida', '- id: b', '  name: b', ''].join('\n')
  const { text, removed } = stripPatchEntry(input, ['dsh-desktop-yida'])
  assert.deepEqual(removed, ['dsh-desktop-yida'])
  assert.ok(!text.includes('dsh-desktop-yida'))
  assert.ok(text.includes('- id: a') && text.includes('- id: b'))
})

test('stripPatchEntry：处理 [] 空文档 + 我们的块（他人反馈的坏文件）', () => {
  const broken = ['[]', '', BLOCK, ''].join('\n')
  const { text, removed } = stripPatchEntry(broken, ['dsh-desktop-yida'])
  assert.deepEqual(removed, ['dsh-desktop-yida'])
  assert.equal(isEmptyOverlay(text), true)
  assert.ok(!text.includes('insert'))
})

test('stripPatchEntry：旧包名 dsh-yida 一并清理', () => {
  const input = ['- insert:', '    - id: dsh-yida', '      name: dsh-yida', ''].join('\n')
  const { text, removed } = stripPatchEntry(input, ['dsh-desktop-yida', 'dsh-yida'])
  assert.deepEqual(removed, ['dsh-yida'])
  assert.equal(isEmptyOverlay(text), true)
})

test('stripPatchEntry：没有目标条目时原样返回（只做空白归一）', () => {
  const input = '- id: plugin-market\n  name: x\n'
  const { text, removed } = stripPatchEntry(input, ['dsh-desktop-yida'])
  assert.deepEqual(removed, [])
  assert.equal(text, input)
})

test('stripPatchEntry：id 行带引号也能识别', () => {
  const input = ['- insert:', "    - id: 'dsh-desktop-yida'", '      name: dsh-desktop-yida', ''].join('\n')
  const { removed } = stripPatchEntry(input, ['dsh-desktop-yida'])
  assert.deepEqual(removed, ['dsh-desktop-yida'])
})

test('stripPatchComments：清掉本插件的历史注释', () => {
  const input = ['# dsh-desktop-yida：xxx', '- id: plugin-market', '  name: x', ''].join('\n')
  const text = stripPatchComments(input, ['dsh-desktop-yida'])
  assert.ok(!text.includes('dsh-desktop-yida'))
  assert.ok(text.includes('plugin-market'))
})

for (const [name, fn] of cases) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error && error.stack}`)
    process.exitCode = 1
  }
}
console.log(`\npatch-file.test.mjs: ${passed}/${cases.length} 通过`)
