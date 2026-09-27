import { computed, ref, shallowRef, getCurrentInstance, onBeforeUnmount } from 'vue'
import { analyzeChoreography, validateChoreography, type ValidationIssue } from '../core/choreography'
import { planStagger, type StaggerPlan } from '../core/stagger'
import type { AnalysisReportDTO, Choreography } from '../core/types'
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  StaggerRequestMessage,
  StaggerResponse
} from '../workers/analysis.worker'

/** 等待计算的一版请求：版本号与发起瞬间的编排快照永远绑定在一起 */
interface PendingRequest {
  version: number
  snapshot: Choreography
}

/** 等待结果的一次错峰预演：版本 + 序号 + 快照签名共同决定是否仍可采用 */
interface PendingStagger {
  version: number
  seq: number
  snapshot: Choreography
  dancerIds: [number, number]
  snapshotSignature: string
}

/** 已生效的预演方案：携带产生它的编排版本与快照签名，供应用前核对 */
export interface ActiveStaggerPlan {
  version: number
  snapshotSignature: string
  dancerIds: [number, number]
  plan: StaggerPlan
}

/**
 * 分析编排的版本一致性由以下机制保证：
 * - 每次编辑在渲染前同步 `invalidate`：version++、清报告、置计算中，
 *   于是拖动后到重分析完成之间，旧碰撞标记 / 选中证据绝不会继续盖在新路径上，
 *   旧 Worker 的迟到结果也会因版本号不再相等而被丢弃；
 * - 发起时对编排做一次深拷贝快照，Worker / 主线程兜底都只计算该快照，
 *   杜绝“读到后来的路径却挂上先前版本号”；
 * - 计算失败有明确 error 状态（不会一直停在“分析中”），可 retry；
 * - 再次编辑会清掉错误并重新走正常分析。
 *
 * 双人错峰预演（stagger）走同一套 Worker，但：
 * - 预演不改正式编排、不动 version、不清正常判碰报告（旧正常报告保持原样）；
 * - 同版本内用递增 seq 丢弃更早预演的迟到回复；
 * - 任何编辑（version 变化）、旧 Worker 回复或分析失败都会让旧方案不可应用；
 * - 应用时核对方案版本与快照签名，一次性移动路点后触发正常重分析。
 *
 * 优先使用 Web Worker，环境不支持时在主线程同步计算（如 Vitest）。
 */
