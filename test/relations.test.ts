import assert from 'node:assert'
import {
  auditRelationCardinality,
  buildRelationViews,
  isSelfRelation,
  normalizeCardinalityLimit,
  normalizeRelationCardinalityRules,
  normalizeRelations,
  relationKey,
  relationStats,
  relationTypeFilters,
  sortRelationViews,
  RELATION_CARDINALITY_VIOLATION_LABEL,
  RELATION_INVALID_REASON_LABEL,
} from '../src/lib/relations'
import type { Annotation, AnnotationRelation, RelationCardinalityRule } from '../src/types'

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

// 8. 基数上限值清洗
check('上限清洗：仅 ≥1 的有限整数保留，其余按 null（不限）；小数向下取整', () => {
  assert.strictEqual(normalizeCardinalityLimit(1), 1)
  assert.strictEqual(normalizeCardinalityLimit(3), 3)
  assert.strictEqual(normalizeCardinalityLimit(2.9), 2)
  assert.strictEqual(normalizeCardinalityLimit('5'), 5)
  assert.strictEqual(normalizeCardinalityLimit(' 7 '), 7)
  assert.strictEqual(normalizeCardinalityLimit(0), null)
  assert.strictEqual(normalizeCardinalityLimit(-2), null)
  assert.strictEqual(normalizeCardinalityLimit('abc'), null)
  assert.strictEqual(normalizeCardinalityLimit(''), null)
  assert.strictEqual(normalizeCardinalityLimit(null), null)
  assert.strictEqual(normalizeCardinalityLimit(undefined), null)
  assert.strictEqual(normalizeCardinalityLimit(Infinity), null)
})

// 9. 基数规则清洗
check('基数规则清洗：非数组 / 旧版缺省按空', () => {
  assert.deepStrictEqual(normalizeRelationCardinalityRules(undefined), [])
  assert.deepStrictEqual(normalizeRelationCardinalityRules(null), [])
  assert.deepStrictEqual(normalizeRelationCardinalityRules('x'), [])
})

check('基数规则清洗：空类型、两侧均不限丢弃；非法上限按不限；同类型保留第一条', () => {
  const out = normalizeRelationCardinalityRules([
    { id: 'c1', type: ' 支撑 ', maxOut: 2, maxIn: 1, createdAt: 10 },
    { id: 'c2', type: '', maxOut: 1, maxIn: 1 },
    { id: 'c3', type: '反驳', maxOut: null, maxIn: null },
    { id: 'c4', type: '引用', maxOut: 0, maxIn: -3 },
    { id: 'c5', type: '引用', maxOut: '3', maxIn: '2.9', createdAt: '2026-09-18T00:00:00.000Z' },
    { id: 'c6', type: '支撑', maxOut: 9, maxIn: 9 }, // 同类型重复 → 丢弃
    { id: 'c7', type: '属于 论据', maxOut: 4, maxIn: null },
    null,
  ])
  assert.deepStrictEqual(
    out.map((r) => [r.type, r.maxOut, r.maxIn]),
    [
      ['支撑', 2, 1],
      ['引用', 3, 2],
      ['属于 论据', 4, null],
    ],
  )
  assert.strictEqual(out[0].id, 'c1', '已保存规则沿用稳定 ID')
  assert.strictEqual(out[1].createdAt, Date.parse('2026-09-18T00:00:00.000Z'))
})

// 10. 审计：无规则 / 无有效关系
check('审计：未配置规则时 configured=false 且无违规', () => {
  const ans = [ann('a'), ann('b')]
  const audit = auditRelationCardinality(buildRelationViews([rel('a', 'b')], ans), [])
  assert.strictEqual(audit.configured, false)
  assert.strictEqual(audit.violationCount, 0)
  assert.deepStrictEqual(audit.violations, [])
})

