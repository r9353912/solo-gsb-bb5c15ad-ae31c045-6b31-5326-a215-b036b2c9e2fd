import { useEffect, useId, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { Annotation } from '../types'
import { badgeColor } from '../lib/segments'
import {
  RELATION_INVALID_REASON_LABEL,
  isSelfRelation,
  normalizeRelationType,
  relationKey,
  relationTypeFilters,
  sortRelationViews,
  type RelationView,
} from '../lib/relations'

interface Props {
  annotations: Annotation[]
  views: RelationView[]
  activeId: string | null
  onCreate: (sourceId: string, targetId: string, type: string) => void
  onDelete: (id: string) => void
  /** 点击有效关系的一端：在原文中定位（仅已绑定标注可调用） */
  onFocus: (a: Annotation) => void
  /** 点击失效关系上处于待处理的一端：进入重新绑定 */
  onRebindStart: (a: Annotation) => void
  /** 分区滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

const ALL_TYPES = '__all__'

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
  activeId,
  onFocus,
  onRebindStart,
  onDelete,
}: {
  view: RelationView
} & Pick<Props, 'activeId' | 'onFocus' | 'onRebindStart' | 'onDelete'>) {
  return (
    <div className={`rel-item ${view.active ? '' : 'rel-item-invalid'}`}>
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

/** 标注关系侧栏分区：新建表单 + 类型筛选 + 有效 / 失效关系列表 */
export function RelationsSection(props: Props) {
  const { annotations, views } = props
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
  const matches = (v: RelationView) => typeFilter === ALL_TYPES || v.relation.type === typeFilter
  const activeViews = sorted.filter((v) => v.active && matches(v))
  const invalidViews = sorted.filter((v) => !v.active && matches(v))

  // 每个类型的关系数（含失效），供筛选芯片展示
  const countByType = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of views) m.set(v.relation.type, (m.get(v.relation.type) ?? 0) + 1)
    return m
  }, [views])

  // 当前筛选被删除（最后一条该类型关系被删）时回到「全部」
  useEffect(() => {
    if (typeFilter !== ALL_TYPES && !types.includes(typeFilter)) {
      setTypeFilter(ALL_TYPES)
    }
  }, [typeFilter, types])

  return (
    <section
      className="side-section relations-section"
      ref={(props.sectionRef as React.Ref<HTMLElement>) ?? undefined}
    >
      <h2
        className={`side-heading ${invalidViews.length > 0 ? 'side-heading-relation' : ''}`}
      >
        标注关系
        {invalidViews.length > 0 && (
          <span className="conflict-count-badge relation-count-badge">{invalidViews.length}</span>
        )}
      </h2>
      <p className="side-hint">
        从两条<strong>已绑定标注</strong>中选择<strong>源</strong>与<strong>目标</strong>并填写
        <strong>关系类型</strong>，建立有向关系（源 → 目标）。禁止自关联与完全重复关系；
        点击关系任一端可定位原文。删除标注或其进入待处理时关系自动标为<strong>失效</strong>，
        待处理端重新绑定后<strong>自动恢复</strong>。
      </p>

      <RelationCreateForm
        boundAnnotations={boundAnnotations}
        existingKeys={existingKeys}
        existingTypes={types}
        onCreate={props.onCreate}
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
          </p>

          {activeViews.length === 0 ? (
            <p className="side-hint">该筛选下没有有效关系。</p>
          ) : (
            activeViews.map((v) => (
              <RelationCard
                key={v.relation.id}
                view={v}
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
