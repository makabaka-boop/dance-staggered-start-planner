import { describe, expect, it } from 'vitest'
import { analyzeChoreography } from './choreography'
import { Fraction } from './fraction'
import { delayCap, planStagger, shiftChoreography, STAGGER_LIMITS } from './stagger'
import type { Choreography, Dancer } from './types'

/**
 * 双人错峰预演规划器测试：
 * - 手工构造覆盖擦边（等号边界）、端点相接、并列（裁决序）、越界（上界截断）；
 * - 小规模随机编排上用独立的浮点全枚举（每个合法延迟组合都精扫线段对）作 oracle，
 *   与精确规划器逐组合核对可行性与裁决结果。
 */

function dancer(
  id: number,
  radius: number,
  waypoints: [number, number, number][],
  name?: string
): Dancer {
  return {
    id,
    name: name ?? `D${id}`,
    radius,
    waypoints: waypoints.map(([t, x, y]) => ({ t, x, y }))
  }
}

/** 反向相遇预设（radius 1+1）：A (0,0)→(10,0)，B (10,0)→(0,0)，t∈[0,10] */
function headOn(): Choreography {
  return [
    dancer(1, 1, [
      [0, 0, 0],
      [10, 10, 0]
    ]),
    dancer(2, 1, [
      [0, 10, 0],
      [10, 0, 0]
    ])
  ]
}

