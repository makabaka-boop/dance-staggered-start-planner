import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useCollisionAnalysis } from './useCollisionAnalysis'
import { PRESETS } from '../data/presets'
import { analyzeChoreography } from '../core/choreography'
import { planStagger } from '../core/stagger'
import type { Choreography } from '../core/types'

// 让 planStagger / analyzeChoreography 可按需替换为抛错 / 自定义实现
vi.mock('../core/stagger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/stagger')>()
  return { ...actual, planStagger: vi.fn(actual.planStagger) }
})
vi.mock('../core/choreography', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/choreography')>()
  return { ...actual, analyzeChoreography: vi.fn(actual.analyzeChoreography) }
})

const planMock = vi.mocked(planStagger)
const analyzeMock = vi.mocked(analyzeChoreography)
const realPlan = planMock.getMockImplementation()!
const realAnalyze = analyzeMock.getMockImplementation()!

/**
 * 双人错峰预演的版本 / 序号协议（jsdom 无 Worker，走主线程 setTimeout 兜底）：
 * - 预演不改正式编排、不增 version、不清正常判碰报告；
 * - 任何编辑都让旧方案不可应用（过期拒绝）；
 * - 同版本内只有最新一次预演的回复被接受；
 * - 应用时核对版本与快照，一次性移动路点并由 watch 触发重分析；
 * - 计算失败 / 选中非法 / 校验失败都有明确行为。
 */
