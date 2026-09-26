import { useRef } from 'react'
import type { TextSegment } from '../lib/segments'
import { blendedColor } from '../lib/segments'
import { selectionToOffsets } from '../lib/dom'
import { isConflictSegment } from '../lib/conflicts'

export interface ViewRect {
  top: number
  bottom: number
  left: number
  right: number
}

interface Props {
  text: string
  segments: TextSegment[]
  activeIds: string[]
  rebinding: boolean
  /** 未忽略冲突的交叠区间（已排序），落在其内的段加冲突描边 */
  conflictRanges: Array<{ start: number; end: number }>
  /** 覆盖审计：按段起点标记该段是缺口 / 重叠 */
  coverageKindByStart: Map<number, 'gap' | 'overlap'>
  /** 侧栏点击审计结果后要高亮的区间 */
  activeCoverageRange: { start: number; end: number } | null
  onSelect: (range: { start: number; end: number }, rect: ViewRect) => void
  onInspect: (ids: string[], rect: ViewRect) => void
  registerRef: (el: HTMLElement | null) => void
}

export function TextView({
  text,
  segments,
  activeIds,
  rebinding,
  conflictRanges,
  coverageKindByStart,
  activeCoverageRange,
  onSelect,
  onInspect,
  registerRef,
}: Props) {
  const rootRef = useRef<HTMLElement | null>(null)

  const setRef = (el: HTMLElement | null) => {
    rootRef.current = el
    registerRef(el)
  }

  const readSelection = (e: React.MouseEvent | React.KeyboardEvent) => {
    const root = rootRef.current
    if (!root) return
    // 等待浏览器更新 Selection
    setTimeout(() => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return

      if (sel.isCollapsed) {
        if ('button' in e) {
          const target = (e.target as HTMLElement).closest<HTMLElement>('[data-ids]')
          if (target && root.contains(target)) {
            const ids = (target.dataset.ids ?? '').split(',').filter(Boolean)
            if (ids.length) {
              const r = target.getBoundingClientRect()
              onInspect(ids, { top: r.top, bottom: r.bottom, left: r.left, right: r.right })
            }
          }
        }
        return
      }

      const range = selectionToOffsets(root)
      if (!range) return
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      onSelect(range, { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
    }, 0)
  }

  const handleMouseUp = (e: React.MouseEvent) => readSelection(e)
  const handleKeyUp = (e: React.KeyboardEvent) => {
    // 支持 Shift + 方向键 / Shift+Home / Shift+End 形成的选区
    if (e.shiftKey && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) {
      readSelection(e)
    }
  }

  if (!text) {
    return (
      <div className="text-empty">
        <p>还没有原文。</p>
        <p>点击左上角「粘贴 / 编辑原文」，把需要标注的文本粘贴进来吧。</p>
      </div>
    )
  }

  return (
    <article
      ref={setRef}
      className={`text-view ${rebinding ? 'rebinding' : ''}`}
      onMouseUp={handleMouseUp}
      onKeyUp={handleKeyUp}
    >
      {segments.map((seg, i) => {
        const slice = text.slice(seg.start, seg.end)
        const coverageKind = coverageKindByStart.get(seg.start) ?? null
        const coverageActive =
          !!activeCoverageRange &&
          seg.start >= activeCoverageRange.start &&
          seg.end <= activeCoverageRange.end
        if (seg.annotationIds.length === 0) {
          // 覆盖缺口：无标注的段也要可着色 / 可滚动定位
          if (coverageKind) {
            return (
              <mark
                key={i}
                data-start={seg.start}
                data-end={seg.end}
                className={`cov cov-${coverageKind} ${coverageActive ? 'cov-active' : ''}`}
              >
                {slice}
              </mark>
            )
          }
          return <span key={i}>{slice}</span>
        }
        const isActive = seg.annotationIds.some((id) => activeIds.includes(id))
        const isConflict = isConflictSegment(conflictRanges, seg.start, seg.end)
        const covClass = coverageKind ? `cov cov-${coverageKind}` : ''
        return (
          <mark
            key={i}
            data-start={seg.start}
            data-end={seg.end}
            data-ids={seg.annotationIds.join(',')}
            className={`hl ${isActive ? 'hl-active' : ''} ${isConflict ? 'hl-conflict' : ''} ${covClass} ${coverageActive ? 'cov-active' : ''}`}
            style={{ backgroundColor: blendedColor(seg.annotationIds) }}
          >
            {slice}
          </mark>
        )
      })}
    </article>
  )
}
