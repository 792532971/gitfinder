/**
 * 把 Vue 的响应式对象（Proxy）转成可跨 contextBridge 传递的纯数据。
 *
 * contextBridge 暴露的接口在跨渲染世界传参时走结构化克隆，而结构化克隆
 * 不认识 Proxy —— 直接把 `ref(...)` 的 `.value` 或 `reactive({...})` 传进去，
 * 会抛 "An object could not be cloned."，而且报错点离真正的成因很远
 * （表现为「保存失败」这种业务文案），很难查。
 *
 * 规则：
 * - 函数原样返回：events 里的订阅回调必须传引用，拷贝会丢
 * - Date / ArrayBuffer / TypedArray 本身就能结构化克隆，原样返回
 * - 其余对象和数组递归展开，只留下普通键值
 *
 * 不用 JSON.parse(JSON.stringify()) 是因为它会丢掉值为 undefined 的键，
 * 那会让部分更新变成「保持原值」，反而不符合调用方意图。
 */
export function toCloneable<T>(value: T): T {
  if (typeof value === 'function') return value
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => toCloneable(item)) as unknown as T
  }
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src)) {
    out[key] = toCloneable(src[key])
  }
  return out as T
}