describe('useCollisionAnalysis · 双人错峰预演协议', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    planMock.mockImplementation(realPlan)
    analyzeMock.mockImplementation(realAnalyze)
  })
  afterEach(() => vi.useRealTimers())

  const flush = () => vi.advanceTimersByTime(10)

  /** 端点相接预设：推迟舞者2 1 个单位即安全，方案 (0,1) */
  function endpointTouch(): Choreography {
    return JSON.parse(JSON.stringify(PRESETS[2].data))
  }

  it('预演完成：返回方案但不改动正式编排，正常判碰报告保持原样', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()
    const baseReport = ua.report.value
    expect(baseReport?.reports.length).toBe(1)
    const v0 = ua.version.value

    const r = ua.requestStagger([2, 1])
    expect(r.ok).toBe(true)
    expect(ua.planComputing.value).toBe(true)
    // 预演不动 version、不动正常报告
    expect(ua.version.value).toBe(v0)
    expect(ua.report.value).toBe(baseReport)

    flush()
    expect(ua.planComputing.value).toBe(false)
    expect(ua.planError.value).toBeNull()
    const ap = ua.activePlan.value
    expect(ap).not.toBeNull()
    expect(ap!.version).toBe(v0)
    expect(ap!.dancerIds).toEqual([1, 2])
    if (!ap!.plan.found) throw new Error('expected found plan')
    expect(ap!.plan.delays).toEqual([0, 1])
    // 正式编排仍未改
    expect(c[1]!.waypoints[0]!.t).toBe(10)
    expect(ua.report.value).toBe(baseReport)
  })

  it('同版本连续发起：旧请求的迟到回复按 seq 丢弃，只显示最新方案', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()

    ua.requestStagger([1, 2]) // seq 1
    // 尚未回调时立刻改选（本场景两人组合相同，仅验证 seq 作废）
    const first = ua.requestStagger([1, 2]) // seq 2
    expect(first.ok).toBe(true)
    expect(ua.activePlan.value).toBeNull()
    flush() // 两次兜底任务都在本拍执行；seq1 必须被丢弃
    expect(ua.activePlan.value).not.toBeNull()
    if (!ua.activePlan.value!.plan.found) throw new Error('expected found plan')
    expect(ua.activePlan.value!.plan.delays).toEqual([0, 1])
  })

  it('方案可应用：核对版本与快照后一次性移动路点；应用后重分析为零冲突', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()
    ua.requestStagger([1, 2])
    flush()
    expect(ua.planApplicable.value).toBe(true)

    const ok = ua.applyPlan()
    expect(ok).toBe(true)
    // 一次性移动：舞者2 全部路点 +1，舞者1 不动
    expect(c[0]!.waypoints.map((w) => w.t)).toEqual([0, 10])
    expect(c[1]!.waypoints.map((w) => w.t)).toEqual([11, 21])
    // 应用后预演立即清空
    expect(ua.activePlan.value).toBeNull()
    expect(ua.planApplicable.value).toBe(false)
    // 应用本身不触发 invalidate（由外部 watch → scheduleRun 负责）；模拟该 watch
    ua.scheduleRun()
    vi.advanceTimersByTime(61) // 60ms 防抖 + 0ms 兜底
    expect(ua.report.value?.reports).toEqual([])
  })

  it('过期拒绝：方案产生后任何编辑都使方案不可应用', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()
    ua.requestStagger([1, 2])
    flush()
    expect(ua.planApplicable.value).toBe(true)

    // 模拟一次普通编辑（半径变化）：同步作废预演
    c[0]!.radius += 1
    ua.scheduleRun()
    expect(ua.activePlan.value).toBeNull()
    expect(ua.planComputing.value).toBe(false)
    expect(ua.applyPlan()).toBe(false)

    vi.advanceTimersByTime(61) // 防抖 + 兜底，得到新版本正常报告
    // 半径变大后端点冲突依旧，正常报告不受预演影响
    expect(ua.report.value?.reports.length).toBe(1)
  })

  it('过期拒绝：方案版本停留在旧 version（外部未作废直接改快照）时 applyPlan 拒绝', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()
    ua.requestStagger([1, 2])
    flush()
    // 直接改编排但不调用 scheduleRun（模拟“快照签名不符”的防护路径）
    c[0]!.waypoints[0]!.x = 3
    expect(ua.planApplicable.value).toBe(false)
    expect(ua.applyPlan()).toBe(false)
  })

  it('分析中 / 校验失败时：请求被拒或旧方案不可应用', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    // 初始 run 后未 flush：计算中
    ua.run()
    expect(ua.requestStagger([1, 2]).ok).toBe(false)

    vi.advanceTimersByTime(10)
    expect(ua.requestStagger([1, 2]).ok).toBe(true)
    flush()

    // 校验失败：不可发起，已有方案作废
    c.pop()
    ua.scheduleRun()
    expect(ua.requestStagger([1, 2]).ok).toBe(false)
    expect(ua.activePlan.value).toBeNull()
  })

  it('选中舞者非法（重复 / 不存在）：拒绝发起', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()
    expect(ua.requestStagger([1, 1]).ok).toBe(false)
    expect(ua.requestStagger([1, 9]).ok).toBe(false)
    expect(ua.planComputing.value).toBe(false)
  })

  it('规划器抛错：进入明确预演失败状态，不影响正常报告', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()
    const baseReport = ua.report.value

    planMock.mockImplementationOnce(() => {
      throw new Error('planner boom')
    })
    ua.requestStagger([1, 2])
    flush()
    expect(ua.planComputing.value).toBe(false)
    expect(ua.planError.value).toBe('planner boom')
    expect(ua.activePlan.value).toBeNull()
    // 正常判碰报告保持原样
    expect(ua.report.value).toBe(baseReport)

    // 重新预演：错误清除、正常出方案
    ua.requestStagger([1, 2])
    flush()
    expect(ua.planError.value).toBeNull()
    expect(ua.activePlan.value?.plan.found).toBe(true)
  })

  it('无解方案：activePlan 承载 found=false，不可应用；消除信息仍展示', () => {
    // 两人末时刻均为 600 且冲突 ⇒ cap 均 0，无解
    const c: Choreography = [
      {
        id: 1,
        name: 'A',
        radius: 1,
        waypoints: [
          { t: 590, x: 0, y: 0 },
          { t: 600, x: 10, y: 0 }
        ]
      },
      {
        id: 2,
        name: 'B',
        radius: 1,
        waypoints: [
          { t: 590, x: 10, y: 0 },
          { t: 600, x: 0, y: 0 }
        ]
      }
    ]
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()
    ua.requestStagger([1, 2])
    flush()
    expect(ua.planError.value).toBeNull()
    expect(ua.activePlan.value).not.toBeNull()
    expect(ua.activePlan.value!.plan.found).toBe(false)
    expect(ua.planApplicable.value).toBe(false)
    expect(ua.applyPlan()).toBe(false)
  })

  it('discardPlan：清除在途与已生效预演，正常分析不受影响', () => {
    const c = endpointTouch()
    const ua = useCollisionAnalysis(() => c)
    ua.run()
    flush()
    ua.requestStagger([1, 2])
    expect(ua.planComputing.value).toBe(true)
    ua.discardPlan()
    expect(ua.planComputing.value).toBe(false)
    expect(ua.activePlan.value).toBeNull()
    // 迟到的兜底回调到达后也不得落地
    flush()
    expect(ua.activePlan.value).toBeNull()
    expect(ua.report.value).not.toBeNull()
  })
})
