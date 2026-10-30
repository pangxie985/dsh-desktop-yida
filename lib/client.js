/**
 * `dsh-desktop-yida` Client 半：在右侧 Sidebar 注册「宜搭工作台」页面。
 *
 * 承载形式与 DSH 自带的 client 插件一致——`window.__ModuleLoader__.load({ id, factory })`，
 * factory 收到的 `require` 由宿主按冻结的平台模块表解析（React 由基座提供）。
 *
 * 能力：
 *   1. 读取 Host 半的只读接口 `/yida/api/*`，展示登录态、应用列表、表单列表；
 *   2. 一键把应用工作台 / 管理台 / 表单页交给 DSH 内置浏览器标签页打开
 *      （`ctx.sidebarRight.openTab('browser', { params: { url } })`）；
 *   3. 轮询 `/yida/api/pending`：模型侧调过 `yida_urls { open: true }` 后，
 *      由本页面代为调用内置浏览器打开，实现「AI 建完应用→右侧自动展示」。
 *
 * @module dsh-desktop-yida/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-yida',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    /** 需要注入的浏览器服务。 */
    var inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

    /** 本插件在 tab 系统中的唯一身份，也是正文注册所用的 key。 */
    var TAB_ID = 'dsh-desktop-yida/workbench'
    /** 页面类型（page type 不带 patterns，按 kind 打开）。 */
    var KIND = 'yida-workbench'
    /** Host 半的只读接口前缀。 */
    var API = '/yida/api'
    /** 轮询打开请求的间隔（毫秒）。 */
    var POLL_MS = 2000

    var C = {
      text: 'var(--dsh-text, #e8e8ef)',
      dim: 'var(--dsh-text-dim, #9a9aa8)',
      line: 'var(--dsh-border, rgba(255,255,255,0.12))',
      accent: '#4d6bfe',
      card: 'var(--dsh-surface, rgba(255,255,255,0.04))',
      danger: '#e0604d',
      ok: '#39b46a',
    }

    var wrap = { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', fontSize: 12, color: C.text }
    var bar = { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid ' + C.line, flex: '0 0 auto' }
    var scroll = { flex: '1 1 auto', overflow: 'auto', padding: '8px 10px 16px' }
    var btn = {
      border: '1px solid ' + C.line,
      background: 'transparent',
      color: C.text,
      borderRadius: 6,
      padding: '2px 8px',
      fontSize: 11,
      cursor: 'pointer',
      flex: '0 0 auto',
    }
    var primary = Object.assign({}, btn, { background: C.accent, borderColor: C.accent, color: '#fff' })
    var row = { border: '1px solid ' + C.line, background: C.card, borderRadius: 8, padding: '8px 10px', marginBottom: 8 }
    var input = {
      flex: '1 1 auto',
      minWidth: 0,
      background: 'transparent',
      border: '1px solid ' + C.line,
      borderRadius: 6,
      color: C.text,
      padding: '3px 8px',
      fontSize: 11,
    }

    /** 读一个 JSON 接口；网络或解析失败都返回 `{ ok: false, error }`。 */
    async function getJson(path) {
      try {
        var response = await fetch(API + path, { headers: { accept: 'application/json' } })
        var text = await response.text()
        try {
          return JSON.parse(text)
        } catch (error) {
          return { ok: false, error: '响应不是 JSON：' + text.slice(0, 200) }
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    }

    /** POST 一个 JSON 接口（登录/登出用）。 */
    async function postJson(path, payload) {
      try {
        var response = await fetch(API + path, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        })
        var text = await response.text()
        try {
          return JSON.parse(text)
        } catch (error) {
          return { ok: false, error: '响应不是 JSON：' + text.slice(0, 200) }
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    }

    /** 等待若干毫秒。 */
    function sleep(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms)
      })
    }

    /** 归一化 OpenYida 的列表输出：既可能是数组，也可能包在字段里。 */
    function asList(value) {
      if (Array.isArray(value)) return value
      if (value && typeof value === 'object') {
        for (var key of ['data', 'list', 'apps', 'forms', 'items', 'result']) {
          if (Array.isArray(value[key])) return value[key]
        }
      }
      return []
    }

    /** 从应用对象里取 appType / 名称。 */
    function appFields(item) {
      if (!item || typeof item !== 'object') return { appType: String(item), name: '' }
      return {
        appType: item.appType || item.appType_ || item.id || '',
        name: item.name || item.appName || item.title || '',
        desc: item.desc || item.description || '',
      }
    }

    /** 内置浏览器打开；不可用时把原因交给调用方显示。 */
    function openInBrowser(ctx, url) {
      try {
        if (!url) return '没有可用地址'
        if (!ctx.sidebarRight || typeof ctx.sidebarRight.openTab !== 'function') {
          return '当前环境没有 sidebarRight 服务，无法在内置浏览器打开'
        }
        ctx.sidebarRight.openTab('browser', { params: { url: url } })
        return ''
      } catch (error) {
        return String((error && error.message) || error)
      }
    }

    /** client 半的 ctx 持有者：正文组件通过它拿到 sidebarRight。 */
    var clientCtxHolder = { ctx: null }

    /** 工作台正文。 */
    function Workbench(props) {
      // 优先使用「绑定到本 tab Session」的导航入口：tab.actions.openTab。
      // 模块级 ctx.sidebarRight.openTab 作用于在屏 Session，无在屏会话会抛错。
      var tabActions = null
      try {
        if (props && typeof props.useTabInfo === 'function') {
          var info = props.useTabInfo()
          tabActions = info && info.tab ? info.tab.actions : null
        }
      } catch (error) {
        tabActions = null
      }

      /** 在内置浏览器打开：先试 tab 绑定入口，再退回模块级 ctx。 */
      function openBrowser(url) {
        if (!url) return '没有可用地址'
        if (tabActions && typeof tabActions.openTab === 'function') {
          try {
            tabActions.openTab('browser', { params: { url: url } })
            return ''
          } catch (error) {
            /* 落到下面的兜底 */
          }
        }
        return openInBrowser(clientCtxHolder.ctx, url)
      }

      var statusState = useState({ loading: true })
      var status = statusState[0]
      var setStatus = statusState[1]

      var appsState = useState({ loading: true, error: '', items: [] })
      var apps = appsState[0]
      var setApps = appsState[1]

      var formsState = useState({})
      var formsByApp = formsState[0]
      var setFormsByApp = formsState[1]

      var expandedState = useState({})
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]

      var noticeState = useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var manualState = useState('')
      var manualUrl = manualState[0]
      var setManualUrl = manualState[1]

      // 应用口径：admin=我是管理员的应用（不限创建者），all=我能访问的全部应用。
      // 不要用 CLI 的 app-list —— 它硬编码 creator=我，别人建的应用永远列不出来。
      var scopeState = useState('admin')
      var scope = scopeState[0]
      var setScope = scopeState[1]

      // 登录/登出：登录流程 = 拿到钉钉授权 URL → 交给 DSH 内置浏览器 → 轮询登录态
      var loginState = useState({ busy: false })
      var login = loginState[0]
      var setLogin = loginState[1]

      var refreshStatus = useCallback(async () => {
        setStatus({ loading: true })
        var payload = await getJson('/status')
        setStatus({ loading: false, ...payload })
      }, [])

      var refreshApps = useCallback(async (nextScope) => {
        var useScope = nextScope === 'all' ? 'all' : 'admin'
        setApps({ loading: true, error: '', items: [], total: 0 })
        var payload = await getJson('/apps?scope=' + useScope + '&size=50')
        if (payload && payload.ok) {
          setApps({
            loading: false,
            error: '',
            items: asList(payload.data),
            total: payload.totalCount || asList(payload.data).length,
            baseUrl: payload.baseUrl,
          })
        } else {
          setApps({ loading: false, error: (payload && payload.error) || '读取失败', items: [], total: 0 })
        }
      }, [])

      var loadForms = useCallback(async (appType) => {
        setFormsByApp((prev) => Object.assign({}, prev, { [appType]: { loading: true } }))
        var payload = await getJson('/forms?appType=' + encodeURIComponent(appType))
        var items = payload && payload.ok ? asList(payload.data) : []
        setFormsByApp((prev) =>
          Object.assign({}, prev, {
            [appType]: { loading: false, items: items, error: payload && payload.ok ? '' : (payload && payload.error) || '读取失败' },
          }),
        )
      }, [])

      useEffect(() => {
        refreshStatus()
        refreshApps(scope)
      }, [refreshStatus, refreshApps])

      // 轮询 Host 侧的打开请求：模型调用 yida_urls { open: true } 后在这里落地。
      useEffect(() => {
        var stopped = false
        var timer = setInterval(async () => {
          if (stopped) return
          var payload = await getJson('/pending')
          if (stopped || !payload || !payload.ok || !Array.isArray(payload.items)) return
          for (var item of payload.items) {
            var failure = openInBrowser(clientCtxHolder.ctx, item.url)
            setNotice(failure ? '打开失败：' + failure : '已在右侧浏览器打开 ' + item.url)
          }
        }, POLL_MS)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [])

      /** 登录：拿到钉钉授权 URL → 交给 DSH 内置浏览器 → 轮询登录态（最多 5 分钟）。 */
      async function doLogin() {
        if (login.busy) return
        setLogin({ busy: true })
        setNotice('正在启动登录、获取钉钉授权链接…')
        try {
          var payload = await postJson('/login/start')
          if (!payload || payload.ok !== true) {
            setNotice('登录启动失败：' + ((payload && payload.error) || '未知错误'))
            return
          }
          var failure = openBrowser(payload.url)
          if (failure) {
            setNotice('已拿到授权链接但打开失败：' + failure + '（链接：' + payload.url + '）')
            return
          }
          setNotice('已用 DSH 内置浏览器打开钉钉授权页，请在里面完成授权…')
          var deadline = Date.now() + 5 * 60 * 1000
          while (Date.now() < deadline) {
            await sleep(2000)
            var state = await getJson('/login/state')
            if (state && state.loginStatus === 'ok') {
              setNotice('登录成功 ✅')
              refreshStatus()
              refreshApps(scope)
              return
            }
            if (state && state.running === false && state.exitCode !== undefined && state.exitCode !== 0) {
              setNotice('登录未完成（授权进程退出码 ' + state.exitCode + '），可以重试')
              return
            }
          }
          setNotice('等待授权超时（5 分钟）。请重试，或检查内置浏览器里的授权页是否已完成。')
        } finally {
          setLogin({ busy: false })
        }
      }

      /** 登出：清空本地登录态。 */
      async function doLogout() {
        if (login.busy) return
        setLogin({ busy: true })
        setNotice('正在退出登录…')
        try {
          var payload = await postJson('/logout')
          setNotice(payload && payload.ok ? '已退出登录' : '登出失败：' + ((payload && payload.error) || '未知错误'))
          refreshStatus()
        } finally {
          setLogin({ busy: false })
        }
      }

      function openApp(appType, target, formUuid) {        getJson(
          '/urls?appType=' + encodeURIComponent(appType) + (formUuid ? '&formUuid=' + encodeURIComponent(formUuid) : ''),
        ).then((payload) => {
          if (!payload || !payload.ok) {
            setNotice('取地址失败：' + ((payload && payload.error) || '未知错误'))
            return
          }
          var url = target === 'admin' ? payload.adminUrl : target === 'page' ? payload.pageUrl : payload.workbenchUrl
          var failure = openBrowser(url)
          setNotice(failure ? '打开失败：' + failure : '已打开 ' + url)
        })
      }

      function toggleApp(appType) {
        var next = !expanded[appType]
        setExpanded(Object.assign({}, expanded, { [appType]: next }))
        if (next && !formsByApp[appType]) loadForms(appType)
      }

      var loginBadge = status.loading
        ? { text: '检查中…', color: C.dim }
        : status.loginStatus === 'logged_in'
          ? { text: '已登录', color: C.ok }
          : { text: status.loginStatus || '未登录', color: C.danger }

      return h(
        'div',
        { style: wrap },
        h(
          'div',
          { style: bar },
          h('span', { style: { fontWeight: 600 } }, '宜搭工作台'),
          h('span', { style: { color: loginBadge.color } }, '● ' + loginBadge.text),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'button',
            {
              style: scope === 'admin' ? primary : btn,
              title: '只列我是管理员的应用（不限创建者）',
              onClick: () => {
                setScope('admin')
                refreshApps('admin')
              },
            },
            '我管理的',
          ),
          h(
            'button',
            {
              style: scope === 'all' ? primary : btn,
              title: '列出我能访问的全部应用',
              onClick: () => {
                setScope('all')
                refreshApps('all')
              },
            },
            '我能访问',
          ),
          h(
            'button',
            {
              style: login.busy ? btn : primary,
              disabled: login.busy,
              title: '用 DSH 内置浏览器完成钉钉授权（不依赖浏览器代理）',
              onClick: doLogin,
            },
            login.busy ? '登录中…' : '登录',
          ),
          h(
            'button',
            {
              style: btn,
              disabled: login.busy,
              title: '清空本地宜搭登录态',
              onClick: doLogout,
            },
            '登出',
          ),
          h('button', { style: btn, onClick: () => { refreshStatus(); refreshApps(scope) } }, '刷新'),
        ),

        h(
          'div',
          { style: scroll },
          status.nextStep
            ? h('div', { style: { color: C.dim, marginBottom: 8 } }, '提示：' + status.nextStep)
            : null,
          status.cli ? h('div', { style: { color: C.dim, marginBottom: 8 } }, 'CLI：' + status.cli) : null,

          h(
            'div',
            { style: Object.assign({}, row, { display: 'flex', gap: 6 }) },
            h('input', {
              style: input,
              placeholder: '粘贴宜搭地址，在内置浏览器打开',
              value: manualUrl,
              onChange: (event) => setManualUrl(event.target.value),
            }),
            h(
              'button',
              {
                style: primary,
                onClick: () => {
                  var failure = openBrowser(manualUrl)
                  setNotice(failure ? '打开失败：' + failure : '已打开 ' + manualUrl)
                },
              },
              '打开',
            ),
          ),

          notice ? h('div', { style: { color: C.dim, margin: '4px 0 8px' } }, notice) : null,

          apps.loading ? h('div', { style: { color: C.dim } }, '读取应用列表…') : null,
          apps.error ? h('div', { style: { color: C.danger, marginBottom: 8 } }, apps.error) : null,
          !apps.loading && !apps.error && apps.items.length === 0
            ? h(
                'div',
                { style: { color: C.dim } },
                scope === 'admin'
                  ? '没有读到「我管理的」应用。若应用不是你创建的，点上面的「我能访问」再看；也可能是还没登录（终端执行 openyida login）。'
                  : '没有读到可访问的应用。请确认已完成 openyida login，且当前组织选对了。',
              )
            : null,
          apps.total > apps.items.length
            ? h('div', { style: { color: C.dim, margin: '0 0 8px' } }, `共 ${apps.total} 个，仅显示前 ${apps.items.length} 个`)
            : null,

          apps.items.map((raw) => {
            var info = appFields(raw)
            var appType = info.appType
            var formState = formsByApp[appType]
            var isOpen = !!expanded[appType]
            return h(
              'div',
              { key: appType, style: row },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('span', { style: { fontWeight: 600 } }, info.name || appType),
                h('span', { style: { color: C.dim } }, appType),
                h('span', { style: { flex: '1 1 auto' } }),
                h('button', { style: btn, onClick: () => openApp(appType, 'workbench') }, '打开'),
                h('button', { style: btn, onClick: () => openApp(appType, 'admin') }, '管理台'),
                h('button', { style: btn, onClick: () => toggleApp(appType) }, isOpen ? '收起' : '表单'),
              ),
              info.desc ? h('div', { style: { color: C.dim, marginTop: 4 } }, info.desc) : null,
              isOpen
                ? h(
                    'div',
                    { style: { marginTop: 6 } },
                    formState && formState.loading ? h('div', { style: { color: C.dim } }, '读取表单…') : null,
                    formState && formState.error ? h('div', { style: { color: C.danger } }, formState.error) : null,
                    (formState && formState.items ? formState.items : []).map((form) => {
                      var formUuid = form.formUuid || form.uuid || form.id || ''
                      var title = form.title || form.name || form.formName || formUuid
                      return h(
                        'div',
                        { key: formUuid, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' } },
                        h('span', null, title),
                        h('span', { style: { color: C.dim } }, formUuid),
                        h('span', { style: { flex: '1 1 auto' } }),
                        h('button', { style: btn, onClick: () => openApp(appType, 'page', formUuid) }, '打开'),
                      )
                    }),
                  )
                : null,
            )
          }),
        ),
      )
    }

    /**
     * 插件入口。
     * @param {object} ctx - 浏览器侧上下文（已注入 slots / sidebarRightTabs / sidebarRight）。
     */
    function apply(ctx) {
      clientCtxHolder.ctx = ctx
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            title: () => '宜搭工作台',
            keepMounted: true,
            guide: [
              {
                id: 'workbench',
                // 注意：guide 条目的 title / description 必须是函数（注册表按 entry.title() 调用），
                // 写成字符串会在 guide 卡片渲染时抛 "entry.title is not a function"。
                order: 10,
                title: () => '宜搭工作台',
                description: () => 'AI 辅助创建/编辑宜搭应用，并在内置浏览器里查看',
              },
            ],
          }),
        'dsh-desktop-yida: tab type',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Workbench),
          ),
        'dsh-desktop-yida: tab body',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
