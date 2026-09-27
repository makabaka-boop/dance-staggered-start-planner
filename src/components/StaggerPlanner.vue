<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AnalysisReportDTO, Choreography } from '../core/types'
import { STAGGER_MAX_DELAY } from '../core/stagger'
import type { StaggerNoSolution, StaggerPreview } from '../core/stagger'

const props = defineProps<{
  choreography: Choreography
  report: AnalysisReportDTO | null
  computing: boolean
  invalid: boolean
  error: string | null
  version: number
  preview: StaggerPreview | null
  previewStale: boolean
  noSolution: StaggerNoSolution | null
  errorMessage: string | null
}>()

const emit = defineEmits<{
  (e: 'preview', payload: { firstId: number; secondId: number }): void
  (e: 'apply'): void
  (e: 'discard'): void
}>()

const firstId = ref(props.choreography[0]?.id ?? 0)
const secondId = ref(props.choreography[1]?.id ?? props.choreography[0]?.id ?? 0)

const sameDancer = computed(() => firstId.value === secondId.value)
const canPreview = computed(
  () => !props.computing && !props.invalid && !props.error && !!props.report && !sameDancer.value
)
const canApply = computed(
  () => canPreview.value && !!props.preview && !props.previewStale && props.preview.sourceVersion === props.version
)

function dancerName(id: number): string {
  return props.choreography.find((d) => d.id === id)?.name ?? `#${id}`
}

function delayOf(id: number): number | null {
  const i = props.preview?.dancerIds.indexOf(id) ?? -1
  return i >= 0 && props.preview ? props.preview.delays[i] : null
}
</script>

<template>
  <section class="panel planner">
    <h2>双人错峰预演</h2>
    <p class="sub">
      仅枚举两名舞者的整条路点统一整数后移（0..{{ STAGGER_MAX_DELAY }}）；坐标、半径、相对节奏和其他舞者不变。
      末端超过 600 的组合不参与，判定复用正式精确线段分析。
    </p>

    <div class="form-row">
      <label>
        舞者 A
        <select v-model.number="firstId" data-testid="stagger-first">
          <option v-for="d in choreography" :key="d.id" :value="d.id">#{{ d.id }} {{ d.name }}</option>
        </select>
      </label>
      <label>
        舞者 B
        <select v-model.number="secondId" data-testid="stagger-second">
          <option v-for="d in choreography" :key="d.id" :value="d.id">#{{ d.id }} {{ d.name }}</option>
        </select>
      </label>
    </div>
    <p v-if="sameDancer" class="warn-line">必须选择两个不同舞者。</p>
    <button
      class="primary"
      type="button"
      data-testid="stagger-run"
      :disabled="!canPreview"
      @click="emit('preview', { firstId: Number(firstId), secondId: Number(secondId) })"
    >
      生成安全预演
    </button>

    <div v-if="invalid || error || computing" class="planner-status sub">
        当前正式报告尚不能作为预演依据（等待完成，或先处理校验 / 计算错误）。
      </div>

    <div v-if="errorMessage" class="no-solution" data-testid="stagger-error">
      <h3>无法预演</h3>
      <p class="bad-line">{{ errorMessage }}</p>
    </div>

    <div v-if="noSolution" class="no-solution" data-testid="stagger-no-solution">
      <h3>无安全组合</h3>
      <p class="bad-line">
        已精确枚举 #{{ noSolution.dancerIds[0] }} 与 #{{ noSolution.dancerIds[1] }} 的
        {{ noSolution.legalCombinationCount }} 个合法延迟组合，仍有冲突。
      </p>
      <div v-if="noSolution.persistentPairs.length">
        <p class="sub">以下未选舞者之间的冲突无法通过只移动所选两人消除：</p>
        <ul>
          <li v-for="p in noSolution.persistentPairs" :key="`${p.aId}-${p.bId}`">
            #{{ p.aId }} {{ p.aName }} ⨯ #{{ p.bId }} {{ p.bName }}
          </li>
        </ul>
      </div>
    </div>

    <div v-if="preview" class="preview-card" data-testid="stagger-preview">
      <div v-if="previewStale" class="stale-box" data-testid="stagger-stale">
        预演已过期：正式编排版本已变化、旧 Worker 回复已被拒绝或分析失败。请重新生成，不能应用旧方案。
      </div>

      <div :class="{ stale: previewStale }">
        <h3>候选安全轨迹</h3>
        <ul class="delay-list mono">
          <li v-for="id in preview.dancerIds" :key="id">
            #{{ id }} {{ dancerName(id) }}：<b>+{{ delayOf(id) }}</b>
          </li>
        </ul>
        <p class="sub">
          延迟之和 {{ preview.delays[0] + preview.delays[1] }} ·
          已枚举全部 {{ preview.checkedCombinationCount }} / {{ preview.legalCombinationCount }} 个合法组合 ·
          来源 v{{ preview.sourceVersion }}
        </p>
        <p class="ok-line">候选完整分析：0 条冲突。</p>

        <div v-if="preview.eliminated.length" class="eliminated">
          <h4>消除的原有冲突</h4>
          <ul>
            <li v-for="g in preview.eliminated" :key="`${g.pair.aId}-${g.pair.bId}`">
              #{{ g.pair.aId }} {{ g.pair.aName }} ⨯ #{{ g.pair.bId }} {{ g.pair.bName }}：
              {{ g.pair.conflicts.length }} 条
            </li>
          </ul>
        </div>
        <p v-else class="sub">原编排中涉及所选舞者的冲突为 0 条；此方案只确认不新增冲突。</p>

        <div class="actions">
          <button class="primary" type="button" data-testid="stagger-apply" :disabled="!canApply" @click="emit('apply')">
            应用到正式编排
          </button>
          <button type="button" data-testid="stagger-discard" @click="emit('discard')">放弃预演</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.planner {
  grid-area: planner;
}
.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 8px 0;
}
.form-row label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}
.form-row select,
.form-row input {
  width: 100%;
}
button {
  width: 100%;
}
.planner-status {
  margin-top: 8px;
}
.no-solution {
  margin-top: 10px;
  border: 1px solid #7a3a3a;
  border-radius: 8px;
  padding: 9px;
  background: #2b181b;
}
.no-solution h3 {
  margin: 0 0 6px;
  font-size: 12.5px;
  color: var(--danger);
}
.bad-line {
  color: var(--danger);
  font-size: 12.5px;
  margin: 5px 0;
}
.preview-card {
  margin-top: 10px;
  border: 1px solid #5f7a44;
  border-radius: 8px;
  padding: 9px;
  background: #18251d;
}
.preview-card h3,
.eliminated h4 {
  margin: 0 0 6px;
  font-size: 12.5px;
  color: var(--ok);
}
.delay-list,
.eliminated ul {
  list-style: none;
  padding: 0;
  margin: 5px 0;
}
.delay-list li,
.eliminated li {
  padding: 2px 0;
}
.ok-line {
  color: var(--ok);
  margin: 6px 0;
  font-size: 12.5px;
}
.warn-line {
  color: var(--warn);
  font-size: 12px;
  margin: 5px 0;
}
.stale-box {
  border: 1px solid #7a3a3a;
  color: var(--danger);
  background: #2b181b;
  border-radius: 7px;
  padding: 8px;
  font-size: 12.5px;
}
.stale {
  opacity: 0.55;
}
.eliminated {
  border-top: 1px solid var(--line);
  margin-top: 7px;
  padding-top: 7px;
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.actions button {
  width: auto;
  flex: 1;
}
</style>
