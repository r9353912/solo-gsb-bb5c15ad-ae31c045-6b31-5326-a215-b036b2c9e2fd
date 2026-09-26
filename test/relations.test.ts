import assert from 'node:assert'
import {
  buildRelationViews,
  isSelfRelation,
  normalizeRelations,
  relationKey,
  relationStats,
  relationTypeFilters,
  sortRelationViews,
  RELATION_INVALID_REASON_LABEL,
} from '../src/lib/relations'
import type { Annotation, AnnotationRelation } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  id: string,
  status: Annotation['status'] = 'bound',
  start = 0,
): Annotation {
  seq += 1
  return {
    id,
    quote: `引文-${id}`,
    start,
    end: start + 2,
    note: '',
    tags: [],
    status,
    createdAt: seq,
    updatedAt: seq,
    contextBefore: '',
    contextAfter: '',
  }
}

function rel(
  sourceId: string,
  targetId: string,
  type = '支撑',
  createdAt = 1,
  id?: string,
): AnnotationRelation {
  return { id: id ?? `rel_${sourceId}_${targetId}_${type}`, sourceId, targetId, type, createdAt }
}

// 1. 约束判定：自关联键与完全重复键
check('自关联判定', () => {
  assert.strictEqual(isSelfRelation('a', 'a'), true)
  assert.strictEqual(isSelfRelation('a', 'b'), false)
  assert.strictEqual(isSelfRelation('', ''), false)
})

check('完全重复键方向敏感：A→B 与 B→A 不是重复', () => {
  assert.strictEqual(relationKey('a', 'b', '支撑'), relationKey('a', 'b', '支撑'))
  assert.notStrictEqual(relationKey('a', 'b', '支撑'), relationKey('b', 'a', '支撑'))
  assert.notStrictEqual(relationKey('a', 'b', '支撑'), relationKey('a', 'b', '反驳'))
})

// 2. normalizeRelations：旧版缺省 / 非法输入按空；丢弃自关联与缺字段；完全重复保留最早一条
check('清洗：非数组 / null / 旧版缺省按空数组', () => {
  assert.deepStrictEqual(normalizeRelations(undefined), [])
  assert.deepStrictEqual(normalizeRelations(null), [])
  assert.deepStrictEqual(normalizeRelations('x'), [])
  assert.deepStrictEqual(normalizeRelations({}), [])
})

check('清洗：自关联与字段缺失丢弃；类型去首尾空白；时间字符串解析', () => {
  const out = normalizeRelations([
    { id: 'r1', sourceId: 'a', targetId: 'a', type: '自环', createdAt: 1 },
    { sourceId: 'a', targetId: 'b', type: '支撑', createdAt: '2026-09-18T00:00:00.000Z' },
    { sourceId: 'a', targetId: '', type: '支撑' },
    { sourceId: 'a', targetId: 'b', type: '   ' },
    null,
    { sourceId: 2 as unknown as string, targetId: 'b', type: '支撑' },
  ])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].sourceId, 'a')
  assert.strictEqual(out[0].targetId, 'b')
  assert.strictEqual(out[0].type, '支撑')
  assert.strictEqual(out[0].createdAt, Date.parse('2026-09-18T00:00:00.000Z'))
})

check('清洗：完全重复（源+目标+类型）只保留第一条；反向关系保留；不同类型保留', () => {
  const out = normalizeRelations([
    rel('a', 'b', '支撑', 10, 'r1'),
    rel('a', 'b', '支撑', 5, 'r2'), // 完全重复 → 丢弃
    rel('b', 'a', '支撑', 5, 'r3'), // 反向 → 保留
    rel('a', 'b', '反驳', 5, 'r4'), // 不同类型 → 保留
  ])
  assert.deepStrictEqual(out.map((r) => r.id), ['r1', 'r3', 'r4'])
})

// 3. 有效性派生：两端存在且已绑定才有效；删除 / pending 标原因；重绑恢复
check('派生视图：两端已绑定 → 有效', () => {
  const ans = [ann('a'), ann('b')]
  const views = buildRelationViews([rel('a', 'b')], ans)
  assert.strictEqual(views.length, 1)
  assert.strictEqual(views[0].active, true)
  assert.strictEqual(views[0].invalidReason, null)
  assert.strictEqual(views[0].source?.id, 'a')
  assert.strictEqual(views[0].target?.id, 'b')
})

