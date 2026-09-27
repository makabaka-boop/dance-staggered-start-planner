/// <reference lib="webworker" />
import { analyzeChoreography } from '../core/choreography'
import { planStagger, type StaggerPlan } from '../core/stagger'
import type { AnalysisReportDTO, Choreography } from '../core/types'

export interface AnalyzeRequest {
  /** 单调递增的编排版本号；主线程只接受与当前版本一致的结果 */
  version: number
  /** 发起请求那一刻的编排快照；Worker 永远不会读到请求之后的编辑 */
  choreography: Choreography
  /** 缺省为常规判碰分析；'stagger' 为双人错峰预演枚举 */
  kind?: 'analyze'
}

export interface StaggerRequestMessage {
  kind: 'stagger'
  version: number
  /** 预演请求序号：同版本内丢弃更早请求的迟到回复 */
  seq: number
  choreography: Choreography
  dancerIds: number[]
}

export type WorkerRequest = AnalyzeRequest | StaggerRequestMessage

export interface AnalyzeResponse {
  /** 常规判碰回复的判别字段；缺省同样视为常规分析（保持旧结构兼容） */
  kind?: 'analyze'
  version: number
  /** 成功时的报告；与 error 互斥 */
  report?: AnalysisReportDTO
  /** 计算失败时的错误信息（主线程据此给出明确失败状态与重试入口） */
  error?: string
}

export interface StaggerResponse {
  kind: 'stagger'
  version: number
  seq: number
  plan?: StaggerPlan
  error?: string
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  try {
    if (req.kind === 'stagger') {
      // 全部合法延迟组合全枚举，复用精确有理数判碰，不抽样
      const plan = planStagger({ choreography: req.choreography, dancerIds: req.dancerIds })
      ;(self as DedicatedWorkerGlobalScope).postMessage({
        kind: 'stagger',
        version: req.version,
        seq: req.seq,
        plan
      } satisfies StaggerResponse)
      return
    }

    // 计算为纯 BigInt 分数运算；DTO 中以字符串携带
    const report = analyzeChoreography(req.choreography)
    ;(self as DedicatedWorkerGlobalScope).postMessage({
      kind: 'analyze',
      version: req.version,
      report
    } satisfies AnalyzeResponse)
  } catch (err) {
    // 不让异常只表现为 worker error 事件：回一条带版本号的失败响应，
    // 主线程可以明确标记该版失败并允许重试。
    const message = err instanceof Error ? err.message : String(err)
    if (req.kind === 'stagger') {
      ;(self as DedicatedWorkerGlobalScope).postMessage({
        kind: 'stagger',
        version: req.version,
        seq: req.seq,
        error: message
      } satisfies StaggerResponse)
    } else {
      ;(self as DedicatedWorkerGlobalScope).postMessage({
        version: req.version,
        error: message
      } satisfies AnalyzeResponse)
    }
  }
}
