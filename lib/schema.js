/**
 * 零依赖的工具与配置构造器。
 *
 * 这里复刻 `@deepseek-ai/dsh-tools` 的 `defineTool` 作者 DSL：插件安装到 profile 后，
 * `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 都不从 profile 的 node_modules
 * 解析（它们被打包在 DSH 应用内），因此插件必须自带这套最小实现。
 *
 * 产出的 `ToolDefinition` 与官方 `defineTool` 完全同形：
 * `{ name, description, parameters, output: { schema, render }, execute }`。
 *
 * @module dsh-sticker/schema
 */

/** 作者节点允许的注解字段。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/** 简单类型集合。 */
const PRIMITIVE_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

/** 抛出作者写法错误。 */
function authorError(message) {
  throw new Error(`dsh-sticker schema: ${message}`)
}

/** 复制注解字段（不含 `required`）。 */
function copyAnnotations(source, target) {
  for (const key of ANNOTATION_KEYS) if (Object.hasOwn(source, key)) target[key] = source[key]
}

/** 拒绝作者节点里 DSL 不支持的键。 */
function assertAuthorKeys(source, path, allowed, allowRequired) {
  for (const key of Object.keys(source)) {
    if (key === 'required' && allowRequired) continue
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

/**
 * 把一个作者节点编译成原始 JSON Schema。
 * @param {object} input - 作者写的 schema 节点。
 * @param {string} path - 诊断路径。
 * @param {boolean} allowRequired - 是否允许 `required`（仅对象属性层）。
 * @returns {object} 编译后的原始 schema 节点。
 */
function compileNode(input, path, allowRequired) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) authorError(`${path} must be a value schema object`)
  if (Object.hasOwn(input, 'oneOf')) {
    assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'oneOf', 'type'], allowRequired)
    if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) authorError(`${path}.oneOf must be an array of at least two value schemas`)
    const node = { oneOf: input.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`, false)) }
    copyAnnotations(input, node)
    return node
  }
  const type = Object.hasOwn(input, 'type') ? input.type : undefined
  if (type === 'json') {
    assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'type'], allowRequired)
    const node = {}
    copyAnnotations(input, node)
    return node
  }
  if (type === 'object') {
    assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'type', 'properties', 'additionalProperties'], allowRequired)
    if (typeof input.additionalProperties !== 'boolean') authorError(`${path}.additionalProperties must be explicitly true or false`)
    const node = { type: 'object', additionalProperties: input.additionalProperties }
    copyAnnotations(input, node)
    if (Object.hasOwn(input, 'properties')) {
      const compiled = compilePropertyMap(input.properties, `${path}.properties`)
      node.properties = compiled.properties
      if (compiled.required !== undefined) node.required = compiled.required
    }
    return node
  }
  if (type === 'array') {
    assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'type', 'items'], allowRequired)
    const node = { type: 'array' }
    copyAnnotations(input, node)
    if (Object.hasOwn(input, 'items')) node.items = compileNode(input.items, `${path}.items`, false)
    return node
  }
  if (PRIMITIVE_TYPES.includes(type)) {
    assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'type', 'enum', 'const'], allowRequired)
    const node = { type }
    copyAnnotations(input, node)
    if (Object.hasOwn(input, 'enum')) {
      if (!Array.isArray(input.enum) || input.enum.length === 0) authorError(`${path}.enum must be a non-empty array`)
      node.enum = [...input.enum]
    }
    if (Object.hasOwn(input, 'const')) node.const = input.const
    return node
  }
  authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
  return {}
}

/**
 * 编译对象属性表，同时收集 required。
 * @param {object} spec - 属性名到作者节点的映射。
 * @param {string} path - 诊断路径。
 * @returns {{ properties: object, required?: string[] }} 编译结果。
 */
function compilePropertyMap(spec, path) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) authorError(`${path} must be an object of value schemas`)
  const properties = {}
  const required = []
  for (const [key, property] of Object.entries(spec)) {
    if (property !== null && typeof property === 'object' && Object.hasOwn(property, 'required')) {
      if (property.required !== true) authorError(`${path}.${key}.required must be true when present`)
      required.push(key)
    }
    properties[key] = compileNode(property, `${path}.${key}`, true)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

/** 校验值是否是 lossless JSON。 */
function isJsonValue(value) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (type === 'object') return Object.values(value).every(isJsonValue)
  return false
}

/**
 * 按原始 JSON Schema 校验一个值（支持本插件用到的子集）。
 * @param {object} schema - 编译后的 schema。
 * @param {unknown} value - 待校验的值。
 * @param {string} path - 诊断路径。
 * @returns {string[]} 违规说明。
 */
export function validateValue(schema, value, path = 'value') {
  const violations = []
  if (!isJsonValue(value)) return [`"${path}" must be a lossless JSON value`]
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(branch => validateValue(branch, value, path).length === 0)
    if (matches.length !== 1) violations.push(`"${path}" must match exactly one of oneOf`)
    return violations
  }
  const type = schema.type
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`"${path}" must be an object`]
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`"${path}.${key}" is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`"${path}.${key}" is not allowed`)
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) violations.push(...validateValue(propertySchema, value[key], `${path}.${key}`))
    }
    return violations
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`"${path}" must be an array`]
    for (const [index, item] of value.entries()) {
      if (schema.items !== undefined) violations.push(...validateValue(schema.items, item, `${path}[${index}]`))
    }
    return violations
  }
  if (type !== undefined) {
    const matches = type === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : type === 'number'
        ? typeof value === 'number'
        : type === 'null'
          ? value === null
          : typeof value === type
    if (!matches) violations.push(`"${path}" must be a ${type}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`"${path}" must be one of ${JSON.stringify(schema.enum)}`)
  if (Object.hasOwn(schema, 'const') && value !== schema.const) violations.push(`"${path}" must be ${JSON.stringify(schema.const)}`)
  return violations
}

/**
 * 与 `@deepseek-ai/dsh-tools` 的 `defineTool` 同形的工具构造器。
 * @param {object} options - `{ name, description, parameters, output: { schema, render }, execute, isConcurrencySafe? }`。
 * @returns {object} 注册到 `ctx.tools.register` 的工具定义。
 */
export function defineTool(options) {
  const parameters = { type: 'object', ...compilePropertyMap(options.parameters ?? {}, 'parameters') }
  const outputSchema = compileNode(options.output.schema, 'schema', false)
  const render = options.output.render
  if (typeof render !== 'function') authorError(`${options.name}: output.render must be a function`)
  const execute = options.execute
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return render(args, value)
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, '')
      if (violations.length > 0) {
        const error = new Error(`invalid arguments: ${violations.map(item => item.replace(/^""/, '"arguments')).join('; ')}`)
        error.name = 'ToolArgsError'
        error.code = 'INVALID_ARGS'
        error.violations = violations
        throw error
      }
      const value = await execute(args, exec)
      const valueViolations = validateValue(outputSchema, value, 'value')
      if (valueViolations.length > 0) throw new Error(`${options.name}: output contract violation: ${valueViolations.join('; ')}`)
      return value
    },
  }
  if (typeof options.isConcurrencySafe === 'function') {
    const userIsConcurrencySafe = options.isConcurrencySafe
    tool.isConcurrencySafe = (args) => (validateValue(parameters, args, '').length > 0 ? false : userIsConcurrencySafe(args))
  }
  return tool
}

/** 一层配置描述：`describe({ field: { type, default, required } })`。 */
function describeFields(spec) {
  return (value) => {
    if (value === undefined || value === null) value = {}
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('dsh-sticker config must be an object')
    const out = {}
    for (const [key, field] of Object.entries(spec)) {
      let current = Object.hasOwn(value, key) ? value[key] : undefined
      if (current === undefined) current = typeof field.default === 'function' ? field.default() : field.default
      if (current === undefined) {
        if (field.required === true) throw new Error(`dsh-sticker config.${key} is required`)
        continue
      }
      out[key] = coerce(field, current, key)
    }
    for (const key of Object.keys(value)) if (!Object.hasOwn(spec, key)) out[key] = value[key]
    return out
  }
}

/** 按字段描述做轻量类型检查与归一化。 */
function coerce(field, value, key) {
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`dsh-sticker config.${key} must be a boolean`)
      return value
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`dsh-sticker config.${key} must be a number`)
      if (field.type === 'integer' && !Number.isInteger(value)) throw new Error(`dsh-sticker config.${key} must be an integer`)
      if (field.min !== undefined && value < field.min) throw new Error(`dsh-sticker config.${key} must be >= ${field.min}`)
      if (field.max !== undefined && value > field.max) throw new Error(`dsh-sticker config.${key} must be <= ${field.max}`)
      return value
    }
    case 'array': {
      if (!Array.isArray(value)) throw new Error(`dsh-sticker config.${key} must be an array`)
      const itemType = field.items ?? field.itemType
      if (itemType === 'string' || (itemType !== null && typeof itemType === 'object' && itemType.type === 'string')) {
        for (const item of value) if (typeof item !== 'string') throw new Error(`dsh-sticker config.${key} items must be strings`)
      }
      return [...value]
    }
    case 'string':
      if (typeof value !== 'string') throw new Error(`dsh-sticker config.${key} must be a string`)
      return value
    default:
      return value
  }
}

/**
 * 构造一个 Cordis 能识别的 Config 模式。
 *
 * Cordis 只要求 `Config["~standard"] = { vendor, version, validate }`；插件加载器还会读
 * `schema.meta.volatile` 与 `schema.type`/`schema.meta.default`。同时导出的 `spec` 让工具层的
 * 字段描述复用配置定义，避免文档漂移。
 *
 * @param {object} spec - 字段描述表。
 * @returns {object} 带 `~standard` 与 `meta` 的配置模式。
 */
export function defineConfig(spec) {
  const validateSync = describeFields(spec)
  const schema = {
    type: 'object',
    meta: {
      default: validateSync(undefined),
      volatile: false,
    },
    spec,
    '~standard': {
      version: 1,
      vendor: 'schemastery',
      validate(value) {
        try {
          return { value: validateSync(value) }
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error), path: [] }] }
        }
      },
    },
    validate(value) {
      return validateSync(value)
    },
  }
  // 投影一份 JSON Schema：设置面板与 `cordis_inspect_query` 的 Config 视图靠它渲染表单，
  // 只有 `~standard` 时面板会显示 unsupported。
  schema['~standard'].jsonSchema = {
    input: () => jsonSchemaOf(spec),
    output: () => jsonSchemaOf(spec),
  }
  return schema
}

/**
 * 把字段描述表投影成 JSON Schema（只覆盖本插件用到的类型）。
 * @param {object} spec - 字段描述表。
 * @returns {object} JSON Schema。
 */
function jsonSchemaOf(spec) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(spec)) {
    const node = {}
    switch (field.type) {
      case 'boolean':
        node.type = 'boolean'
        break
      case 'integer':
        node.type = 'integer'
        break
      case 'number':
        node.type = 'number'
        break
      case 'array':
        node.type = 'array'
        node.items = { type: 'string' }
        break
      default:
        node.type = 'string'
        break
    }
    if (field.default !== undefined) node.default = typeof field.default === 'function' ? field.default() : field.default
    if (field.min !== undefined) node.minimum = field.min
    if (field.max !== undefined) node.maximum = field.max
    if (field.description !== undefined) node.description = field.description
    properties[key] = node
    if (field.required === true) required.push(key)
  }
  const schema = { type: 'object', properties, additionalProperties: true }
  if (required.length > 0) schema.required = required
  return schema
}
