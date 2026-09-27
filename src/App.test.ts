import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createApp } from 'vue'
import App from './App.vue'
import { analyzeChoreography } from './core/choreography'
import { PRESETS } from './data/presets'
import type { AnalyzeRequest, AnalyzeResponse } from './workers/analysis.worker'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 可控假 Worker：手动决定每条请求何时回成功 / 失败 / 崩溃 */
class MockWorker {
  static instances: MockWorker[] = []
  static reset() {
    MockWorker.instances = []
  }
  onmessage: ((e: MessageEvent<AnalyzeResponse>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  posted: AnalyzeRequest[] = []
  constructor(_url: URL, _opts?: unknown) {
    MockWorker.instances.push(this)
  }
  postMessage(req: AnalyzeRequest) {
    this.posted.push(req)
  }
  terminate() {}
  replyLast(over: Partial<AnalyzeResponse>) {
    const req = this.posted.at(-1)!
    this.onmessage?.({ data: { version: req.version, ...over } } as MessageEvent<AnalyzeResponse>)
  }
  replyLastWithActualAnalysis() {
    const req = this.posted.at(-1)!
    this.onmessage?.({
      data: { version: req.version, report: analyzeChoreography(req.choreography) }
    } as MessageEvent<AnalyzeResponse>)
  }
  crash(message: string) {
    this.onerror?.({ message } as ErrorEvent)
  }
}

describe('App 页面集成（Worker 不可用时走同步兜底）', () => {
  let host: HTMLElement | null = null

  afterEach(() => {
    host?.remove()
    host = null
  })

  it('载入默认擦边场景并渲染报告、版本号', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    createApp(App).mount(host)

    await sleep(50)

    const text = host.textContent ?? ''
    expect(text).toContain('舞台轨迹检查')
    expect(text).toContain('冲突报告')
    expect(text).toContain('v1')
    // 默认 graze 预设半径均为 0：d²=4/17 > 0，无冲突
    expect(text).toContain('无冲突')

    // 时间滑块存在且范围为 0..600
    const range = host.querySelector('input[type="range"]') as HTMLInputElement
    expect(range).toBeTruthy()
    expect(range.min).toBe('0')
    expect(range.max).toBe('600')
  })
})

describe('App 双人错峰预演（同步精确分析）', () => {
  let host!: HTMLElement

  async function loadHeadOn(host: HTMLElement) {
    const preset = host.querySelector('.presets select') as HTMLSelectElement
    preset.value = 'head-on'
    preset.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('发现 1 条冲突'))
  }

  afterEach(() => {
    host.remove()
  })

  it('展示候选轨迹与延迟；应用后一次性移动路点并重新分析为零冲突', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    createApp(App).mount(host)
    await sleep(50)
    await loadHeadOn(host)

    const run = host.querySelector('[data-testid="stagger-run"]') as HTMLButtonElement
    expect(run.disabled).toBe(false)
    run.click()
    await vi.waitFor(() => expect(host.textContent).toContain('候选安全轨迹'))

    // 两个并列最小组合 (0,11)/(11,0) 按 ID 升序二元组选择前者。
    const previewText = host.textContent ?? ''
    expect(previewText).toContain('#1 甲：+0')
    expect(previewText).toContain('#2 乙：+11')
    expect(previewText).toContain('延迟之和 11')
    expect(previewText).toContain('候选完整分析：0 条冲突')
    expect(previewText).toContain('消除的原有冲突')
    expect(host.querySelector('[data-testid="stagger-preview"]')).toBeTruthy()

    // 候选轨迹使用时间后移后的路点；正式编辑表仍保持原时间。
    expect(host.textContent).toContain('预演舞者 #2 路点 1 · t=21')
    const timeInputs = Array.from(host.querySelectorAll('.dancer table td:first-child input')).map(
      (el) => (el as HTMLInputElement).value
    )
    expect(timeInputs).toEqual(['0', '10', '0', '10'])

    const apply = host.querySelector('[data-testid="stagger-apply"]') as HTMLButtonElement
    expect(apply.disabled).toBe(false)
    apply.click()

    await vi.waitFor(() => expect(host.textContent).toContain('无冲突'))
    expect(host.querySelector('[data-testid="stagger-preview"]')).toBeFalsy()
    const appliedTimeInputs = Array.from(
      host.querySelectorAll('.dancer table td:first-child input')
    ).map((el) => (el as HTMLInputElement).value)
    expect(appliedTimeInputs).toEqual(['0', '10', '11', '21'])
  })

  it('全部合法延迟仍有冲突时明确显示无解', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    createApp(App).mount(host)
    await sleep(50)

    const preset = host.querySelector('.presets select') as HTMLSelectElement
    preset.value = 'ensemble'
    preset.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('发现 7 条冲突'))

    const first = host.querySelector('[data-testid="stagger-first"]') as HTMLSelectElement
    first.value = '1'
    first.dispatchEvent(new Event('change', { bubbles: true }))
    const second = host.querySelector('[data-testid="stagger-second"]') as HTMLSelectElement
    second.value = '3'
    second.dispatchEvent(new Event('change', { bubbles: true }))
    ;(host.querySelector('[data-testid="stagger-run"]') as HTMLButtonElement).click()

    await vi.waitFor(() => expect(host.textContent).toContain('无安全组合'))
    expect(host.textContent).toContain('1 个合法延迟组合')
  })
})

