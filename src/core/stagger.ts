/**
 * 双人错峰预演规划器。
 *
 * 选择两名不同舞者，把各自**整条路点时间统一后移** d 个整数时间单位
 * （坐标、半径、相对节奏即段时长一律不变），枚举全部合法组合：
 *
 * - d ∈ [0, 20] 的整数；
 * - 后移后任何路点 t 仍不得超过 600 上界，即 d ≤ 600 - 末路点时刻；
 * - 冲突判定复用现有精确有理数实现（BigInt 分数，≤ 含等号），绝不抽样。
 *
 * 只接受“所有舞者对均无冲突”的组合；裁决顺序：
 *   1. 两人延迟之和最小；
 *   2. 和相同则按“选中舞者 ID 升序”对应的延迟二元组字典序裁决。
 *
 * 未选中的两名舞者之间的冲突与延迟无关（两人的时间都没动），
 * 若存在则直接判定无解，不必枚举。
 */
import { analyzeChoreography, validateChoreography, LIMITS } from './choreography'
import { buildSegments, minSquaredDistance } from './geometry'
import type { AnalysisReportDTO, Choreography, Dancer } from './types'

export const STAGGER_LIMITS = {
  MIN_DELAY: 0,
  MAX_DELAY: 20
} as const

export interface StaggerConflictBrief {
  aId: number
  bId: number
  count: number
}

export type StaggerPlan =
  | {
      found: true
      /** 按舞者 ID 升序排列的两名舞者 */
      dancerIds: [number, number]
      /** 与 dancerIds 对齐的延迟二元组（升序 ID 各自的后移量） */
      delays: [number, number]
      delaySum: number
      /** 应用延迟后的候选编排（坐标 / 半径 / 相对节奏不变），仅供预演展示 */
      candidate: Choreography
      /** 被消除的原有冲突总数（方案成立时原编排冲突全部消失） */
      eliminatedCount: number
      eliminatedPairs: StaggerConflictBrief[]
      /** 每名选中舞者当时可选的延迟上界（含） */
      caps: [number, number]
    }
  | {
      found: false
      dancerIds: [number, number]
      /**
       * unselected-conflict：未选中的两名舞者之间本就有冲突，只动两人无法消除；
       * unresolved-within-range：合法延迟范围内没有任何组合能完全消除冲突。
       */
      reason: 'unselected-conflict' | 'unresolved-within-range'
      originalCount: number
      /** reason=unselected-conflict 时，与延迟无关的未选中舞者冲突对 */
      unselectedPairs: StaggerConflictBrief[]
      caps: [number, number]
      /** 枚举过的组合里残余冲突最少的一次（无组合可枚举时为 null） */
      bestAttempt: {
        delays: [number, number]
        delaySum: number
        remainingCount: number
        remainingPairs: StaggerConflictBrief[]
      } | null
    }

export interface StaggerRequest {
  choreography: Choreography
  /** 两个不同舞者的 ID（顺序任意，内部按 ID 升序归一） */
  dancerIds: readonly number[]
}

/** 单名舞者的合法延迟上界：0..min(20, 600-末路点时刻) */
export function delayCap(dancer: Dancer): number {
  const lastT = dancer.waypoints[dancer.waypoints.length - 1]!.t
  return Math.max(0, Math.min(STAGGER_LIMITS.MAX_DELAY, LIMITS.MAX_TIME - lastT))
}

/**
 * 返回一条深拷贝的新编排：指定舞者的全部路点时刻统一加 delta，
 * 坐标 / 半径 / 名称 / 段时长（相对节奏）保持不变。
 */
export function shiftChoreography(c: Choreography, delays: ReadonlyMap<number, number>): Choreography {
  const out: Choreography = JSON.parse(JSON.stringify(c))
  for (const d of out) {
    const delta = delays.get(d.id) ?? 0
    if (delta === 0) continue
    for (const w of d.waypoints) w.t += delta
  }
  return out
}

function pairBriefs(report: AnalysisReportDTO): StaggerConflictBrief[] {
  return report.reports
    .map((r) => ({ aId: r.aId, bId: r.bId, count: r.conflicts.length }))
    .sort((p, q) => p.aId - q.aId || p.bId - q.bId)
}

function briefTotal(pairs: StaggerConflictBrief[]): number {
  return pairs.reduce((n, p) => n + p.count, 0)
}

/** 一对舞者的冲突线段数（精确分数比较，逐条计数） */
function pairConflictCount(a: Dancer, b: Dancer): number {
  const segsA = buildSegments(a)
  const segsB = buildSegments(b)
  const radiusSum = BigInt(a.radius + b.radius)
  const thresholdSq = radiusSum * radiusSum
  let n = 0
  for (const segA of segsA) {
    for (const segB of segsB) {
      const res = minSquaredDistance(segA, segB)
      if (!res) continue
      if (res.minSqDist.num <= thresholdSq * res.minSqDist.den) n++
    }
  }
  return n
}

/** 一对舞者是否存在至少一条冲突线段（首个命中即短路） */
function pairHasConflict(a: Dancer, b: Dancer): boolean {
  const segsA = buildSegments(a)
  const segsB = buildSegments(b)
  const radiusSum = BigInt(a.radius + b.radius)
  const thresholdSq = radiusSum * radiusSum
  for (const segA of segsA) {
    for (const segB of segsB) {
      const res = minSquaredDistance(segA, segB)
      if (!res) continue
      if (res.minSqDist.num <= thresholdSq * res.minSqDist.den) return true
    }
  }
  return false
}