describe('planStagger · 裁决序与基本场景', () => {
  it('反向相遇：最小延迟和 11，升序 ID 二元组 (0, 11)', () => {
    const c = headOn()
    const res = planStagger({ choreography: c, dancerIds: [1, 2] })
    expect(res.found).toBe(true)
    if (!res.found) return
    expect(res.dancerIds).toEqual([1, 2])
    expect(res.delays).toEqual([0, 11])
    expect(res.delaySum).toBe(11)
    expect(res.eliminatedCount).toBe(1)
    expect(res.eliminatedPairs).toEqual([{ aId: 1, bId: 2, count: 1 }])
    expect(res.caps).toEqual([20, 20])

    // 候选确实零冲突
    expect(analyzeChoreography(res.candidate).reports).toEqual([])
    // 候选坐标 / 半径 / 段时长（相对节奏）不变，只有时刻后移
    const a = res.candidate.find((d) => d.id === 1)!
    expect(a.waypoints.map((w) => [w.x, w.y])).toEqual([
      [0, 0],
      [10, 0]
    ])
    expect(a.waypoints.map((w) => w.t)).toEqual([0, 10])
    const b = res.candidate.find((d) => d.id === 2)!
    expect(b.waypoints.map((w) => w.t)).toEqual([11, 21])
    expect(b.waypoints[1]!.t - b.waypoints[0]!.t).toBe(10)

    // (0,10) 仍在 d=2 阈值内（相对距离平方 25 > 36? 否：(10-10)^... ），
    // 精确地：δ=10 时最近 d²=0，δ=11 最近 |10-11|/√2 ⇒ d²=1/2 < 4 安全，δ=10 冲突
    const stillBad = analyzeChoreography(
      shiftChoreography(c, new Map([[2, 10]]))
    ).reports.length
    expect(stillBad).toBe(1)
  })

  it('端点相接（零长度重叠）：(0,0) 冲突，错 1 个单位即消除，答案 (0, 1)', () => {
    const c: Choreography = [
      dancer(1, 0, [
        [0, 0, 0],
        [10, 10, 0]
      ]),
      dancer(2, 0, [
        [10, 10, 0],
        [20, 20, 0]
      ])
    ]
    const res = planStagger({ choreography: c, dancerIds: [2, 1] }) // 故意逆序传入
    expect(res.found).toBe(true)
    if (!res.found) return
    // 内部按 ID 升序归一
    expect(res.dancerIds).toEqual([1, 2])
    expect(res.delays).toEqual([0, 1])
    expect(res.delaySum).toBe(1)
    expect(res.eliminatedCount).toBe(1)
    expect(analyzeChoreography(res.candidate).reports).toEqual([])
  })

  it('擦边等号边界：推迟原地舞者 δ=6 时最近 d²=36 恰等于半径和平方（冲突），δ=7 才安全', () => {
    // 舞者3 在原点停留 t∈[0,10]（零位移、非零时长），半径 3；
    // 舞者2 (0,0)→(20,0) t∈[0,20]，半径 3。
    // 推迟原地舞者3 δ 后重叠 [δ, min(10+δ,20)]，舞者2 在 t=δ 的位置距原点恰为 δ，
    // 相对速度 1 使之后越来越远 ⇒ 最近 d² = δ²，阈值 (3+3)²=36。
    const c: Choreography = [
      dancer(3, 3, [
        [0, 0, 0],
        [10, 0, 0]
      ]),
      dancer(2, 3, [
        [0, 0, 0],
        [20, 20, 0]
      ])
    ]
    // δ=6：d²=36，等号边界必须精确判为冲突（不能因浮点误差翻成安全）
    const touch = analyzeChoreography(shiftChoreography(c, new Map([[3, 6]])))
    expect(touch.reports[0]?.conflicts[0]?.minSqDist).toEqual({ num: '36', den: '1' })
    expect(analyzeChoreography(shiftChoreography(c, new Map([[3, 5]]))).reports.length).toBe(1)
    expect(analyzeChoreography(shiftChoreography(c, new Map([[3, 7]]))).reports).toEqual([])

    const res = planStagger({ choreography: c, dancerIds: [2, 3] })
    expect(res.found).toBe(true)
    if (!res.found) return
    // ID 升序归一：舞者2 不推迟、舞者3 推迟 7
    expect(res.dancerIds).toEqual([2, 3])
    expect(res.delays).toEqual([0, 7])
    expect(res.delaySum).toBe(7)
    expect(analyzeChoreography(res.candidate).reports).toEqual([])
  })

  it('并列裁决：最小和上 (0,1) 与 (1,0) 都安全时，按升序 ID 取 (0,1)', () => {
    // 端点相接型：只要 δ=dB-dA≠0 即无冲突；和 1 时 (0,1)/(1,0) 并列
    const c: Choreography = [
      dancer(1, 0, [
        [0, 0, 0],
        [10, 10, 0]
      ]),
      dancer(2, 0, [
        [10, 10, 0],
        [20, 20, 0]
      ])
    ]
    const res = planStagger({ choreography: c, dancerIds: [2, 1] })
    expect(res.found).toBe(true)
    if (!res.found) return
    expect(res.delays).toEqual([0, 1])
  })

  it('已经安全：(0, 0) 即为最优，消除冲突数为 0', () => {
    const c: Choreography = [
      dancer(1, 0, [
        [0, 0, 0],
        [10, 10, 0]
      ]),
      dancer(2, 0, [
        [0, 10, 5],
        [10, 0, 5]
      ])
    ]
    const res = planStagger({ choreography: c, dancerIds: [1, 2] })
    expect(res.found).toBe(true)
    if (!res.found) return
    expect(res.delays).toEqual([0, 0])
    expect(res.delaySum).toBe(0)
    expect(res.eliminatedCount).toBe(0)
    expect(res.eliminatedPairs).toEqual([])
  })

  it('越界：末路点 t=600 的舞者延迟上界为 0，方案只能推迟另一人', () => {
    // 舞者1：[580,600] 沿 (0,0)→(20,0)（速度 1），末时刻 600 ⇒ cap=0
    // 舞者2：[580,590] 沿 (0,0)→(10,0)（同速度 1），前 10 个时间单位与舞者1 完全重合 ⇒ cap=10
    // 推迟舞者2 δ 后两轨迹平行错开 δ：r=0+0 时 δ=1 即安全 ⇒ 答案 (0, 1)
    const c: Choreography = [
      dancer(1, 0, [
        [580, 0, 0],
        [600, 20, 0]
      ]),
      dancer(2, 0, [
        [580, 0, 0],
        [590, 10, 0]
      ])
    ]
    expect(delayCap(c[0]!)).toBe(0)
    expect(delayCap(c[1]!)).toBe(10)
    // 基础编排确实冲突（重合段 d=0）
    expect(analyzeChoreography(c).reports[0]?.conflicts[0]?.minSqDist).toEqual({
      num: '0',
      den: '1'
    })
    const res = planStagger({ choreography: c, dancerIds: [1, 2] })
    expect(res.found).toBe(true)
    if (!res.found) return
    expect(res.caps).toEqual([0, 10])
    expect(res.delays).toEqual([0, 1])
    expect(analyzeChoreography(res.candidate).reports).toEqual([])
    // 任何组合都不会让舞者1 的末路点越过 600
    expect(res.candidate[0]!.waypoints.at(-1)!.t).toBe(600)
    expect(res.candidate[1]!.waypoints.at(-1)!.t).toBe(591)
  })

  it('越界致无解：两人末时刻都是 600（cap 均 0）且基础编排冲突', () => {
    const c: Choreography = [
      dancer(1, 1, [
        [590, 0, 0],
        [600, 10, 0]
      ]),
      dancer(2, 1, [
        [590, 10, 0],
        [600, 0, 0]
      ])
    ]
    const res = planStagger({ choreography: c, dancerIds: [1, 2] })
    expect(res.found).toBe(false)
    if (res.found) return
    expect(res.reason).toBe('unresolved-within-range')
    expect(res.caps).toEqual([0, 0])
    expect(res.originalCount).toBe(1)
    expect(res.bestAttempt?.delays).toEqual([0, 0])
    expect(res.bestAttempt?.remainingCount).toBe(1)
  })

  it('未选中舞者之间存在冲突：直接判无解，不枚举', () => {
    // 4 人，选 {1,2}：3⨯4 的冲突与这两人的任何延迟都无关
    const c: Choreography = [
      dancer(1, 0, [
        [0, 100, 100],
        [10, 100, 100]
      ]),
      dancer(2, 0, [
        [0, 100, -100],
        [10, 100, -100]
      ]),
      dancer(3, 1, [
        [0, 0, 0],
        [10, 10, 0]
      ]),
      dancer(4, 1, [
        [0, 10, 0],
        [10, 0, 0]
      ])
    ]
    const res = planStagger({ choreography: c, dancerIds: [1, 2] })
    expect(res.found).toBe(false)
    if (res.found) return
    expect(res.reason).toBe('unselected-conflict')
    expect(res.unselectedPairs).toEqual([{ aId: 3, bId: 4, count: 1 }])

    // 反过来选 {3,4}：冲突对正是两人自己，枚举可解（推迟 1 即可错开）
    const res2 = planStagger({ choreography: c, dancerIds: [4, 3] })
    expect(res2.found).toBe(true)
  })

  it('参数非法：同一名舞者 / 不存在的 ID / 非法编排抛错', () => {
    const c = headOn()
    expect(() => planStagger({ choreography: c, dancerIds: [1, 1] })).toThrow()
    expect(() => planStagger({ choreography: c, dancerIds: [1, 9] })).toThrow()
    const broken = JSON.parse(JSON.stringify(c)) as Choreography
    broken[0]!.waypoints[1]!.t = 0 // 时间不再严格递增
    expect(() => planStagger({ choreography: broken, dancerIds: [1, 2] })).toThrow()
  })

  it('shiftChoreography：深拷贝且只改指定舞者的时刻，段时长不变', () => {
    const c = headOn()
    const out = shiftChoreography(
      c,
      new Map([
        [1, 3],
        [2, 7]
      ])
    )
    expect(out[0]!.waypoints.map((w) => w.t)).toEqual([3, 13])
    expect(out[1]!.waypoints.map((w) => w.t)).toEqual([7, 17])
    // 原编排不动
    expect(c[0]!.waypoints.map((w) => w.t)).toEqual([0, 10])
    // 坐标半径不变
    expect(out[0]!.radius).toBe(1)
    expect(out[1]!.waypoints[1]).toEqual({ t: 17, x: 0, y: 0 })
    // 延迟常量边界
    expect(STAGGER_LIMITS.MIN_DELAY).toBe(0)
    expect(STAGGER_LIMITS.MAX_DELAY).toBe(20)
  })

  it('候选的分数时刻仍可精确求值（不依赖浮点）', () => {
    const c = headOn()
    const res = planStagger({ choreography: c, dancerIds: [1, 2] })
    if (!res.found) throw new Error('expected plan')
    // 推迟后舞者2 的段为 [11,21]；其起点位置精确为 (10,0)
    expect(res.candidate[1]!.waypoints[0]).toEqual({ t: 11, x: 10, y: 0 })
    expect(new Fraction(11).eq(new Fraction(res.candidate[1]!.waypoints[0]!.t))).toBe(true)
  })
})

