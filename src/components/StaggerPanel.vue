<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Choreography } from '../core/types'
import type { ActiveStaggerPlan } from '../composables/useCollisionAnalysis'
import { STAGGER_LIMITS } from '../core/stagger'

const props = defineProps<{
  choreography: Choreography
  activePlan: ActiveStaggerPlan | null
  planComputing: boolean
  planError: string | null
  planApplicable: boolean
  /** 常规判碰报告是否已就绪（分析中 / 失败 / 校验失败时不可发起预演） */
  canRequest: boolean
}>()

const emit = defineEmits<{
  (e: 'request', ids: [number, number]): void
  (e: 'discard'): void
  (e: 'apply'): void
}>()

const selectedA = ref<number | null>(null)
const selectedB = ref<number | null>(null)

// 编排整体替换（载入预设 / 舞者增删）时把选择重置为前两名
watch(
  () => props.choreography.map((d) => d.id).join(','),
  () => {
    selectedA.value = props.choreography[0]?.id ?? null
    selectedB.value = props.choreography[1]?.id ?? null
  },
  { immediate: true }
)

const distinct = computed(() => selectedA.value !== null && selectedB.value !== null && selectedA.value !== selectedB.value)

function runPreview() {
  if (!distinct.value) return
  emit('request', [selectedA.value as number, selectedB.value as number])
}

function nameOf(id: number): string {
  return props.choreography.find((d) => d.id === id)?.name ?? `#${id}`
}

const plan = computed(() => props.activePlan?.plan ?? null)
</script>

<template>
  <section class="panel stagger">
    <h2>双人错峰预演</h2>
    <p class="sub">
      选两名舞者，整条路点时刻统一后移 {{ STAGGER_LIMITS.MIN_DELAY }}..{{ STAGGER_LIMITS.MAX_DELAY }}
      整数单位（坐标 / 半径 / 相对节奏不变，任一路点超过 600 的组合不可选）；精确枚举全部合法组合，只接受所有舞者对零冲突、延迟和最小的方案。预演不改正式编排。
    </p>

    <div class="row">
      <select v-model.number="selectedA" aria-label="舞者甲">
        <option v-for="d in choreography" :key="d.id" :value="d.id">{{ d.name }} #{{ d.id }}</option>
      </select>
      <span class="sub">＋</span>
      <select v-model.number="selectedB" aria-label="舞者乙">
        <option v-for="d in choreography" :key="d.id" :value="d.id">{{ d.name }} #{{ d.id }}</option>
      </select>
      <button class="primary" :disabled="!distinct || !canRequest || planComputing" @click="runPreview">
        {{ planComputing ? '枚举中…' : '预演' }}
      </button>
      <button v-if="activePlan || planComputing || planError" @click="emit('discard')">清除</button>
    </div>
    <p v-if="!distinct" class="hint bad">必须选择两名不同的舞者。</p>
    <p v-else-if="!canRequest" class="hint">需等当前版本的正常判碰报告就绪后才能预演。</p>

    <p v-if="planError" class="err-box mono">{{ planError }}</p>

    <template v-if="planComputing">
      <p class="hint"><span class="tag run">预演中</span> 正在用精确有理数判碰枚举全部合法延迟组合…</p>
    </template>

    <template v-else-if="plan && plan.found">
      <div class="result ok-box">
        <div>
          <b class="good">找到安全方案</b>
          <span class="tag ok mono">v{{ activePlan!.version }}</span>
          <span v-if="!planApplicable" class="tag bad">已过期·不可应用</span>
        </div>
        <ul class="plan-list mono">
          <li>{{ nameOf(plan.dancerIds[0]) }} #{{ plan.dancerIds[0] }}：后移 <b>{{ plan.delays[0] }}</b></li>
          <li>{{ nameOf(plan.dancerIds[1]) }} #{{ plan.dancerIds[1] }}：后移 <b>{{ plan.delays[1] }}</b></li>
          <li>延迟之和：<b>{{ plan.delaySum }}</b>（裁决序最小）</li>
          <li>合法上界：[{{ plan.caps[0] }}, {{ plan.caps[1] }}]</li>
          <li>消除原有冲突：<b class="good">{{ plan.eliminatedCount }}</b> 条（涉及 {{ plan.eliminatedPairs.length }} 对舞者）</li>
        </ul>
        <ul v-if="plan.eliminatedPairs.length" class="pairs sub mono">
          <li v-for="p in plan.eliminatedPairs" :key="`${p.aId}-${p.bId}`">
            #{{ p.aId }} ⨯ #{{ p.bId }}：{{ p.count }} 条
          </li>
        </ul>
        <button class="primary apply" :disabled="!planApplicable" @click="emit('apply')">应用到正式编排</button>
        <p v-if="!planApplicable" class="hint bad">编排已被编辑或当前版本分析未成功，方案不可应用，请重新预演。</p>
      </div>
    </template>

    <template v-else-if="plan && !plan.found">
      <div class="result bad-box">
        <div>
          <b class="bad">无解</b>
          <span class="tag bad mono">v{{ activePlan!.version }}</span>
        </div>
        <p class="hint">
          <template v-if="plan.reason === 'unselected-conflict'">
            未选中的舞者之间本就存在冲突，只推迟这两人无法消除：
          </template>
          <template v-else>
            合法延迟范围内没有任何组合能让所有舞者对零冲突。
          </template>
        </p>
        <ul v-if="plan.unselectedPairs.length" class="pairs mono">
          <li v-for="p in plan.unselectedPairs" :key="`${p.aId}-${p.bId}`" class="bad">
            #{{ p.aId }} ⨯ #{{ p.bId }}：{{ p.count }} 条（与延迟无关）
          </li>
        </ul>
        <ul v-if="plan.bestAttempt" class="plan-list mono">
          <li>最接近的组合 ({{ plan.bestAttempt.delays[0] }}, {{ plan.bestAttempt.delays[1] }})，和 {{ plan.bestAttempt.delaySum }}，仍余 {{ plan.bestAttempt.remainingCount }} 条冲突</li>
        </ul>
        <p class="hint sub">原有冲突 {{ plan.originalCount }} 条保持不变（预演不改正式编排）。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.stagger {
  grid-area: stagger;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
}
.row select {
  width: auto;
  flex: 1;
  min-width: 0;
}
.hint {
  margin: 2px 0;
  font-size: 12px;
  color: var(--muted);
}
.hint.bad {
  color: var(--danger);
}
.result {
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 4px;
}
.ok-box {
  border: 1px solid #336048;
}
.bad-box {
  border: 1px solid #7a3a3a;
}
.plan-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
}
.pairs {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
}
.good {
  color: var(--ok);
}
.bad {
  color: var(--danger);
}
.apply {
  margin-top: 8px;
}
.err-box {
  border: 1px solid #7a3a3a;
  color: #e5a0a0;
  border-radius: 8px;
  padding: 6px 9px;
  font-size: 12.5px;
  word-break: break-all;
}
</style>
