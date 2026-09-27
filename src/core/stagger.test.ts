import { describe, expect, it } from 'vitest'
import { analyzeChoreography } from './choreography'
import {
  STAGGER_MAX_DELAY,
  applyStaggerPreview,
  planTwoDancerStagger,
  staggerLegalBounds,
  withUniformDelays
} from './stagger'
import type { Choreography } from './types'

function dancer(id: number, waypoints: [number, number, number][], radius = 0): Choreography[number] {
  return {
    id,
    name: `D${id}`,
    radius,
    waypoints: waypoints.map(([t, x, y]) => ({ t, x, y }))
  }
}

/**
 * 测试预言机：对小规模延迟范围做完整枚举。
 * 排序键与规格一致：先延迟和，再按 ID 升序的延迟二元组字典序。
 */
function oracle(c: Choreography, ids: [number, number], bounds: [number, number]) {
  const choices: { ids: [number, number]; delays: [number, number] }[] = []
  for (let d0 = 0; d0 <= bounds[0]; d0++) {
    for (let d1 = 0; d1 <= bounds[1]; d1++) {
      choices.push({ ids, delays: [d0, d1] })
    }
  }
  choices.sort((a, b) => {
    const sa = a.delays[0] + a.delays[1]
    const sb = b.delays[0] + b.delays[1]
    if (sa !== sb) return sa - sb
    if (a.delays[0] !== b.delays[0]) return a.delays[0] - b.delays[0]
    return a.delays[1] - b.delays[1]
  })

  for (const choice of choices) {
    const delays = new Map([
      [ids[0], choice.delays[0]],
      [ids[1], choice.delays[1]]
    ])
    const candidate = withUniformDelays(c, delays)
    const report = analyzeChoreography(candidate)
    if (report.reports.length === 0) return { solution: choice, legalCount: choices.length }
  }
  return { solution: null, legalCount: choices.length }
}