describe('App 页面集成 · 失败状态、重试与重编辑恢复（可控 Worker 计时）', () => {
  let host: HTMLElement
  let savedWorker: typeof globalThis.Worker

  beforeEach(() => {
    MockWorker.reset()
    savedWorker = globalThis.Worker
    globalThis.Worker = MockWorker as unknown as typeof globalThis.Worker
    host = document.createElement('div')
    document.body.appendChild(host)
  })
  afterEach(() => {
    host.remove()
    globalThis.Worker = savedWorker
  })

  const safeReport = () => ({
    dancerCount: 2,
    segmentPairCount: 1,
    reports: []
  })

  it('Worker 报错后明确显示失败与重试入口；重试得到新结果；重新编辑恢复正常', async () => {
    createApp(App).mount(host)
    await vi.waitFor(() => expect(MockWorker.instances.length).toBeGreaterThan(0))
    expect(MockWorker.instances[0]!.posted.at(-1)!.version).toBe(1)

    // 首版计算以错误响应返回：界面不能停在“分析中”，要有失败状态和重试
    MockWorker.instances[0]!.replyLast({ error: 'boom' })
    await vi.waitFor(() => expect(host.textContent).toContain('分析失败'))
    expect(host.textContent).not.toContain('分析中')
    const retryBtn = host.querySelector('.report button') as HTMLButtonElement
    expect(retryBtn).toBeTruthy()

    // 重试：新版本 v2 正常返回安全结果
    retryBtn.click()
    await vi.waitFor(() =>
      expect(MockWorker.instances[0]!.posted.at(-1)!.version).toBe(2)
    )
    MockWorker.instances[0]!.replyLast({ report: safeReport() as never })
    await vi.waitFor(() => expect(host.textContent).toContain('无冲突'))
    expect(host.textContent).not.toContain('分析失败')

    // 再次编辑：正常进入分析中并由新 Worker 事件出结果
    const radiusInput = host.querySelector('.r-input') as HTMLInputElement
    radiusInput.value = '5'
    radiusInput.dispatchEvent(new Event('input', { bubbles: true }))
    // 60ms 防抖窗口内：已是 v2 作废后的 v3“分析中”，失败状态同步消失
    await vi.waitFor(() => expect(host.textContent).toContain('v3'))
    expect(host.textContent).not.toContain('分析失败')
    expect(host.textContent).toContain('分析中')
    await vi.waitFor(() =>
      expect(MockWorker.instances[0]!.posted.at(-1)!.version).toBe(3)
    )
    MockWorker.instances[0]!.replyLast({ report: safeReport() as never })
    await vi.waitFor(() => expect(host.textContent).toContain('无冲突'))
  })

  it('Worker 进程崩溃：重建 Worker 完成重试，且不会一直卡在分析中', async () => {
    createApp(App).mount(host)
    await vi.waitFor(() => expect(MockWorker.instances.length).toBe(1))
    MockWorker.instances[0]!.crash('process died')
    await vi.waitFor(() => expect(host.textContent).toContain('分析失败'))
    expect(host.textContent).toContain('process died')

    ;(host.querySelector('.report button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(MockWorker.instances.length).toBe(2))
    MockWorker.instances[1]!.replyLast({ report: safeReport() as never })
    await vi.waitFor(() => expect(host.textContent).toContain('无冲突'))
  })

  it('预演后编辑、旧 Worker 迟到回复或分析失败都会拒绝旧方案', async () => {
    createApp(App).mount(host)
    await vi.waitFor(() => expect(MockWorker.instances.length).toBe(1))
    MockWorker.instances[0]!.replyLastWithActualAnalysis()
    await vi.waitFor(() => expect(host.textContent).toContain('无冲突'))

    const preset = host.querySelector('.presets select') as HTMLSelectElement
    preset.value = 'head-on'
    preset.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(MockWorker.instances[0]!.posted.at(-1)!.version).toBe(2))
    MockWorker.instances[0]!.replyLastWithActualAnalysis()
    await vi.waitFor(() => expect(host.textContent).toContain('发现 1 条冲突'))

    ;(host.querySelector('[data-testid="stagger-run"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.textContent).toContain('候选安全轨迹'))
    const apply = () => host.querySelector('[data-testid="stagger-apply"]') as HTMLButtonElement
    expect(apply().disabled).toBe(false)

    const radiusInput = host.querySelector('.r-input') as HTMLInputElement
    radiusInput.value = '2'
    radiusInput.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('预演已过期'))
    expect(apply().disabled).toBe(true)

    // v2 的旧 Worker 成功回复再迟到，也必须被版本协议拒绝，不能复活旧方案。
    MockWorker.instances[0]!.onmessage?.({
      data: { version: 2, report: analyzeChoreography(PRESETS[1]!.data) }
    } as MessageEvent<AnalyzeResponse>)
    await sleep(0)
    expect(host.textContent).toContain('预演已过期')
    expect(apply().disabled).toBe(true)

    // 当前 v3 Worker 分析失败：旧方案仍不可应用，报告进入明确失败状态。
    MockWorker.instances[0]!.crash('candidate worker died')
    await vi.waitFor(() => expect(host.textContent).toContain('分析失败'))
    expect(apply().disabled).toBe(true)
  })
})
