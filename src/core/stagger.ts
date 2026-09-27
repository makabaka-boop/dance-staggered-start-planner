import { analyzeChoreography, validateChoreography } from './choreography'
import { buildSegments, minSquaredDistance } from './geometry'
import type {
  AnalysisReportDTO,
  Choreography,
  Dancer,
  PairReportDTO
} from './types'

export const STAGGER_MAX_DELAY = 20
export const STAGGER_DANCER_COUNT = 2

export interface StaggerSelection {
  /** 按舞者 ID 升序排列；延迟数组与之一一对应 */
  dancerIds: [number, number]
  delays: [number, number]
}

export interface EliminatedConflictGroup {
  pair: PairReportDTO
}

export interface StaggerPreview extends StaggerSelection {
  /** 产生方案时绑定的正式编排版本 */
  sourceVersion: number
  /** 仅用于预演的候选编排；正式编排不会被它修改 */
  candidate: Choreography
  /** 候选编排的完整分析；安全方案中 reports 必定为空 */
  report: AnalysisReportDTO
  checkedCombinationCount: number
  /** 原报告中因这两个统一延迟而消失的冲突舞者对 */
  eliminated: EliminatedConflictGroup[]
  legalCombinationCount: number
}

export interface StaggerNoSolution {
  dancerIds: [number, number]
  legalCombinationCount: number
  /** 不涉及任何选中舞者的冲突；仅移动所选两人不可能消除它们 */
  persistentPairs: PairReportDTO[]
}

export type StaggerResult =
  | { status: 'solution'; preview: StaggerPreview }
  | { status: 'no-solution'; result: StaggerNoSolution }
  | { status: 'invalid'; message: string }

function cloneChoreography(c: Choreography): Choreography {
  return JSON.parse(JSON.stringify(c)) as Choreography
}

function sortedPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a]
}

function maxLegalDelay(d: Dancer): number {
  const lastT = d.waypoints[d.waypoints.length - 1]?.t
  return Math.min(STAGGER_MAX_DELAY, 600 - lastT)
}

export function staggerLegalBounds(c: Choreography, dancerIds: readonly number[]): number[] {
  return dancerIds.map((id) => {
    const d = c.find((x) => x.id === id)
    return d ? maxLegalDelay(d) : -1
  })
}

/** 返回应用统一整数延迟后的整条轨迹；坐标、半径和路点节奏均保持不变 */
export function withUniformDelays(
  source: Choreography,
  delaysByDancer: ReadonlyMap<number, number>
): Choreography {
  const next = cloneChoreography(source)
  for (const d of next) {
    const delay = delaysByDancer.get(d.id)
    if (delay === undefined) continue
    for (const w of d.waypoints) w.t += delay
  }
  return next
}

function hasConflictForPair(a: Dancer, b: Dancer): boolean {
  const segsA = buildSegments(a)
  const segsB = buildSegments(b)
  const threshold = BigInt(a.radius + b.radius)
  const thresholdSq = threshold * threshold

  for (const segA of segsA) {
    for (const segB of segsB) {
      const res = minSquaredDistance(segA, segB)
      if (!res) continue
      if (res.minSqDist.num <= thresholdSq * res.minSqDist.den) return true
    }
  }
  return false
}

function isSafeExceptPersistent(
  c: Choreography,
  selected: ReadonlySet<number>,
  persistentPairs: ReadonlySet<string>
): boolean {
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      const a = c[i]
      const b = c[j]
      const key = `${a.id}-${b.id}`
      if (persistentPairs.has(key)) return false
      // 两个舞者都未选中时，它们的相对时间和坐标完全未变，无需重复计算。
      if (!selected.has(a.id) && !selected.has(b.id)) continue
      if (hasConflictForPair(a, b)) return false
    }
  }
  return true
}

function pairInvolvesSelection(pair: PairReportDTO, selected: ReadonlySet<number>): boolean {
  return selected.has(pair.aId) || selected.has(pair.bId)
}

function buildEliminatedGroups(
  baseline: AnalysisReportDTO,
  selected: ReadonlySet<number>
): EliminatedConflictGroup[] {
  return baseline.reports
    .filter((pair) => pairInvolvesSelection(pair, selected))
    .map((pair) => ({ pair }))
}

