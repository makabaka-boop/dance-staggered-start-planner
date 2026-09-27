<script setup lang="ts">
import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue'
import StageView from './components/StageView.vue'
import TimeSlider from './components/TimeSlider.vue'
import ConflictReport from './components/ConflictReport.vue'
import DancerEditor from './components/DancerEditor.vue'
import StaggerPlanner from './components/StaggerPlanner.vue'
import { PRESETS } from './data/presets'
import { useCollisionAnalysis } from './composables/useCollisionAnalysis'
import { applyStaggerPreview, planTwoDancerStagger, previewVersionMatches } from './core/stagger'
import type { StaggerNoSolution, StaggerPreview } from './core/stagger'
import { Fraction } from './core/fraction'
import type { ConflictDTO, PairReportDTO } from './core/types'

const choreography = reactive(structuredClone(PRESETS[0].data))

const { version, report, issues, computing, error: analysisError, scheduleRun, run, retry } =
  useCollisionAnalysis(() => choreography)

const staggerPreview = ref<StaggerPreview | null>(null)
const staggerNoSolution = ref<StaggerNoSolution | null>(null)
const staggerError = ref<string | null>(null)
/** 预演生成后，任何后续版本变化都使其成为不可应用的旧方案 */
const staggerStale = ref(false)

// 编辑后在同一渲染周期内同步作废旧版本（version++、清报告与计算状态），
// 60ms 防抖只推迟开始计算；因此拖动期间旧标记 / 旧证据不会盖在新路径上
watch(
  () => choreography,
  () => scheduleRun(),
  { deep: true }
)
run()

// ---- 时间与播放 ----
const currentTime = ref(0)
const playing = ref(false)
let raf = 0
let lastTs = 0

function tick(ts: number) {
  if (!playing.value) return
  if (lastTs) {
    const next = currentTime.value + (ts - lastTs) / 1000
    currentTime.value = next >= 600 ? 0 : next
  }
  lastTs = ts
  raf = requestAnimationFrame(tick)
}
function togglePlay() {
  playing.value = !playing.value
  lastTs = 0
  if (playing.value) raf = requestAnimationFrame(tick)
  else cancelAnimationFrame(raf)
}
onBeforeUnmount(() => cancelAnimationFrame(raf))

// ---- 冲突选择 / 见证联动 ----
const selectedKey = ref<string | null>(null)

interface Selection {
  pair: PairReportDTO
  conflict: ConflictDTO
}

const selected = computed<Selection | null>(() => {
  if (!report.value || !selectedKey.value) return null
  for (const pair of report.value.reports) {
    for (const conflict of pair.conflicts) {
      const k = `${pair.aId}-${pair.bId}#${conflict.segA.waypointIndex}-${conflict.segB.waypointIndex}`
      if (k === selectedKey.value) return { pair, conflict }
    }
  }
  return null
})

const selectedPair = computed(() =>
  selected.value ? { aId: selected.value.pair.aId, bId: selected.value.pair.bId } : null
)
const witness = computed(() =>
  selected.value ? Fraction.fromJSON(selected.value.conflict.atTime) : null
)

const pairColor = (aId: number, bId: number) =>
  ['#ef6b6b', '#e89b5c', '#c98ce8', '#5ec8e6', '#9bd06a', '#e86b9a', '#6bb7e8', '#d8c65c'][
    (aId * 7 + bId * 3) % 8
  ]

const marks = computed(() => {
  if (!report.value) return []
  return report.value.reports.flatMap((pair) =>
    pair.conflicts.map((conflict) => ({ conflict, color: pairColor(pair.aId, pair.bId) }))
  )
})

const previewDancerIds = computed(() => staggerPreview.value?.dancerIds ?? [])
const previewChoreography = computed(() =>
  staggerPreview.value && !staggerStale.value ? staggerPreview.value.candidate : null
)

function onSelect(payload: { pair: PairReportDTO; conflict: ConflictDTO; key: string } | null) {
  if (!payload) {
    selectedKey.value = null
    return
  }
  // 再次点击同一条目即取消
  selectedKey.value = selectedKey.value === payload.key ? null : payload.key
  if (selectedKey.value) {
    currentTime.value = Fraction.fromJSON(payload.conflict.atTime).toNumber()
  }
}
function onSeekFraction(f: Fraction) {
  currentTime.value = f.toNumber()
}