// ---- 独立浮点全枚举 oracle ----

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface NumSeg {
  t0: number
  t1: number
  x0: number
  y0: number
  vx: number
  vy: number
}

function numSegs(d: Dancer, shift: number): NumSeg[] {
  return d.waypoints.slice(0, -1).map((a, i) => {
    const b = d.waypoints[i + 1]!
    const dt = b.t - a.t
    return {
      t0: a.t + shift,
      t1: b.t + shift,
      x0: a.x,
      y0: a.y,
      vx: (b.x - a.x) / dt,
      vy: (b.y - a.y) / dt
    }
  })
}

/** oracle：浮点解析抛物线最小值（与 stagger.ts 的 BigInt 路径完全独立） */
function pairConflicts(a: Dancer, b: Dancer, da: number, db: number): boolean {
  const sa = numSegs(a, da)
  const sb = numSegs(b, db)
  const rs = a.radius + b.radius
  for (const x of sa) {
    for (const y of sb) {
      const lo = Math.max(x.t0, y.t0)
      const hi = Math.min(x.t1, y.t1)
      if (lo > hi) continue // 注意：lo==hi 的零长度重叠也要判
      const posA = { x: x.x0 + x.vx * (lo - x.t0), y: x.y0 + x.vy * (lo - x.t0) }
      const posB = { x: y.x0 + y.vx * (lo - y.t0), y: y.y0 + y.vy * (lo - y.t0) }
      const rvx = y.vx - x.vx
      const rvy = y.vy - x.vy
      const X = posB.x - posA.x
      const Y = posB.y - posA.y
      const P = rvx * rvx + rvy * rvy
      const Q = 2 * (rvx * X + rvy * Y)
      let u = 0
      if (P > 0) u = Math.max(0, Math.min(hi - lo, -Q / (2 * P)))
      const minSq = P * u * u + Q * u + (X * X + Y * Y)
      if (minSq <= rs * rs + 1e-9) return true
    }
  }
  return false
}