check('派生视图：源/目标进入待处理 → 对应失效原因', () => {
  const ans = [ann('a', 'pending'), ann('b')]
  const views = buildRelationViews([rel('a', 'b'), rel('b', 'a')], ans)
  assert.strictEqual(views[0].active, false)
  assert.strictEqual(views[0].invalidReason, 'source-pending')
  assert.strictEqual(views[1].active, false)
  assert.strictEqual(views[1].invalidReason, 'target-pending')
  const both = buildRelationViews([rel('a', 'b')], [ann('a', 'pending'), ann('b', 'pending')])
  assert.strictEqual(both[0].invalidReason, 'both-pending')
})

check('派生视图：源/目标被删除（标注不存在）→ missing；两端都删 → both-missing', () => {
  const one = buildRelationViews([rel('a', 'b'), rel('a', 'c')], [ann('b')])
  assert.strictEqual(one[0].invalidReason, 'source-missing')
  assert.strictEqual(one[0].active, false)
  assert.strictEqual(one[1].invalidReason, 'both-missing')
  assert.strictEqual(one[1].source, null)
  assert.strictEqual(one[1].target, null)
})

check('重新绑定后自动恢复：同一份关系数据，pending → bound 后视图变为有效', () => {
  const relation = rel('a', 'b')
  const pendingViews = buildRelationViews([relation], [ann('a', 'pending'), ann('b')])
  assert.strictEqual(pendingViews[0].active, false)
  const reboundViews = buildRelationViews([relation], [ann('a', 'bound'), ann('b')])
  assert.strictEqual(reboundViews[0].active, true)
  assert.strictEqual(reboundViews[0].relation, relation, '关系记录本身不被修改')
})

// 4. 统计
check('统计：有效 / 失效 / 总数', () => {
  const ans = [ann('a'), ann('b', 'pending')]
  const views = buildRelationViews(
    [rel('a', 'b'), rel('b', 'a'), rel('x', 'a')],
    ans,
  )
  const stats = relationStats(views)
  assert.deepStrictEqual(stats, { total: 3, active: 0, invalid: 3 })
  const stats2 = relationStats(buildRelationViews([rel('a', 'b')], [ann('a'), ann('b')]))
  assert.deepStrictEqual(stats2, { total: 1, active: 1, invalid: 0 })
})

// 5. 排序：有效在前（源起点），失效在后（创建时间新→旧）
check('排序：有效在前按源起点，失效在后按创建时间', () => {
  const ans = [
    ann('a', 'bound', 10),
    ann('b', 'bound', 2),
    ann('p', 'pending', 0),
  ]
  const views = buildRelationViews(
    [
      rel('a', 'b', '支撑', 100, 'r_far'),
      rel('b', 'a', '支撑', 100, 'r_near'), // 源起点 2 更靠前
      rel('p', 'a', '支撑', 50, 'r_old_invalid'),
      rel('p', 'b', '反驳', 90, 'r_new_invalid'),
    ],
    ans,
  )
  const ids = sortRelationViews(views).map((v) => v.relation.id)
  assert.deepStrictEqual(ids, ['r_near', 'r_far', 'r_new_invalid', 'r_old_invalid'])
})

// 6. 类型筛选列表：按最早出现时间排序
check('类型筛选项：按该类型最早一条关系的创建时间排序', () => {
  const types = relationTypeFilters([
    rel('a', 'b', '晚出现', 30),
    rel('a', 'c', '早出现', 10),
    rel('a', 'd', '早出现', 40),
  ])
  assert.deepStrictEqual(types, ['早出现', '晚出现'])
  assert.deepStrictEqual(relationTypeFilters([]), [])
})

// 7. 失效原因标签齐全（报告与侧栏共用）
check('全部失效原因都有中文标签', () => {
  for (const reason of [
    'source-missing',
    'target-missing',
    'both-missing',
    'source-pending',
    'target-pending',
    'both-pending',
  ] as const) {
    assert.ok(RELATION_INVALID_REASON_LABEL[reason].length > 0)
  }
})

console.log(`\n标注关系逻辑测试全部通过（${passed} 项）`)