// 版本变化（编辑 / 重试）即在渲染前清掉上一版的选中证据，
// 让路径、标记、证据、报告同属一版；新报告返回后也不允许旧选择残留
watch(version, () => {
  selectedKey.value = null
  staggerNoSolution.value = null
  staggerError.value = null
  if (staggerPreview.value) staggerStale.value = true
})

watch(analysisError, (failed) => {
  if (failed) staggerStale.value = true
})

function onRequestStagger(payload: { firstId: number; secondId: number }) {
  staggerNoSolution.value = null
  staggerError.value = null
  staggerPreview.value = null
  staggerStale.value = false
  if (!report.value || computing.value || analysisError.value || issues.value.length > 0) {
    staggerError.value = '请等待当前正式分析成功后再预演。'
    return
  }

  const result = planTwoDancerStagger(
    JSON.parse(JSON.stringify(choreography)),
    payload.firstId,
    payload.secondId,
    version.value,
    report.value
  )
  if (result.status === 'solution') {
    staggerPreview.value = result.preview
  } else if (result.status === 'no-solution') {
    staggerNoSolution.value = result.result
  } else {
    staggerError.value = result.message
  }
}

function onApplyStagger() {
  const candidate = staggerPreview.value
  if (!candidate || !previewVersionMatches(candidate, version.value) || staggerStale.value) return
  if (!report.value || computing.value || analysisError.value || issues.value.length > 0) {
    staggerStale.value = true
    return
  }

  // 核对通过后一次性提交两路点时间；同一个 watch 负责同步作废与重新分析。
  applyStaggerPreview(choreography, candidate)
  staggerPreview.value = null
  staggerNoSolution.value = null
  staggerError.value = null
  staggerStale.value = false
}

function onDiscardStagger() {
  staggerPreview.value = null
  staggerNoSolution.value = null
  staggerError.value = null
  staggerStale.value = false
}

const invalid = computed(() => issues.value.length > 0)
const conflictTotal = computed(() =>
  report.value ? report.value.reports.reduce((n, r) => n + r.conflicts.length, 0) : 0
)
</script>

<template>
  <div class="app">
    <header>
      <h1>舞台轨迹检查 · Stage Trajectory Check</h1>
      <p class="sub head-sub">
        匀速线段 · 枚举每对舞者时间重叠的线段对 · 相对距离平方二次函数以 BigInt 分数精确求最小 ·
        不按帧采样、不用 SVG 像素判定
      </p>
      <span v-if="invalid" class="tag bad">校验失败 v{{ version }}</span>
      <span v-else-if="analysisError" class="tag bad">分析失败 v{{ version }}</span>
      <span v-else-if="computing" class="tag run">分析中 v{{ version }}…</span>
      <span v-else-if="conflictTotal > 0" class="tag bad">发现 {{ conflictTotal }} 条冲突 · v{{ version }}</span>
      <span v-else class="tag ok">无冲突 · v{{ version }}</span>
      <button v-if="analysisError" class="tag retry" type="button" @click="retry">重试</button>
    </header>

    <DancerEditor :choreography="choreography" :issues="issues" :version="version" />

    <StaggerPlanner
      :choreography="choreography"
      :report="report"
      :computing="computing"
      :invalid="invalid"
      :error="analysisError"
      :version="version"
      :preview="staggerPreview"
      :preview-stale="staggerStale"
      :no-solution="staggerNoSolution"
      :error-message="staggerError"
      @preview="onRequestStagger"
      @apply="onApplyStagger"
      @discard="onDiscardStagger"
    />

    <div class="panel stage-panel" style="grid-area: stage">
      <StageView
        :choreography="choreography"
        :current-time="currentTime"
        :selected-pair="selectedPair"
        :witness="witness"
        :preview-choreography="previewChoreography"
        :preview-dancer-ids="previewDancerIds"
      />
    </div>

    <TimeSlider
      :current-time="currentTime"
      :marks="marks"
      :witness="witness"
      :playing="playing"
      @update:time="currentTime = $event"
      @toggle-play="togglePlay"
      @seek-fraction="onSeekFraction"
    />

    <ConflictReport
      :report="report"
      :computing="computing"
      :invalid="invalid"
      :error="analysisError"
      :selected-key="selectedKey"
      @select="onSelect"
      @retry="retry"
    />
  </div>
</template>

<style scoped>
header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 4px;
}
.head-sub {
  margin: 0;
  flex: 1;
}
.stage-panel {
  overflow: hidden;
}
</style>