function randomDancer(rng: () => number, id: number, clampMaxT = false): Dancer {
  const n = 2 + Math.floor(rng() * 3) // 2..4 路点
  const times = new Set<number>()
  const hi = clampMaxT ? 600 : 20
  while (times.size < n) {
    times.add(clampMaxT ? 590 + Math.floor(rng() * 11) : Math.floor(rng() * (hi + 1)))
  }
  const ts = [...times].sort((a, b) => a - b)
  return {
    id,
    name: `D${id}`,
    radius: Math.floor(rng() * 3),
    waypoints: ts.map((t) => ({
      t,
      x: Math.floor(rng() * 11) - 5,
      y: Math.floor(rng() * 11) - 5
    }))
  }
}

describe('planStagger · 小规模延迟全枚举 oracle', () => {
  const SEEDS = [3, 11, 27, 64, 108, 2025, 31337]

  it.each(SEEDS)('seed=%s：规划器与全枚举 oracle 的可行集 / 裁决结果一致', (seed) => {
    const rng = mulberry32(seed)
    const nDancers = 2 + Math.floor(rng() * 3) // 2..4
    const choreo: Choreography = Array.from({ length: nDancers }, (_, i) => randomDancer(rng, i + 1))
    const ids = choreo.map((d) => d.id)
    const pick: [number, number] = (() => {
      const a = Math.floor(rng() * ids.length)
      let b = Math.floor(rng() * ids.length)
      while (b === a) b = Math.floor(rng() * ids.length)
      return [ids[a]!, ids[b]!]
    })()
    const [idA, idB] = [...pick].sort((x, y) => x - y) as [number, number]
    const A = choreo.find((d) => d.id === idA)!
    const B = choreo.find((d) => d.id === idB)!
    const capA = delayCap(A)
    const capB = delayCap(B)

    const baseReport = analyzeChoreography(choreo)
    const baseConflicts = baseReport.reports.reduce((n, r) => n + r.conflicts.length, 0)

    // oracle 枚举同一组合域（升序和、升序 dA，与规划器同序）
    const safeCombos: [number, number][] = []
    const combos: [number, number][] = []
    for (let sum = 0; sum <= capA + capB; sum++) {
      for (let dA = 0; dA <= capA; dA++) {
        const dB = sum - dA
        if (dB < 0 || dB > capB) continue
        combos.push([dA, dB])
        let safe = true
        for (let i = 0; i < choreo.length && safe; i++) {
          for (let j = i + 1; j < choreo.length; j++) {
            const dai = choreo[i]!.id === idA ? dA : choreo[i]!.id === idB ? dB : 0
            const dbi = choreo[j]!.id === idA ? dA : choreo[j]!.id === idB ? dB : 0
            if (pairConflicts(choreo[i]!, choreo[j]!, dai, dbi)) {
              safe = false
              break
            }
          }
        }
        if (safe) safeCombos.push([dA, dB])
      }
    }
    expect(combos.length).toBeGreaterThan(0)

    const unselectedConflict = baseReport.reports.some(
      (r) => ![idA, idB].includes(r.aId) && ![idA, idB].includes(r.bId)
    )

    const res = planStagger({ choreography: choreo, dancerIds: pick })
    expect(res.dancerIds).toEqual([idA, idB])
    expect(res.caps).toEqual([capA, capB])

    if (unselectedConflict) {
      expect(res.found).toBe(false)
      if (res.found) return
      expect(res.reason).toBe('unselected-conflict')
      expect(res.unselectedPairs.length).toBeGreaterThan(0)
      return
    }

    if (safeCombos.length === 0) {
      expect(res.found).toBe(false)
      if (res.found) return
      expect(res.reason).toBe('unresolved-within-range')
      // bestAttempt 必须确实是枚举域内残余最少的组合之一
      const residualOf = (tuple: [number, number]) => {
        let n = 0
        for (let i = 0; i < choreo.length; i++) {
          for (let j = i + 1; j < choreo.length; j++) {
            const dai = choreo[i]!.id === idA ? tuple[0] : choreo[i]!.id === idB ? tuple[1] : 0
            const dbi = choreo[j]!.id === idA ? tuple[0] : choreo[j]!.id === idB ? tuple[1] : 0
            if (pairConflicts(choreo[i]!, choreo[j]!, dai, dbi)) n++
          }
        }
        return n
      }
      const oracleMin = Math.min(...combos.map(residualOf))
      expect(res.bestAttempt).not.toBeNull()
      expect(residualOf(res.bestAttempt!.delays)).toBe(oracleMin)
      expect(res.bestAttempt!.remainingCount).toBe(oracleMin)
      return
    }

    expect(res.found).toBe(true)
    if (!res.found) return
    const expected = safeCombos[0]!
    expect(res.delays).toEqual(expected)
    expect(res.delaySum).toBe(expected[0] + expected[1])
    expect(res.eliminatedCount).toBe(baseConflicts)
    // 精确复核：候选对所有舞者对零冲突
    expect(analyzeChoreography(res.candidate).reports).toEqual([])
    // 候选未选中舞者轨迹时刻必须原样
    for (const d of res.candidate) {
      if (d.id === idA || d.id === idB) continue
      const origin = choreo.find((x) => x.id === d.id)!
      expect(d.waypoints.map((w) => w.t)).toEqual(origin.waypoints.map((w) => w.t))
    }
  })

  it('cap 截断：含末时刻 600 的舞者时，oracle 与规划器都只枚举 cap=0 域', () => {
    const rng = mulberry32(4242)
    const choreo: Choreography = [
      randomDancer(rng, 1, true),
      randomDancer(rng, 2, true),
      randomDancer(rng, 3, false)
    ]
    // 强制有空间被截断：前两人末时刻必为 590..600
    const res = planStagger({ choreography: choreo, dancerIds: [1, 2] })
    expect(res.caps[0]).toBe(600 - choreo[0]!.waypoints.at(-1)!.t)
    expect(res.caps[1]).toBe(600 - choreo[1]!.waypoints.at(-1)!.t)
    expect(res.caps[0]).toBeLessThanOrEqual(10)
    expect(res.caps[1]).toBeLessThanOrEqual(10)

    // oracle：只有 (0,0) 一个域点
    const base = analyzeChoreography(choreo)
    const baseHas = base.reports.length > 0
    if (baseHas) {
      const unselected = base.reports.some(
        (r) => ![1, 2].includes(r.aId) && ![1, 2].includes(r.bId)
      )
      if (!unselected) {
        expect(res.found).toBe(false)
      }
    } else if (res.found) {
      expect(res.delays).toEqual([0, 0])
    }
  })
})