/**
 * 双人错峰预演：枚举选中两名舞者各自 0..20 的所有整数统一延迟。
 *
 * 仍会越过 600 的延迟在枚举前剔除；每个候选都复用正式分析中的精确
 * BigInt 线段判定。按 (延迟和, ID 较小者延迟, ID 较大者延迟) 的枚举顺序
 * 返回第一个全局无冲突方案。
 */
export function planTwoDancerStagger(
  source: Choreography,
  firstId: number,
  secondId: number,
  sourceVersion: number,
  baselineReport?: AnalysisReportDTO | null
): StaggerResult {
  const issues = validateChoreography(source)
  if (issues.length > 0) return { status: 'invalid', message: '编排未通过校验，不能预演' }
  if (firstId === secondId) return { status: 'invalid', message: '必须选择两个不同舞者' }
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) {
    return { status: 'invalid', message: '预演必须绑定当前编排版本' }
  }

  const dancerIds = sortedPair(firstId, secondId)
  const selected = new Set<number>(dancerIds)
  const dancers = dancerIds.map((id) => source.find((d) => d.id === id))
  if (dancers.some((d) => !d)) {
    return { status: 'invalid', message: '选择的舞者不存在' }
  }

  const bounds = dancers.map((d) => maxLegalDelay(d as Dancer))
  if (bounds.some((bound) => bound < 0)) {
    return { status: 'invalid', message: '存在超过 600 上界的路点时间' }
  }
  const legalCombinationCount = (bounds[0] + 1) * (bounds[1] + 1)

  const baseline = baselineReport ?? analyzeChoreography(source)
  const persistentPairs = new Set<string>()
  for (const pair of baseline.reports) {
    if (!pairInvolvesSelection(pair, selected)) persistentPairs.add(`${pair.aId}-${pair.bId}`)
  }
  const persistentPairReports = baseline.reports.filter(
    (pair) => persistentPairs.has(`${pair.aId}-${pair.bId}`)
  )
  let solution: StaggerPreview | null = null
  let checkedCombinationCount = 0

  // 枚举顺序先按延迟和，再在同和中按 ID 较小者延迟升序（等价于 ID 升序二元组字典序）。
  for (let sum = 0; sum <= bounds[0] + bounds[1]; sum++) {
    const d0Min = Math.max(0, sum - bounds[1])
    const d0Max = Math.min(bounds[0], sum)
    for (let d0 = d0Min; d0 <= d0Max; d0++) {
      const d1 = sum - d0
      checkedCombinationCount++

      // 已找到更优（延迟和更小 / 同和字典序更早）方案；仍继续统计全部合法组合，
      // 但不再重复几何分析或覆盖第一解。
      if (solution) continue
      const delays = new Map<number, number>([
        [dancerIds[0], d0],
        [dancerIds[1], d1]
      ])
      const candidate = withUniformDelays(source, delays)
      if (!isSafeExceptPersistent(candidate, selected, persistentPairs)) continue

      const report = analyzeChoreography(candidate)
      if (report.reports.length !== 0) continue
      solution = {
        dancerIds,
        delays: [d0, d1],
        sourceVersion,
        candidate,
        report,
        checkedCombinationCount,
        eliminated: buildEliminatedGroups(baseline, selected),
        legalCombinationCount
      }
    }
  }

  if (solution) {
    solution.checkedCombinationCount = checkedCombinationCount
    return { status: 'solution', preview: solution }
  }

  return {
    status: 'no-solution',
    result: {
      dancerIds,
      legalCombinationCount,
      persistentPairs: persistentPairReports
    }
  }
}

export function previewVersionMatches(preview: StaggerPreview, version: number): boolean {
  return preview.sourceVersion === version
}

/** 应用时一次性替换两名舞者的全部路点时间；调用方必须先核对快照版本 */
export function applyStaggerPreview(target: Choreography, preview: StaggerSelection): void {
  for (const dancer of target) {
    const index = preview.dancerIds.indexOf(dancer.id)
    if (index < 0) continue
    dancer.waypoints = dancer.waypoints.map((w) => ({ ...w, t: w.t + preview.delays[index] }))
  }
}
