import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createApp } from 'vue'
import App from './App.vue'
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
})

describe('App 页面 · 双人错峰预演（主线程兜底：预演、过期拒绝、应用后零冲突）', () => {
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })
  afterEach(() => {
    host.remove()
  })

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** 用预设下拉切换场景 */
  async function loadPreset(label: string) {
    const select = host.querySelector('.presets select') as HTMLSelectElement
    const opt = [...select.options].find((o) => o.textContent?.includes(label))!
    select.value = opt.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(120)
  }

  /** 点开双人错峰预演面板，选好两人并点击“预演” */
  async function runStagger(aId: number, bId: number) {
    const panel = host.querySelector('.stagger')!
    const [selA, selB] = panel.querySelectorAll('select')
    ;(selA as HTMLSelectElement).value = String(aId)
    ;(selA as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }))
    ;(selB as HTMLSelectElement).value = String(bId)
    ;(selB as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }))
    ;[...panel.querySelectorAll('button')].find((b) => b.textContent?.includes('预演'))!.click()
    await sleep(40)
  }

  it('预演：端点相接场景找到方案，展示候选轨迹与延迟；不改正式编排与正常报告', async () => {
    createApp(App).mount(host)
    await loadPreset('端点相接')

    // 正式报告：1 条冲突
    expect(host.textContent).toContain('1 条冲突线段')
    const dancer2FirstT = () =>
      (host.querySelectorAll('.dancer')[1]!.querySelector('tbody input') as HTMLInputElement).value
    expect(dancer2FirstT()).toBe('10') // 舞者2 首路点时刻仍是 10

    await runStagger(1, 2)

    // 方案展示：后移 (0, 1)、和 1、消除 1 条
    const panelText = host.querySelector('.stagger')!.textContent!
    expect(panelText).toContain('找到安全方案')
    expect(panelText).toContain('延迟之和')
    expect(panelText).toContain('消除原有冲突')
    expect(panelText).toContain('1 条')

    // 候选轨迹覆盖层：虚线方框标记
    const previewBoxes = host.querySelectorAll('.stage-svg rect')
    expect(previewBoxes.length).toBeGreaterThan(0)
    expect(host.textContent).toContain('错峰预演候选轨迹')

    // 正式编排未被改动
    expect(dancer2FirstT()).toBe('10')
    // 正常判碰报告保持原样，仍有 1 条
    expect(host.textContent).toContain('1 条冲突线段')
    // 应用按钮可用
    const applyBtn = [...host.querySelectorAll('.stagger button')].find((b) =>
      b.textContent?.includes('应用到正式编排')
    ) as HTMLButtonElement
    expect(applyBtn).toBeTruthy()
    expect(applyBtn.disabled).toBe(false)
  })

  it('过期拒绝：方案产生后再编辑，旧方案标记不可应用；重新预演后可正常应用且零冲突', async () => {
    createApp(App).mount(host)
    await loadPreset('端点相接')
    await runStagger(1, 2)
    expect(host.querySelector('.stagger')!.textContent).toContain('找到安全方案')

    // 应用前编辑（改舞者1 半径）：方案立即过期
    const radiusInputs = host.querySelectorAll('.r-input')
    ;(radiusInputs[0] as HTMLInputElement).value = '2'
    ;(radiusInputs[0] as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)

    const panelText = () => host.querySelector('.stagger')!.textContent!
    expect(panelText()).not.toContain('找到安全方案')
    // 重新预演：编辑后的编排（端点相接，半径 2）仍然冲突、仍可被 +1 错开
    await runStagger(1, 2)
    expect(panelText()).toContain('找到安全方案')
    const applyBtn = [...host.querySelectorAll('.stagger button')].find((b) =>
      b.textContent?.includes('应用到正式编排')
    ) as HTMLButtonElement
    expect(applyBtn.disabled).toBe(false)

    // 应用：一次性移动路点并重新分析
    applyBtn.click()
    await sleep(120)

    // 舞者2 路点整体 +1：首路点 t 现在应为 11（原 10）
    const secondDancerFirstT = (
      host.querySelectorAll('.dancer')[1]!.querySelector('tbody input') as HTMLInputElement
    ).value
    expect(secondDancerFirstT).toBe('11')
    // 舞者1 不动
    const firstDancerFirstT = (
      host.querySelectorAll('.dancer')[0]!.querySelector('tbody input') as HTMLInputElement
    ).value
    expect(firstDancerFirstT).toBe('0')

    // 应用后零冲突
    expect(host.textContent).toContain('无冲突')
    // 预演面板回到空闲态（无方案、无候选覆盖层）
    expect(host.querySelector('.stagger')!.textContent).not.toContain('找到安全方案')
    expect(host.textContent).not.toContain('错峰预演候选轨迹')
  })

  it('无解：无法消除时给出明确无解说明且不可应用；正式报告不变', async () => {
    createApp(App).mount(host)
    await sleep(80)

    // 直接构造“两人末时刻 600 且冲突”的无解编排：改默认场景
    // 默认 graze 是 2 人，把两人末时刻都改为 600、路径改为反向相遇、半径各 1
    const dancers = host.querySelectorAll('.dancer')
    const setRow = (dancerEl: Element, row: number, t: string, x: string, y: string) => {
      const inputs = dancerEl.querySelectorAll('tbody tr')[row]!.querySelectorAll('input')
      const setVal = (el: Element, v: string) => {
        const i = el as HTMLInputElement
        i.value = v
        i.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal(inputs[0]!, t)
      setVal(inputs[1]!, x)
      setVal(inputs[2]!, y)
    }
    const radius = host.querySelectorAll('.r-input')
    ;(radius[0] as HTMLInputElement).value = '1'
    ;(radius[0] as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }))
    ;(radius[1] as HTMLInputElement).value = '1'
    ;(radius[1] as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }))
    setRow(dancers[0]!, 0, '590', '0', '0')
    setRow(dancers[0]!, 1, '600', '10', '0')
    setRow(dancers[1]!, 0, '590', '10', '0')
    setRow(dancers[1]!, 1, '600', '0', '0')
    await sleep(120)
    expect(host.textContent).toContain('条冲突')

    await runStagger(1, 2)
    const panelText = host.querySelector('.stagger')!.textContent!
    expect(panelText).toContain('无解')
    expect(panelText).toContain('合法延迟范围内没有任何组合')
    // 没有应用按钮 / 不可应用
    const applyBtn = [...host.querySelectorAll('.stagger button')].find((b) =>
      b.textContent?.includes('应用到正式编排')
    )
    expect(applyBtn).toBeUndefined()
    // 正式报告保持原样
    expect(host.textContent).toContain('条冲突')
  })
})
