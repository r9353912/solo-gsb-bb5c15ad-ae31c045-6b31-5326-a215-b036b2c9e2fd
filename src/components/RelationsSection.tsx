import { useEffect, useId, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { Annotation, RelationCardinalityRule } from '../types'
import { badgeColor } from '../lib/segments'
import {
  RELATION_CARDINALITY_VIOLATION_LABEL,
  RELATION_INVALID_REASON_LABEL,
  isSelfRelation,
  makeCardinalityRuleId,
  normalizeCardinalityLimit,
  normalizeRelationType,
  relationKey,
  relationTypeFilters,
  sortRelationViews,
  type RelationCardinalityAudit,
  type RelationCardinalityViolation,
  type RelationView,
} from '../lib/relations'

interface Props {
  annotations: Annotation[]
  views: RelationView[]
  /** 基数上限规则（按关系类型；空数组表示未配置审计） */
  cardinalityRules: RelationCardinalityRule[]
  /** 基数上限审计结果（由 App 派生，随关系增删 / 失效恢复 / 规则变化 / 导入实时重算） */
  cardinalityAudit: RelationCardinalityAudit
  activeId: string | null
  onCreate: (sourceId: string, targetId: string, type: string) => void
  onDelete: (id: string) => void
  /** 保存基数上限规则（整体替换；App 侧保存前再清洗一次） */
  onSaveCardinalityRules: (rules: RelationCardinalityRule[]) => void
  /** 点击有效关系的一端：在原文中定位（仅已绑定标注可调用） */
  onFocus: (a: Annotation) => void
  /** 点击失效关系上处于待处理的一端：进入重新绑定 */
  onRebindStart: (a: Annotation) => void
  /** 分区滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

const ALL_TYPES = '__all__'
/** 特殊筛选：只看基数超限的有效关系 */
const OVER_LIMIT = '__over__'

/** 下拉选项文案：引文摘录 + 区间 + 标签，长引文截断 */
function optionLabel(a: Annotation): string {
  const quote = (a.quote || '（空引文）').replace(/\s+/g, ' ')
  const shown = quote.length > 24 ? `${quote.slice(0, 24)}…` : quote
  const tags = a.tags.length > 0 ? ` #${a.tags.join(' #')}` : ''
  return `[${a.start},${a.end}) ${shown}${tags}`
}

/** 关系一端：可点击定位 / 重新绑定；标注已删除时显示占位 */
function RelationEnd({
  role,
  view,
  side,
  activeId,
  onFocus,
  onRebindStart,
}: {
  role: '源' | '目标'
  view: RelationView
  side: 'source' | 'target'
  activeId: string | null
} & Pick<Props, 'onFocus' | 'onRebindStart'>) {
  const a = side === 'source' ? view.source : view.target
  if (!a) {
    return (
      <span className="rel-end rel-end-missing" title="该标注已被删除">
        <span className="rel-end-role">{role}</span>
        <span className="rel-end-quote">（标注已删除）</span>
      </span>
    )
  }
  if (a.status === 'pending') {
    return (
      <button
        type="button"
        className="rel-end rel-end-pending"
        title="该标注处于待处理，点击进入重新选择片段；绑定后关系自动恢复"
        onClick={() => onRebindStart(a)}
      >
        <span className="rel-end-role">{role}</span>
        <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
        <span className="rel-end-quote">
          <em className="ann-pending-flag">[待绑定] </em>
          {a.quote || <span className="ann-empty-quote">（空引文）</span>}
        </span>
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`rel-end ${activeId === a.id ? 'rel-end-active' : ''}`}
      title="在原文中定位"
      onClick={() => onFocus(a)}
    >
      <span className="rel-end-role">{role}</span>
      <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
      <span className="rel-end-quote">{a.quote || <span className="ann-empty-quote">（空引文）</span>}</span>
      <span className="rel-end-pos">[{a.start},{a.end})</span>
    </button>
  )
}

function RelationCard({
  view,
  violation,
  activeId,
  onFocus,
  onRebindStart,
  onDelete,
}: {
  view: RelationView
  /** 基数超限记录（仅有效关系可能存在；无超限为 null） */
  violation: RelationCardinalityViolation | null
} & Pick<Props, 'activeId' | 'onFocus' | 'onRebindStart' | 'onDelete'>) {
  const capParts: string[] = []
  if (violation && violation.sourceLimit !== null) {
    capParts.push(`源端出边 ${violation.sourceCount}/${violation.sourceLimit}`)
  }
  if (violation && violation.targetLimit !== null) {
    capParts.push(`目标端入边 ${violation.targetCount}/${violation.targetLimit}`)
  }
  return (
    <div
      className={`rel-item ${view.active ? '' : 'rel-item-invalid'} ${
        violation ? 'rel-item-over' : ''
      }`}
    >
      <div className="rel-ends">
        <RelationEnd
          role="源"
          view={view}
          side="source"
          activeId={activeId}
          onFocus={onFocus}
          onRebindStart={onRebindStart}
        />
        <div className="rel-arrow">
          <span className="rel-type-pill">{view.relation.type}</span>
          <span className="rel-arrow-mark">→</span>
        </div>
        <RelationEnd
          role="目标"
          view={view}
          side="target"
          activeId={activeId}
          onFocus={onFocus}
          onRebindStart={onRebindStart}
        />
      </div>
      {view.active && violation && (
        <p
          className="rel-cap-flag"
          title={`基数上限审计（类型「${violation.rule.type}」）：同一端点同类型按创建时间（再按关系 ID）排序，该关系超出名额；仅提示，不阻止建立关系`}
        >
          {RELATION_CARDINALITY_VIOLATION_LABEL[violation.kind]}：{capParts.join('；')}
        </p>
      )}
      {!view.active && view.invalidReason && (
        <p className="rel-invalid-reason">
          已失效：{RELATION_INVALID_REASON_LABEL[view.invalidReason]}
          {view.invalidReason.endsWith('pending') ? '；重新绑定后自动恢复' : ''}
        </p>
      )}
      <div className="rel-item-actions">
        <span className="form-spacer" />
        <button
          type="button"
          className="btn btn-small btn-ghost btn-danger-text"
          onClick={() => {
            if (confirm('确定删除这条关系吗？（不会删除两端标注）')) onDelete(view.relation.id)
          }}
        >
          删除关系
        </button>
      </div>
    </div>
  )
}

/** 新建关系表单：选择源 / 目标（仅已绑定标注）+ 填写关系类型，禁止自关联与完全重复 */
function RelationCreateForm({
  boundAnnotations,
  existingKeys,
  existingTypes,
  onCreate,
}: {
  boundAnnotations: Annotation[]
  existingKeys: Set<string>
  existingTypes: string[]
  onCreate: Props['onCreate']
}) {
  const listId = useId()
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [type, setType] = useState('')

  const cleanType = normalizeRelationType(type)
  const self = isSelfRelation(sourceId, targetId)
  const duplicate =
    !!sourceId && !!targetId && !!cleanType && !self
      ? existingKeys.has(relationKey(sourceId, targetId, cleanType))
      : false
  const canSubmit = !!sourceId && !!targetId && !!cleanType && !self && !duplicate

  const submit = () => {
    if (!canSubmit) return
    onCreate(sourceId, targetId, cleanType)
    setSourceId('')
    setTargetId('')
    setType('')
  }

  if (boundAnnotations.length < 2) {
    return (
      <p className="side-hint">
        至少需要 <strong>2 条已绑定标注</strong>才能建立关系。先在原文中拖选添加标注；
        待处理标注重新绑定后即可作为关系端点。
      </p>
    )
  }

  return (
    <div className="rel-create">
      <div className="rel-create-row">
        <select
          className="rule-input rel-select"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
        >
          <option value="">选择源标注…</option>
          {boundAnnotations.map((a) => (
            <option key={a.id} value={a.id}>
              {optionLabel(a)}
            </option>
          ))}
        </select>
      </div>
      <div className="rel-create-row rel-create-mid">
        <input
          className="rule-input rel-type-input"
          value={type}
          list={listId}
          placeholder="关系类型，如：支撑 / 反驳 / 引用 / 属于"
          onChange={(e) => setType(e.target.value)}
        />
        <span className="rel-create-arrow" title="有向">
          →
        </span>
        <select
          className="rule-input rel-select"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        >
          <option value="">选择目标标注…</option>
          {boundAnnotations.map((a) => (
            <option key={a.id} value={a.id}>
              {optionLabel(a)}
            </option>
          ))}
        </select>
      </div>
      <datalist id={listId}>
        {existingTypes.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {(self || duplicate) && (
        <p className="rel-create-msg">
          {self ? '源标注与目标标注不能是同一条标注（禁止自关联）。' : '已存在完全相同的关系（源、目标、类型一致），请勿重复建立。'}
        </p>
      )}
      <div className="rel-create-actions">
        <span className="form-spacer" />
        <button type="button" className="btn btn-small btn-primary" disabled={!canSubmit} onClick={submit}>
          建立关系
        </button>
      </div>
    </div>
  )
}

/** 基数上限规则编辑器中的草稿行：上限输入保留原文（空串 = 不限），保存时统一清洗 */
interface RuleDraft {
  key: string
  /** 已保存规则的稳定 ID；新增行为 null */
  id: string | null
  type: string
  maxOut: string
  maxIn: string
  createdAt: number
}

let ruleDraftSeq = 0
function ruleDraftKey(): string {
  ruleDraftSeq += 1
  return `rcr_row_${Date.now().toString(36)}_${ruleDraftSeq}`
}

function ruleToDraft(r: RelationCardinalityRule): RuleDraft {
  return {
    key: ruleDraftKey(),
    id: r.id,
    type: r.type,
    maxOut: r.maxOut === null ? '' : String(r.maxOut),
    maxIn: r.maxIn === null ? '' : String(r.maxIn),
    createdAt: r.createdAt,
  }
}

/** 上限输入校验：空串（不限）或 ≥1 的整数文本 */
function isValidLimitInput(raw: string): boolean {
  const t = raw.trim()
  if (t === '') return true
  return /^\d+$/.test(t) && Number(t) >= 1
}

/**
 * 关系基数上限规则编辑器（折叠分区）。
 * 草稿行在本地编辑，「保存规则」时清洗提交：空类型行与两侧均留空（不限）的行丢弃，
 * 同类型重复行 / 非法上限会拦截保存。审计只提示，不阻止建立关系。
 */
function CardinalityRuleEditor({
  rules,
  existingTypes,
  onSave,
}: {
  rules: RelationCardinalityRule[]
  /** 已建关系的类型列表，供输入框 datalist 补全 */
  existingTypes: string[]
  onSave: (rules: RelationCardinalityRule[]) => void
}) {
  const listId = useId()
  const [rows, setRows] = useState<RuleDraft[]>(() => rules.map(ruleToDraft))
  const [dirty, setDirty] = useState(false)

  // 外部规则变化（保存回写 / JSON 导入）后以最新规则重置草稿
  useEffect(() => {
    setRows(rules.map(ruleToDraft))
    setDirty(false)
  }, [rules])

  const patchRow = (key: string, patch: Partial<Omit<RuleDraft, 'key'>>) => {
    setDirty(true)
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }
  const addRow = () => {
    setDirty(true)
    setRows((rs) => [
      ...rs,
      { key: ruleDraftKey(), id: null, type: '', maxOut: '', maxIn: '', createdAt: Date.now() },
    ])
  }
  const removeRow = (key: string) => {
    setDirty(true)
    setRows((rs) => rs.filter((r) => r.key !== key))
  }

  const validation = useMemo(() => {
    const badLimit = new Set<string>()
    const dup = new Set<string>()
    const seen = new Map<string, string>()
    for (const r of rows) {
      if (!isValidLimitInput(r.maxOut) || !isValidLimitInput(r.maxIn)) {
        badLimit.add(r.key)
      }
      const type = normalizeRelationType(r.type)
      if (!type) continue // 空类型行保存时直接丢弃，不算错误
      if (seen.has(type)) {
        dup.add(r.key)
        dup.add(seen.get(type)!)
      } else {
        seen.set(type, r.key)
      }
    }
    return { badLimit, dup }
  }, [rows])

  const invalid = validation.badLimit.size > 0 || validation.dup.size > 0

  const save = () => {
    if (invalid) return
    const out: RelationCardinalityRule[] = []
    const seen = new Set<string>()
    for (const r of rows) {
      const type = normalizeRelationType(r.type)
      if (!type || seen.has(type)) continue
      const maxOut = normalizeCardinalityLimit(r.maxOut)
      const maxIn = normalizeCardinalityLimit(r.maxIn)
      if (maxOut === null && maxIn === null) continue // 两侧均不限：无审计意义
      seen.add(type)
      out.push({
        id: r.id ?? makeCardinalityRuleId(),
        type,
        maxOut,
        maxIn,
        createdAt: r.createdAt,
      })
    }
    onSave(out)
  }

  return (
    <details className="rel-cap-editor">
      <summary>
        基数上限规则{rules.length > 0 ? `（${rules.length}）` : ''}
      </summary>
      <p className="side-hint">
        按关系类型限制每条<strong>源标注的最大出边数</strong>与每条<strong>目标标注的最大入边数</strong>，
        留空表示不限。仅统计<strong>有效关系</strong>：同一端点、同一类型按创建时间（再按关系 ID）排序，
        超出名额的关系标记为<strong>超限</strong>；审计只提示，<strong>不阻止</strong>建立关系。
      </p>
      <div className="rel-cap-rows">
        {rows.length === 0 && (
          <p className="side-hint">还没有规则。点击「添加规则」为某个关系类型设置上限。</p>
        )}
        {rows.map((r) => {
          const badLimit = validation.badLimit.has(r.key)
          const dup = validation.dup.has(r.key)
          return (
            <div
              key={r.key}
              className={`rel-cap-row ${badLimit ? 'rel-cap-row-bad' : ''} ${
                dup ? 'rel-cap-row-dup' : ''
              }`}
            >
              <div className="rel-cap-row-main">
                <input
                  className="rule-input rel-cap-type"
                  value={r.type}
                  list={listId}
                  placeholder="关系类型，如：支撑"
                  onChange={(e) => patchRow(r.key, { type: e.target.value })}
                />
                <button
                  type="button"
                  className="tag-chip-x rule-del"
                  aria-label="删除该规则"
                  onClick={() => removeRow(r.key)}
                >
                  ×
                </button>
              </div>
              <div className="rel-cap-row-limits">
                <label className="rel-cap-field">
                  源出边 ≤
                  <input
                    className="rule-input rel-cap-num"
                    value={r.maxOut}
                    placeholder="不限"
                    inputMode="numeric"
                    onChange={(e) => patchRow(r.key, { maxOut: e.target.value })}
                  />
                </label>
                <label className="rel-cap-field">
                  目标入边 ≤
                  <input
                    className="rule-input rel-cap-num"
                    value={r.maxIn}
                    placeholder="不限"
                    inputMode="numeric"
                    onChange={(e) => patchRow(r.key, { maxIn: e.target.value })}
                  />
                </label>
              </div>
              {(badLimit || dup) && (
                <div className="rule-row-msg">
                  {dup ? '该类型与另一行重复' : '上限须为 ≥1 的整数，留空表示不限'}
                </div>
              )}
            </div>
          )
        })}
        <datalist id={listId}>
          {existingTypes.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      <div className="rel-cap-actions">
        <button type="button" className="btn btn-ghost btn-small" onClick={addRow}>
          + 添加规则
        </button>
        <span className="form-spacer" />
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={!dirty || invalid}
          onClick={save}
        >
          保存规则
        </button>
      </div>
    </details>
  )
}

/** 标注关系侧栏分区：新建表单 + 类型筛选 + 有效 / 失效关系列表 */
export function RelationsSection(props: Props) {
  const { annotations, views, cardinalityAudit } = props
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES)

  const boundAnnotations = useMemo(
    () =>
      annotations
        .filter((a) => a.status === 'bound')
        .sort(
          (x, y) =>
            x.start - y.start || x.end - y.end || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
        ),
    [annotations],
  )

  const types = useMemo(() => relationTypeFilters(views.map((v) => v.relation)), [views])
  const existingKeys = useMemo(
    () => new Set(views.map((v) => relationKey(v.relation.sourceId, v.relation.targetId, v.relation.type))),
    [views],
  )

  const sorted = useMemo(() => sortRelationViews(views), [views])
  const matches = (v: RelationView) => {
    if (typeFilter === ALL_TYPES) return true
    if (typeFilter === OVER_LIMIT) return cardinalityAudit.byRelationId.has(v.relation.id)
    return v.relation.type === typeFilter
  }
  const activeViews = sorted.filter((v) => v.active && matches(v))
  const invalidViews = sorted.filter((v) => !v.active && matches(v))
  const violationCount = cardinalityAudit.violationCount

  // 每个类型的关系数（含失效），供筛选芯片展示
  const countByType = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of views) m.set(v.relation.type, (m.get(v.relation.type) ?? 0) + 1)
    return m
  }, [views])

  // 当前筛选失效（类型最后一条关系被删，或超限项全部消失）时回到「全部」
  useEffect(() => {
    if (typeFilter === ALL_TYPES) return
    if (typeFilter === OVER_LIMIT) {
      if (violationCount === 0) setTypeFilter(ALL_TYPES)
      return
    }
    if (!types.includes(typeFilter)) setTypeFilter(ALL_TYPES)
  }, [typeFilter, types, violationCount])

  return (
    <section
      className="side-section relations-section"
      ref={(props.sectionRef as React.Ref<HTMLElement>) ?? undefined}
    >
      <h2
        className={`side-heading ${
          invalidViews.length > 0 || violationCount > 0 ? 'side-heading-relation' : ''
        }`}
      >
        标注关系
        {invalidViews.length > 0 && (
          <span
            className="conflict-count-badge relation-count-badge"
            title="失效关系数（任一端删除或待处理）"
          >
            {invalidViews.length}
          </span>
        )}
        {violationCount > 0 && (
          <span
            className="conflict-count-badge relation-count-badge rel-cap-badge"
            title="基数超限关系数（仅提示，不阻止建立关系）"
          >
            {violationCount}
          </span>
        )}
      </h2>
      <p className="side-hint">
        从两条<strong>已绑定标注</strong>中选择<strong>源</strong>与<strong>目标</strong>并填写
        <strong>关系类型</strong>，建立有向关系（源 → 目标）。禁止自关联与完全重复关系；
        点击关系任一端可定位原文。删除标注或其进入待处理时关系自动标为<strong>失效</strong>，
        待处理端重新绑定后<strong>自动恢复</strong>。还可在下方
        <strong>基数上限规则</strong>中按类型配置源端出边 / 目标端入边名额，
        超额关系实时标记为<strong>超限</strong>（仅提示，不阻止建立）。
      </p>

      <RelationCreateForm
        boundAnnotations={boundAnnotations}
        existingKeys={existingKeys}
        existingTypes={types}
        onCreate={props.onCreate}
      />

      <CardinalityRuleEditor
        rules={props.cardinalityRules}
        existingTypes={types}
        onSave={props.onSaveCardinalityRules}
      />

      {views.length === 0 ? (
        <p className="side-hint">还没有关系。</p>
      ) : (
        <>
          <div className="rel-filters">
            <button
              type="button"
              className={`rel-filter ${typeFilter === ALL_TYPES ? 'rel-filter-on' : ''}`}
              aria-pressed={typeFilter === ALL_TYPES}
              onClick={() => setTypeFilter(ALL_TYPES)}
            >
              全部 {views.length}
            </button>
            {violationCount > 0 && (
              <button
                type="button"
                className={`rel-filter rel-filter-over ${typeFilter === OVER_LIMIT ? 'rel-filter-on' : ''}`}
                aria-pressed={typeFilter === OVER_LIMIT}
                onClick={() => setTypeFilter(OVER_LIMIT)}
                title="只显示基数超限的有效关系"
              >
                超限 {violationCount}
              </button>
            )}
            {types.map((t) => (
              <button
                type="button"
                key={t}
                className={`rel-filter ${typeFilter === t ? 'rel-filter-on' : ''}`}
                aria-pressed={typeFilter === t}
                onClick={() => setTypeFilter(t)}
                title="只显示该类型的关系"
              >
                {t} {countByType.get(t) ?? 0}
              </button>
            ))}
          </div>

          <p className="rel-summary">
            有效 <strong>{views.filter((v) => v.active).length}</strong> 条 · 失效{' '}
            <strong className={invalidViews.length > 0 ? 'rel-summary-invalid' : ''}>
              {invalidViews.length}
            </strong>{' '}
            条
            {violationCount > 0 && (
              <>
                {' '}· 超限{' '}
                <strong className="rel-summary-over">{violationCount}</strong> 条
              </>
            )}
          </p>

          {activeViews.length === 0 ? (
            <p className="side-hint">
              {typeFilter === OVER_LIMIT ? '当前没有基数超限的关系。' : '该筛选下没有有效关系。'}
            </p>
          ) : (
            activeViews.map((v) => (
              <RelationCard
                key={v.relation.id}
                view={v}
                violation={cardinalityAudit.byRelationId.get(v.relation.id) ?? null}
                activeId={props.activeId}
                onFocus={props.onFocus}
                onRebindStart={props.onRebindStart}
                onDelete={props.onDelete}
              />
            ))
          )}

          {invalidViews.length > 0 && (
            <details className="rel-invalid-fold">
              <summary>失效关系（{invalidViews.length}）</summary>
              {invalidViews.map((v) => (
                <RelationCard
                  key={v.relation.id}
                  view={v}
                  violation={null}
                  activeId={props.activeId}
                  onFocus={props.onFocus}
                  onRebindStart={props.onRebindStart}
                  onDelete={props.onDelete}
                />
              ))}
            </details>
          )}
        </>
      )}
    </section>
  )
}