check('审计：配置了规则但当前无有效关系（仅失效）→ configured=true 且无违规', () => {
  const ans = [ann('a', 'pending'), ann('b')]
  const views = buildRelationViews([rel('a', 'b')], ans)
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '支撑', maxOut: 1, maxIn: 1, createdAt: 1 },
  ]
  const audit = auditRelationCardinality(views, rules)
  assert.strictEqual(audit.configured, true)
  assert.strictEqual(audit.violationCount, 0)
})

// 11. 审计：源端出边 / 目标端入边超限，按创建时间保留较早的名额
check('审计：源端 maxOut=2 → 第 3 条（创建最晚）源端超限；其余合规', () => {
  const ans = [ann('a'), ann('b'), ann('c'), ann('d')]
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '支撑', maxOut: 2, maxIn: null, createdAt: 1 },
  ]
  const views = buildRelationViews(
    [
      rel('a', 'b', '支撑', 10, 'r_ab'),
      rel('a', 'c', '支撑', 30, 'r_ac'),
      rel('a', 'd', '支撑', 20, 'r_ad'),
    ],
    ans,
  )
  const audit = auditRelationCardinality(views, rules)
  assert.strictEqual(audit.violationCount, 1)
  const v = audit.violations[0]!
  assert.strictEqual(v.relationId, 'r_ac', '创建时间最晚的关系超限')
  assert.strictEqual(v.kind, 'source')
  assert.strictEqual(v.sourceCount, 3)
  assert.strictEqual(v.sourceLimit, 2)
  assert.strictEqual(v.targetCount, null)
  assert.strictEqual(v.targetLimit, null)
  assert.strictEqual(audit.byRelationId.get('r_ac'), v)
  assert.strictEqual(audit.byRelationId.has('r_ab'), false)
})

check('审计：目标端 maxIn=1 → 同目标的第 2 条入边目标端超限', () => {
  const ans = [ann('a'), ann('b'), ann('c')]
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '支撑', maxOut: null, maxIn: 1, createdAt: 1 },
  ]
  const views = buildRelationViews(
    [
      rel('b', 'c', '支撑', 20, 'r_bc'),
      rel('a', 'c', '支撑', 10, 'r_ac'),
    ],
    ans,
  )
  const audit = auditRelationCardinality(views, rules)
  assert.strictEqual(audit.violationCount, 1)
  const v = audit.violations[0]!
  assert.strictEqual(v.relationId, 'r_bc')
  assert.strictEqual(v.kind, 'target')
  assert.strictEqual(v.targetCount, 2)
  assert.strictEqual(v.targetLimit, 1)
  assert.strictEqual(v.sourceCount, null)
})

// 12. 同一关系两端兼有
check('审计：同一条关系同时超出源端与目标端名额 → kind=both 且两端计数齐全', () => {
  const ans = [ann('a'), ann('b'), ann('c'), ann('d')]
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '引用', maxOut: 1, maxIn: 1, createdAt: 1 },
  ]
  const views = buildRelationViews(
    [
      rel('d', 'c', '引用', 5, 'r_dc'), // c 的第 1 条入边（占名额）
      rel('a', 'b', '引用', 10, 'r_ab'), // a 的第 1 条出边（占名额）
      rel('a', 'c', '引用', 20, 'r_ac'), // a 的第 2 条出边 + c 的第 2 条入边 → both
    ],
    ans,
  )
  const audit = auditRelationCardinality(views, rules)
  assert.strictEqual(audit.violationCount, 1)
  const v = audit.violations[0]!
  assert.strictEqual(v.relationId, 'r_ac')
  assert.strictEqual(v.kind, 'both')
  assert.strictEqual(v.sourceCount, 2)
  assert.strictEqual(v.sourceLimit, 1)
  assert.strictEqual(v.targetCount, 2)
  assert.strictEqual(v.targetLimit, 1)
})