export function useCollisionAnalysis(choreographyRef: () => Choreography) {
  const version = ref(0)
  const report = shallowRef<AnalysisReportDTO | null>(null)
  const issues = ref<ValidationIssue[]>([])
  const computing = ref(false)
  const error = ref<string | null>(null)

  // ---- 双人错峰预演状态 ----
  /** 已完成并可展示 / 应用的方案（预演，不改正式编排） */
  const activePlan = shallowRef<ActiveStaggerPlan | null>(null)
  const planComputing = ref(false)
  const planError = ref<string | null>(null)

  let worker: Worker | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let pending: PendingRequest | null = null
  let pendingPlan: PendingStagger | null = null
  /** 预演请求序号：同版本内只有最新一次的回复会被接受 */
  let staggerSeq = 0
  /** 最近一次作废后的最新版本（可能尚未发出计算） */
  let liveVersion = 0
  /** 最近一次真正交给计算方（Worker / 兜底）的版本 */
  let postedVersion = 0
  let disposed = false

  function createWorker(): Worker | null {
    try {
      const w = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
        type: 'module'
      })
      w.onmessage = (e: MessageEvent<AnalyzeResponse | StaggerResponse>) => {
        const data = e.data
        if (data.kind === 'stagger') {
          acceptStaggerResponse(data)
          return
        }
        // 必须同时是“最新已作废版本”和“最新已发出请求”：
        // 防抖间隔内 live 已超前 posted 时，旧在途请求的迟到成功 / 失败一律丢弃
        if (
          data.version !== liveVersion ||
          data.version !== postedVersion ||
          !pending
        )
          return
        pending = null
        computing.value = false
        if (data.error) {
          error.value = data.error
        } else {
          report.value = data.report ?? null
        }
      }
      w.onerror = (e) => {
        // Worker 脚本加载失败 / 进程崩溃等：死掉的 Worker 一律摘除，
        // 后续 startCompute 会惰性重建。
        // 若已有更新版本在等待计算（防抖中），当前失败结果直接忽略；
        // 否则把最新版本明确标记为失败，供界面展示与重试。
        killWorker()
        const planWasPending = !!pendingPlan
        if (liveVersion === postedVersion && pending) {
          failPending(e.message || '分析工作进程发生错误')
        }
        // 崩溃同样使在途预演进入明确失败状态（共享 Worker，与判碰请求无关地死亡）
        if (planWasPending) failPlanPending(e.message || '预演工作进程发生错误')
      }
      return w
    } catch {
      return null
    }
  }

  function killWorker() {
    worker?.terminate()
    worker = null
  }

  /** 标记当前在途请求失败（Worker 已由调用方摘除） */
  function failPending(message: string) {
    pending = null
    if (disposed) return
    computing.value = false
    error.value = message
  }

  function failPlanPending(message: string) {
    const p = pendingPlan
    pendingPlan = null
    if (!p || disposed) return
    planComputing.value = false
    planError.value = message
    activePlan.value = null
  }

  function acceptStaggerResponse(data: StaggerResponse) {
    const p = pendingPlan
    if (!p || data.version !== p.version || data.seq !== p.seq) return
    pendingPlan = null
    planComputing.value = false
    if (data.error) {
      planError.value = data.error
      activePlan.value = null
      return
    }
    planError.value = null
    activePlan.value = {
      version: p.version,
      snapshotSignature: p.snapshotSignature,
      dancerIds: p.dancerIds,
      plan: data.plan!
    }
  }

  /**
   * 同步作废旧版本：必须在 DOM 重渲染前调用，避免旧证据闪现到新路径上。
   * 同时作废全部错峰预演：任何编辑都使旧预演方案不可应用。
   */
  function invalidate() {
    const current = choreographyRef()
    const found = validateChoreography(current)
    issues.value = found
    version.value += 1
    liveVersion = version.value
    error.value = null
    report.value = null
    computing.value = true
    discardPlan()
    return { version: version.value, current, valid: found.length === 0 }
  }

  /**
   * 编辑入口：同步作废 + 快照绑定版本，60ms 防抖只推迟“开始计算”，
   * 不推迟版本作废，也不推迟快照。
   */
  function scheduleRun() {
    if (debounceTimer) clearTimeout(debounceTimer)
    const next = invalidate()
    // 即便校验失败也排一次计时器：触发时直接落地“暂停分析”状态
    const invalid = !next.valid
    const snapshot: Choreography = JSON.parse(JSON.stringify(next.current))
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (version.value !== next.version) return // 已被更新的编辑作废
      if (invalid) {
        computing.value = false
        return
      }
      startCompute({ version: next.version, snapshot })
    }, 60)
  }

  /** 立即执行（初始挂载 / 重试）：同样先作废旧状态再算 */
  function run() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    const next = invalidate()
    if (!next.valid) {
      computing.value = false
      return
    }
    const snapshot: Choreography = JSON.parse(JSON.stringify(next.current))
    startCompute({ version: next.version, snapshot })
  }

  /** 失败后重试：用当前编排开新版本计算，得到全新结果 */
  function retry() {
    run()
  }

  function startCompute(req: PendingRequest) {
    pending = req
    postedVersion = req.version
    computing.value = true
    error.value = null

    if (!worker) worker = createWorker()
    if (worker) {
      const message: AnalyzeRequest = {
        version: req.version,
        // 快照本身已是普通对象，避免把 Vue 响应式代理交给结构化克隆
        choreography: req.snapshot
      }
      worker.postMessage(message)
      return
    }

    // 主线程兜底：只计算发起时的快照，并按版本号核对，逻辑与 Worker 一致
    const v = req.version
    setTimeout(() => {
      if (v !== postedVersion || v !== liveVersion || !pending) return
      pending = null
      computing.value = false
      try {
        report.value = analyzeChoreography(req.snapshot)
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err)
      }
    }, 0)
  }

  // ---- 双人错峰预演 ----

  /**
   * 发起一次双人错峰预演：不动正式编排与 version，因此正式判碰报告保持原样。
   * 当前编排未通过校验、选中舞者不合法或没有正常报告（分析中 / 失败）时拒绝发起。
   */
  function requestStagger(dancerIds: readonly number[]): { ok: boolean; error?: string } {
    const current = choreographyRef()
    if (computing.value) return { ok: false, error: '当前版本正在判碰分析，请稍候再预演' }
    if (error.value) return { ok: false, error: '当前版本判碰分析失败，请先重试或重新编辑' }
    if (issues.value.length > 0) return { ok: false, error: '编排未通过校验，无法预演' }
    if (validateChoreography(current).length > 0) {
      return { ok: false, error: '编排未通过校验，无法预演' }
    }
    const ids = [...new Set(Array.from(dancerIds))].sort((a, b) => a - b)
    if (ids.length !== 2) return { ok: false, error: '必须选择两名不同舞者' }
    if (!ids.every((id) => current.some((d) => d.id === id))) {
      return { ok: false, error: '选中的舞者不存在' }
    }

    // 旧预演（含在途请求）立即作废：只有最新选择会得到回复
    pendingPlan = null
    planError.value = null
    activePlan.value = null
    planComputing.value = true

    const seq = ++staggerSeq
    const snapshot: Choreography = JSON.parse(JSON.stringify(current))
    const item: PendingStagger = {
      version: liveVersion,
      seq,
      snapshot,
      dancerIds: ids as [number, number],
      snapshotSignature: JSON.stringify(snapshot)
    }
    pendingPlan = item

    if (!worker) worker = createWorker()
    if (worker) {
      const message: StaggerRequestMessage = {
        kind: 'stagger',
        version: item.version,
        seq,
        choreography: snapshot,
        dancerIds: ids
      }
      worker.postMessage(message)
    } else {
      // 主线程兜底：只算快照，按 version + seq 核对
      setTimeout(() => {
        try {
          const plan = planStagger({ choreography: snapshot, dancerIds: ids })
          acceptStaggerResponse({ kind: 'stagger', version: item.version, seq, plan })
        } catch (err) {
          acceptStaggerResponse({
            kind: 'stagger',
            version: item.version,
            seq,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }, 0)
    }
    return { ok: true }
  }

  /** 丢弃预演（用户取消 / 重新选择 / 任何编辑作废） */
  function discardPlan() {
    pendingPlan = null
    planComputing.value = false
    planError.value = null
    activePlan.value = null
  }

  /**
   * 方案是否可应用：方案版本必须仍是当前编排版本、快照签名一致、
   * 当前不在分析中 / 分析失败 / 校验失败，且方案确为可行解。
   */
  const planApplicable = computed(() => {
    const ap = activePlan.value
    if (!ap) return false
    if (ap.version !== liveVersion || computing.value || error.value || issues.value.length > 0) {
      return false
    }
    if (ap.snapshotSignature !== JSON.stringify(choreographyRef())) return false
    return ap.plan.found
  })

  /**
   * 应用方案：核对版本与快照后，**一次性**把两名舞者的全部路点时刻后移，
   * 随后预演作废并由正常 watch → scheduleRun 触发重新分析。
   * 返回是否成功应用。
   */
  function applyPlan(): boolean {
    const ap = activePlan.value
    if (!ap || !planApplicable.value || !ap.plan.found) return false
    const current = choreographyRef()
    const [idA, idB] = ap.plan.dancerIds
    const [dA, dB] = ap.plan.delays
    const a = current.find((d) => d.id === idA)
    const b = current.find((d) => d.id === idB)
    if (!a || !b) return false

    // 先作废预演，再一次性移动路点（整段同步修改只触发一次 watch）
    discardPlan()
    for (const w of a.waypoints) w.t += dA
    for (const w of b.waypoints) w.t += dB
    return true
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      disposed = true
      if (debounceTimer) clearTimeout(debounceTimer)
      killWorker()
    })
  }

  return {
    version,
    report,
    issues,
    computing,
    error,
    scheduleRun,
    run,
    retry,
    // 双人错峰预演
    activePlan,
    planComputing,
    planError,
    planApplicable,
    requestStagger,
    discardPlan,
    applyPlan
  }
}

