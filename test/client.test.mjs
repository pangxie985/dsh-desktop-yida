/**
 * `lib/client.js`（Client 半）的结构测试。
 *
 * client bundle 是交给浏览器加载的 `window.__ModuleLoader__.load({ id, factory })`
 * 单文件，无法直接 import。这里用假 `window` 与假 `require('react')` 把它求值一遍，
 * 验证：bundle 能加载、导出的 apply/inject 形态正确、注册的 tab 类型与正文符合契约。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

/** 载入 bundle，返回 { chunk, exports }。 */
function loadBundle() {
  const captured = { chunk: null }
  const fakeWindow = {
    __ModuleLoader__: {
      load(chunk) {
        captured.chunk = chunk
      },
    },
  }
  const fakeReact = {
    createElement: (...args) => ({ type: 'element', args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const requireFn = (id) => {
    if (id === 'react') return fakeReact
    throw new Error('未声明的平台模块：' + id)
  }
  // 只在受控作用域里给 bundle 提供 window，避免污染全局。
  const evaluate = new Function('window', 'require', SOURCE)
  evaluate(fakeWindow, requireFn)
  assert.ok(captured.chunk, 'bundle 未调用 window.__ModuleLoader__.load')
  return { chunk: captured.chunk, exports: captured.chunk.factory(requireFn) }
}

/** 造一个只记录注册动作的假 client ctx。 */
function makeClientCtx() {
  const state = { tabDef: null, bodySlot: null, body: null, injected: [], opened: [] }
  const ctx = {
    effect(fn) {
      return fn()
    },
    sidebarRightTabs: {
      register(definition) {
        state.tabDef = definition
        return () => {}
      },
    },
    sidebarRight: {
      openTab(kind, options) {
        state.opened.push({ kind, options })
      },
    },
    slots: {
      inject(name, fn) {
        state.injected.push(name)
        return fn()
      },
      register(options, Body) {
        state.bodySlot = options
        state.body = Body
        return () => {}
      },
    },
  }
  return { ctx, state }
}

test('bundle id 与插件名一致', () => {
  const { chunk } = loadBundle()
  assert.equal(chunk.id, 'dsh-desktop-yida')
  assert.equal(typeof chunk.factory, 'function')
})

test('导出 apply 与 inject', () => {
  const { exports } = loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs', 'sidebarRight'])
})

test('apply 注册 tab 类型与正文', () => {
  const { exports } = loadBundle()
  const { ctx, state } = makeClientCtx()
  exports.apply(ctx)
  assert.equal(state.injected[0], 'sidebar.right.pane.tab')
  assert.equal(state.bodySlot.name, 'sidebar.right.pane.tab')
  assert.equal(state.bodySlot.key, 'dsh-desktop-yida/workbench')
  assert.equal(typeof state.body, 'function')
})

test('tab 类型声明符合 sidebar-right 契约', () => {
  const { exports } = loadBundle()
  const { ctx, state } = makeClientCtx()
  exports.apply(ctx)
  const definition = state.tabDef
  assert.equal(definition.id, 'dsh-desktop-yida/workbench')
  assert.equal(definition.kind, 'yida-workbench')
  assert.equal(definition.keepMounted, true)
  assert.equal(typeof definition.title, 'function')
  assert.equal(definition.title(), '宜搭工作台')
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].kind, undefined)
})

test('guide 条目的 title/description 必须是函数（注册表会调用它们）', () => {
  const { exports } = loadBundle()
  const { ctx, state } = makeClientCtx()
  exports.apply(ctx)
  const entry = state.tabDef.guide[0]
  // 官方实现按 entry.title() / entry.description?.() 调用，字符串会直接抛错。
  assert.equal(typeof entry.title, 'function')
  assert.equal(typeof entry.description, 'function')
  assert.equal(entry.title(), '宜搭工作台')
  assert.equal(typeof entry.description(), 'string')
  assert.equal(typeof entry.order, 'number')
  assert.equal(entry.id, 'workbench')
})

test('bundle 不引用未声明的平台模块', () => {
  const captured = { chunk: null }
  const fakeWindow = { __ModuleLoader__: { load: (chunk) => (captured.chunk = chunk) } }
  const requested = []
  const requireFn = (id) => {
    requested.push(id)
    if (id === 'react') {
      return {
        createElement: () => null,
        useState: (v) => [v, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
      }
    }
    throw new Error('未声明的平台模块：' + id)
  }
  new Function('window', 'require', SOURCE)(fakeWindow, requireFn)
  captured.chunk.factory(requireFn)
  assert.deepEqual(requested, ['react'])
})

for (const [testName, fn] of cases) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${testName}`)
  } catch (error) {
    console.error(`FAIL  ${testName}\n      ${error && error.stack}`)
    process.exitCode = 1
  }
}
console.log(`\nclient.test.mjs: ${passed}/${cases.length} 通过`)