describe('双人错峰预演', () => {
  it('端点相接：延迟 (0,1) 与 (1,0) 并列时按 ID 升序二元组裁决为 (0,1)', () => {
    // A t[0,10] 0->10；B t[10,20] 10->20，t=10 在 (10,0) 零长度相接。
    const c: Choreography = [
      dancer(1, [
        [0, 0, 0],
        [10, 10, 0]
      ]),
      dancer(2, [
        [10, 10, 0],
        [20, 20, 0]
      ])
    ]
    const baseline = analyzeChoreography(c)
    expect(baseline.reports).toHaveLength(1)

    const res = planTwoDancerStagger(c, 1, 2, 1, baseline)
    expect(res.status).toBe('solution')
    if (res.status !== 'solution') return
    expect(res.preview.dancerIds).toEqual([1, 2])
    expect(res.preview.delays).toEqual([0, 1])
    expect(res.preview.report.reports).toHaveLength(0)
    expect(res.preview.checkedCombinationCount).toBe(441)
    expect(res.preview.eliminated[0]?.pair.conflicts).toHaveLength(1)
    expect(res.preview.legalCombinationCount).toBe(441)

    // 反向选择仍规范化为 ID 升序。
    const reversed = planTwoDancerStagger(c, 2, 1, 1, baseline)
    expect(reversed.status).toBe('solution')
    if (reversed.status === 'solution') expect(reversed.preview.delays).toEqual([0, 1])

    // 预言机对全部 21x21 合法延迟枚举，结论一致。
    const o = oracle(c, [1, 2], [20, 20])
    expect(o.solution?.delays).toEqual([0, 1])
  })

  it('擦边半径冲突：规划结果与全枚举预言机一致，并保留坐标/半径/相对节奏', () => {
    // graze 预设：最近 d²=4/17，半径和 2 时阈值 4，边界内含冲突。
    const c: Choreography = [
      dancer(
        1,
        [
          [0, 0, 0],
          [10, 10, 0]
        ],
        1
      ),
      dancer(
        2,
        [
          [0, 0, 2],
          [10, 0, -38]
        ],
        1
      )
    ]
    const baseline = analyzeChoreography(c)
    expect(baseline.reports.length).toBeGreaterThan(0)

    const res = planTwoDancerStagger(c, 1, 2, 7, baseline)
    const o = oracle(c, [1, 2], [20, 20])
    expect(res.status).toBe(o.solution ? 'solution' : 'no-solution')
    if (res.status === 'solution' && o.solution) {
      expect(res.preview.delays).toEqual(o.solution.delays)
      const delayed = res.preview.candidate.find((d) => d.id === 1)!
      const original = c.find((d) => d.id === 1)!
      expect(delayed.radius).toBe(original.radius)
      delayed.waypoints.forEach((w, i) => {
        expect([w.x, w.y]).toEqual([original.waypoints[i].x, original.waypoints[i].y])
        expect(w.t).toBe(original.waypoints[i].t + res.preview.delays[0])
      })
      expect(res.preview.sourceVersion).toBe(7)
    }
  })

  it('擦边半径冲突：延迟 10 时恰为端点相接，全局最小和优先选择另一人的 +4', () => {
    // 相对速度 (4,1)、垂直距离 2；d=10 时最近点恰好落在重叠端点且距离=半径和。
    const c: Choreography = [
      dancer(
        1,
        [
          [0, 0, 0],
          [10, 0, 0]
        ],
        1
      ),
      dancer(
        2,
        [
          [0, -1, 0],
          [10, 7, 2]
        ],
        1
      )
    ]
    const baseline = analyzeChoreography(c)
    expect(baseline.reports).toHaveLength(1)
    const res = planTwoDancerStagger(c, 1, 2, 1, baseline)
    expect(res.status).toBe('solution')
    if (res.status !== 'solution') return
    expect(res.preview.delays).toEqual([4, 0])

    const boundary = withUniformDelays(c, new Map([[2, 10]]))
    expect(analyzeChoreography(boundary).reports.length).toBe(1)
    const safe = withUniformDelays(c, new Map([[1, 4]]))
    expect(analyzeChoreography(safe).reports.length).toBe(0)
  })

  it('排序规则在大量随机小编排上与独立预言机一致', () => {
    let seed = 246813579
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    const coord = () => (rnd() % 21) - 10
    for (let k = 0; k < 40; k++) {
      const c: Choreography = [
        dancer(1, [
          [0, coord(), coord()],
          [rnd() % 6 + 2, coord(), coord()]
        ], rnd() % 3),
        dancer(2, [
          [0, coord(), coord()],
          [rnd() % 6 + 2, coord(), coord()]
        ], rnd() % 3)
      ]
      // 两人末端均不超过 7，故 0..20 全部合法。
      const got = planTwoDancerStagger(c, 1, 2, 1, analyzeChoreography(c))
      const o = oracle(c, [1, 2], [20, 20])
      if (o.solution) {
        expect(got.status).toBe('solution')
        if (got.status === 'solution') expect(got.preview.delays).toEqual(o.solution.delays)
      } else {
        expect(got.status).toBe('no-solution')
      }
    }
  })

  it('原已安全时最小解为 0,0，并确认不新增冲突', () => {
    const c: Choreography = [
      dancer(1, [
        [0, 0, 0],
        [10, 0, 0]
      ]),
      dancer(2, [
        [0, 50, 0],
        [10, 60, 0]
      ])
    ]
    const res = planTwoDancerStagger(c, 1, 2, 1, analyzeChoreography(c))
    expect(res.status).toBe('solution')
    if (res.status !== 'solution') return
    expect(res.preview.delays).toEqual([0, 0])
    expect(res.preview.eliminated).toHaveLength(0)
    expect(res.preview.legalCombinationCount).toBe(441)
  })

  it('越界：末端 t=590 时枚举上界为 +10；0..10 全部仍冲突则明确无解', () => {
    const c: Choreography = [
      dancer(
        1,
        [
          [580, 0, 0],
          [590, 10, 0]
        ],
        1
      ),
      dancer(
        2,
        [
          [580, 10, 0],
          [590, 0, 0]
        ],
        1
      )
    ]
    expect(staggerLegalBounds(c, [1, 2])).toEqual([10, 10])
    const res = planTwoDancerStagger(c, 1, 2, 1, analyzeChoreography(c))
    expect(res.status).toBe('no-solution')
    if (res.status !== 'no-solution') return
    expect(res.result.legalCombinationCount).toBe(121)

    // 所有合法候选末端 <=600；+11 因越过 600 不被允许（否则恰好可以避开）。
    const delayed = withUniformDelays(c, new Map([[1, 11]]))
    expect(delayed[0]!.waypoints.at(-1)!.t).toBe(601)
    const o = oracle(c, [1, 2], [10, 10])
    expect(o.solution).toBeNull()
  })

  it('末端在 600 上界的舞者只能延迟 0，组合数正确', () => {
    const c: Choreography = [
      dancer(
        1,
        [
          [595, 0, 0],
          [600, 5, 0]
        ],
        1
      ),
      dancer(
        2,
        [
          [580, -95, 0],
          [590, 5, 0]
        ],
        1
      )
    ]
    const res = planTwoDancerStagger(c, 1, 2, 1, analyzeChoreography(c))
    expect(res.status).toBe('solution')
    if (res.status !== 'solution') return
    expect(res.preview.legalCombinationCount).toBe(11)
    expect(res.preview.delays[0]).toBe(0)
    expect(res.preview.candidate.every((d) => d.waypoints.at(-1)!.t <= 600)).toBe(true)
  })

  it('未选舞者之间存在冲突时报告无法由所选两人消除', () => {
    // 2 与 3 在 t=5 重合；只选择 1、2 不应把它当作可消除冲突。
    const c: Choreography = [
      dancer(1, [
        [0, -50, 0],
        [10, -40, 0]
      ]),
      dancer(2, [
        [0, 0, 0],
        [10, 0, 0]
      ]),
      dancer(3, [
        [0, 0, 0],
        [10, 0, 0]
      ]),
      dancer(4, [
        [0, -80, 0],
        [10, -70, 0]
      ])
    ]
    const res = planTwoDancerStagger(c, 1, 4, 1, analyzeChoreography(c))
    expect(res.status).toBe('no-solution')
    if (res.status !== 'no-solution') return
    expect(res.result.persistentPairs).toHaveLength(1)
    expect(res.result.persistentPairs[0]).toMatchObject({ aId: 2, bId: 3 })
  })

  it('应用方案一次性只移动所选路点时间，并保持其余舞者不变', () => {
    const c: Choreography = [
      dancer(1, [
        [0, 0, 0],
        [10, 10, 0]
      ]),
      dancer(2, [
        [10, 10, 0],
        [20, 20, 0]
      ])
    ]
    const before = JSON.stringify(c[1])
    applyStaggerPreview(c, {
      dancerIds: [1, 2],
      delays: [0, 1]
    })
    expect(c[0]!.waypoints.map((w) => w.t)).toEqual([0, 10])
    expect(c[1]!.waypoints.map((w) => w.t)).toEqual([11, 21])
    expect(JSON.stringify(c[1]!.waypoints.map((w) => ({ x: w.x, y: w.y })))).toBe(
      JSON.stringify([
        { x: 10, y: 0 },
        { x: 20, y: 0 }
      ])
    )
    // 未选舞者（此处校验第二条只加了自身延迟）坐标未变，时间整体后移 1。
    expect(before).not.toBe(JSON.stringify(c[1]))
  })

  it('拒绝相同舞者、非法版本', () => {
    const c: Choreography = [
      dancer(1, [[0, 0, 0]]),
      dancer(2, [[0, 0, 0]])
    ]
    const bad = planTwoDancerStagger(c, 1, 1, 1)
    expect(bad.status).toBe('invalid')
    const badVersion = planTwoDancerStagger(
      [
        dancer(1, [
          [0, 0, 0],
          [10, 1, 0]
        ]),
        dancer(2, [
          [0, 2, 0],
          [10, 3, 0]
        ])
      ],
      1,
      2,
      0
    )
    expect(badVersion.status).toBe('invalid')
  })

  it('最大延迟常量为 20', () => {
    expect(STAGGER_MAX_DELAY).toBe(20)
  })
})