// 13. 稳定排序：创建时间相同时按关系 ID 决胜
check('审计：创建时间相同 → 关系 ID 字典序靠后者超限', () => {
  const ans = [ann('a'), ann('b'), ann('c')]
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '支撑', maxOut: 1, maxIn: null, createdAt: 1 },
  ]
  const views = buildRelationViews(
    [
      rel('a', 'b', '支撑', 10, 'rel_z'),
      rel('a', 'c', '支撑', 10, 'rel_a'),
    ],
    ans,
  )
  const audit = auditRelationCardinality(views, rules)
  assert.deepStrictEqual(audit.violations.map((v) => v.relationId), ['rel_z'])
})

check('审计：违规列表按创建时间、再按关系 ID 稳定排序', () => {
  const ans = [ann('a'), ann('b'), ann('c'), ann('d'), ann('e')]
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '支撑', maxOut: 1, maxIn: null, createdAt: 1 },
  ]
  const views = buildRelationViews(
    [
      rel('a', 'b', '支撑', 30, 'v3'),
      rel('a', 'c', '支撑', 10, 'v1'),
      rel('d', 'e', '支撑', 20, 'v2'),
      rel('d', 'b', '支撑', 10, 'v1b'),
    ],
    ans,
  )
  // a 的出边：v1(t10) 合规、v3(t30) 超限；d 的出边：v1b(t10,id=v1b) 合规、v2(t20) 超限
  const audit = auditRelationCardinality(views, rules)
  assert.deepStrictEqual(
    audit.violations.map((v) => v.relationId),
    ['v2', 'v3'],
  )
})

// 14. 类型隔离 / 失效不占名额 / 仅配置一侧
check('审计：不同类型互不影响；失效关系不占用名额', () => {
  const ans = [ann('a'), ann('b'), ann('c', 'pending')]
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '支撑', maxOut: 1, maxIn: 1, createdAt: 1 },
  ]
  const views = buildRelationViews(
    [
      rel('a', 'b', '支撑', 1, 'ok1'), // 占 a 出边 / b 入边名额
      rel('a', 'c', '支撑', 2, 'bad_pending'), // 目标待处理 → 失效，不占 a 的出边名额
      rel('a', 'b', '反驳', 3, 'other_type'), // 不同类型，即使完全重复也不参与
    ],
    ans,
  )
  const audit = auditRelationCardinality(views, rules)
  assert.strictEqual(audit.violationCount, 0)
})

check('审计：只配一侧时另一侧不受限制', () => {
  const ans = [ann('a'), ann('b'), ann('c'), ann('d')]
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '支撑', maxOut: 1, maxIn: null, createdAt: 1 },
  ]
  const views = buildRelationViews(
    [
      rel('a', 'b', '支撑', 1, 'x1'),
      rel('c', 'b', '支撑', 2, 'x2'),
      rel('d', 'b', '支撑', 3, 'x3'),
    ],
    ans,
  )
  // b 有 3 条入边但未配 maxIn → 全部合规；a/c/d 各自只有 1 条出边 → 无违规
  assert.strictEqual(auditRelationCardinality(views, rules).violationCount, 0)
})

check('审计：超限方向标签齐全', () => {
  for (const kind of ['source', 'target', 'both'] as const) {
    assert.ok(RELATION_CARDINALITY_VIOLATION_LABEL[kind].length > 0)
  }
})

check('审计：不修改输入的关系视图与规则', () => {
  const ans = [ann('a'), ann('b'), ann('c')]
  const views = buildRelationViews(
    [rel('a', 'b', '支撑', 1, 'x1'), rel('a', 'c', '支撑', 2, 'x2')],
    ans,
  )
  const rules: RelationCardinalityRule[] = [
    { id: 'r1', type: '支撑', maxOut: 1, maxIn: 1, createdAt: 1 },
  ]
  const snapshot = JSON.stringify({ views, rules })
  auditRelationCardinality(views, rules)
  assert.strictEqual(JSON.stringify({ views, rules }), snapshot)
})

console.log(`\n标注关系逻辑测试全部通过（${passed} 项）`)