/**
 * 枚举检查延迟组合是否安全。只需要扫描“至少一端是选中舞者”的舞者对：
 * 两个未选中舞者之间的结果对任何延迟都不变，已在枚举前一次性排除。
 */
function comboIsSafe(c: Choreography, selected: ReadonlySet<number>): boolean {
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      if (!selected.has(c[i]!.id) && !selected.has(c[j]!.id)) continue
      if (pairHasConflict(c[i]!, c[j]!)) return false
    }
  }
  return true
}

/** 统计“至少一端被选中”的舞者对的冲突总数（未选中对已在枚举前证明无冲突） */
function countConflicts(c: Choreography, selected: ReadonlySet<number>): number {
  let n = 0
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      if (!selected.has(c[i]!.id) && !selected.has(c[j]!.id)) continue
      n += pairConflictCount(c[i]!, c[j]!)
    }
  }
  return n
}

/** 双人错峰预演：枚举全部合法延迟组合，返回按裁决顺序选出的方案或明确无解 */
export function planStagger(req: StaggerRequest): StaggerPlan {
  const issues = validateChoreography(req.choreography)
  if (issues.length > 0) {
    throw new Error(`编排未通过校验，无法预演：${issues.map((x) => x.message).join('；')}`)
  }

  const ids = [...new Set(Array.from(req.dancerIds))].sort((a, b) => a - b)
  if (ids.length !== 2 || !ids.every((id) => Number.isInteger(id))) {
    throw new Error('双人错峰预演必须选择两名不同的舞者')
  }
  const [idA, idB] = ids as [number, number]
  const dancerA = req.choreography.find((d) => d.id === idA)
  const dancerB = req.choreography.find((d) => d.id === idB)
  if (!dancerA || !dancerB) {
    throw new Error(`选中的舞者不存在：#${idA}、#${idB}`)
  }

  const baseReport = analyzeChoreography(req.choreography)
  const eliminatedPairs = pairBriefs(baseReport)
  const originalCount = briefTotal(eliminatedPairs)

  // 冲突对两端都不是选中舞者时，延迟任何一人都改变不了这一对
  const unselectedPairs = eliminatedPairs.filter(
    (p) => p.aId !== idA && p.aId !== idB && p.bId !== idA && p.bId !== idB
  )

  const caps: [number, number] = [delayCap(dancerA), delayCap(dancerB)]

  const base: StaggerPlan = !unselectedPairs.length
    ? ({
        found: false,
        dancerIds: [idA, idB],
        reason: 'unresolved-within-range',
        originalCount,
        unselectedPairs: [],
        caps,
        bestAttempt: null
      } as const)
    : ({
        found: false,
        dancerIds: [idA, idB],
        reason: 'unselected-conflict',
        originalCount,
        unselectedPairs,
        caps,
        bestAttempt: null
      } as const)

  // 未选中舞者之间已有冲突：任何延迟都改不到这一对，直接无解，不枚举
  if (unselectedPairs.length > 0) return base

  const selected = new Set<number>([idA, idB])
  const delaysMap = new Map<number, number>()

  let bestAttempt:
    | {
        delays: [number, number]
        delaySum: number
        remainingCount: number
        remainingPairs: StaggerConflictBrief[]
      }
    | null = null
  // 外层延迟和升序、内层升序 ID 舞者的延迟升序：
  // 第一个零冲突组合即满足“和最小 → 二元组字典序最小”的裁决规则。
  let found: { delays: [number, number]; sum: number; candidate: Choreography } | null = null
  outer: for (let sum = 0; sum <= caps[0] + caps[1] && !found; sum++) {
    for (let dA = 0; dA <= caps[0]; dA++) {
      const dB = sum - dA
      if (dB < 0 || dB > caps[1]) continue
      const tuple: [number, number] = [dA, dB]
      delaysMap.set(idA, dA)
      delaysMap.set(idB, dB)
      const candidate = shiftChoreography(req.choreography, delaysMap)
      if (comboIsSafe(candidate, selected)) {
        found = { delays: tuple, sum, candidate }
        break outer
      }
      if (!bestAttempt) {
        // 首个组合先占位；之后仅在残余冲突严格更少时更新（同值保留裁决序最前者）
        const remaining = pairBriefs(analyzeChoreography(candidate))
        bestAttempt = {
          delays: tuple,
          delaySum: sum,
          remainingCount: briefTotal(remaining),
          remainingPairs: remaining
        }
      } else {
        // 用短路计数评估是否比当前 bestAttempt 更少；只在更少时补做完整报告
        const probe = countConflicts(candidate, selected)
        if (probe < bestAttempt.remainingCount) {
          const remaining = pairBriefs(analyzeChoreography(candidate))
          bestAttempt = {
            delays: tuple,
            delaySum: sum,
            remainingCount: briefTotal(remaining),
            remainingPairs: remaining
          }
        }
      }
    }
  }

  if (found) {
    return {
      found: true,
      dancerIds: [idA, idB],
      delays: found.delays,
      delaySum: found.sum,
      candidate: found.candidate,
      eliminatedCount: originalCount,
      eliminatedPairs,
      caps
    }
  }

  return { ...base, bestAttempt }
}
