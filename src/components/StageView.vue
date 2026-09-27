<script setup lang="ts">
import { computed } from 'vue'
import { Fraction } from '../core/fraction'
import { positionAt } from '../core/geometry'
import type { Choreography } from '../core/types'

/** 双人错峰预演候选：candidate 只在路点时刻上与正式编排不同，路径坐标相同 */
export interface StagePreview {
  candidate: Choreography
  shifts: { id: number; delay: number }[]
}

const props = defineProps<{
  choreography: Choreography
  currentTime: number
  selectedPair: { aId: number; bId: number } | null
  witness: Fraction | null
  preview?: StagePreview | null
}>()

const SIZE = 560
const PAD = 34
const RANGE = 100
const scale = (SIZE - PAD * 2) / (RANGE * 2)

function sx(x: number): number {
  return PAD + (x + RANGE) * scale
}
function sy(y: number): number {
  return PAD + (RANGE - y) * scale
}
function sf(p: Fraction): number {
  return p.toNumber()
}

const COLORS = ['#5ec8e6', '#e89b5c', '#9bd06a', '#c98ce8', '#e86b9a', '#6bb7e8', '#d8c65c', '#7adcc0']

const grid = computed(() => {
  const lines: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = []
  for (let v = -100; v <= 100; v += 20) {
    lines.push({ x1: sx(v), y1: sy(-100), x2: sx(v), y2: sy(100), major: v === 0 })
    lines.push({ x1: sx(-100), y1: sy(v), x2: sx(100), y2: sy(v), major: v === 0 })
  }
  return lines
})

const dancersView = computed(() =>
  props.choreography.map((d, idx) => {
    const w = d.waypoints
    const active = props.currentTime >= w[0].t && props.currentTime <= w[w.length - 1].t
    let pos: { x: number; y: number } | null = null
    if (active) {
      // 滑块时刻按 1/100 取分数；当前位置只用于显示，判定始终在 Worker 中用精确分数
      const t = new Fraction(Math.round(props.currentTime * 100), 100)
      const p = positionAt(d, t)
      pos = { x: sf(p.x), y: sf(p.y) }
    }
    return {
      dancer: d,
      color: COLORS[idx % COLORS.length],
      points: w.map((p) => ({ cx: sx(p.x), cy: sy(p.y), t: p.t })),
      path: w.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' '),
      active,
      pos
    }
  })
)

const witnessView = computed(() => {
  const pair = props.selectedPair
  if (!props.witness || !pair) return null
  const a = props.choreography.find((d) => d.id === pair.aId)
  const b = props.choreography.find((d) => d.id === pair.bId)
  if (!a || !b) return null
  const pa = positionAt(a, props.witness)
  const pb = positionAt(b, props.witness)
  return {
    ax: sf(pa.x),
    ay: sf(pa.y),
    bx: sf(pb.x),
    by: sf(pb.y),
    t: props.witness
  }
})

function inPair(id: number): boolean {
  const sp = props.selectedPair
  return !!sp && (id === sp.aId || id === sp.bId)
}

/** 预演覆盖层：只画两名选中舞者的候选轨迹（同色加粗虚线）与候选当前位置（空心方块） */
const previewShifts = computed(() => {
  const pv = props.preview
  if (!pv) return []
  const t = new Fraction(Math.round(props.currentTime * 100), 100)
  return pv.shifts
    .map((s) => {
      const dancer = pv.candidate.find((d) => d.id === s.id)
      const origin = props.choreography.find((d) => d.id === s.id)
      if (!dancer || !origin) return null
      const w = dancer.waypoints
      const active = props.currentTime >= w[0]!.t && props.currentTime <= w[w.length - 1]!.t
      let pos: { x: number; y: number } | null = null
      if (active) {
        const p = positionAt(dancer, t)
        pos = { x: sf(p.x), y: sf(p.y) }
      }
      const idx = props.choreography.findIndex((d) => d.id === s.id)
      return {
        id: s.id,
        delay: s.delay,
        color: COLORS[((idx % COLORS.length) + COLORS.length) % COLORS.length]!,
        // 坐标路径与正式编排一致，只时刻后移：直接画同一路径的虚线覆盖层
        path: w.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' '),
        labelX: sx(w[0]!.x),
        labelY: sy(w[0]!.y),
        active,
        pos
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
})
</script>

<template>
  <div class="stage-wrap">
    <h2>
      舞台俯视图
      <span class="sub" style="margin-left: 8px">坐标 −100..100 · 见证位置由精确分数换算，仅用于绘制</span>
    </h2>
    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="stage-svg" role="img" aria-label="舞台轨迹俯视图">
      <g>
        <line
          v-for="(l, i) in grid"
          :key="i"
          :x1="l.x1"
          :y1="l.y1"
          :x2="l.x2"
          :y2="l.y2"
          :stroke="l.major ? '#3d4a66' : '#232c3f'"
          :stroke-width="l.major ? 1.2 : 0.7"
        />
      </g>
      <text v-for="v in [-100, -50, 50, 100]" :key="'xl' + v" :x="sx(v)" :y="SIZE - 10" fill="#6b7894" font-size="10" text-anchor="middle">{{ v }}</text>
      <text v-for="v in [-100, -50, 50, 100]" :key="'yl' + v" :x="12" :y="sy(v) + 3" fill="#6b7894" font-size="10" text-anchor="middle">{{ v }}</text>

      <g v-for="dv in dancersView" :key="dv.dancer.id">
        <polyline
          :points="dv.path"
          fill="none"
          :stroke="dv.color"
          :stroke-width="selectedPair && !inPair(dv.dancer.id) ? 1.2 : 2.6"
          :opacity="selectedPair && !inPair(dv.dancer.id) ? 0.3 : 0.95"
          stroke-linejoin="round"
        />
        <circle
          v-for="(p, i) in dv.points"
          :key="i"
          :cx="p.cx"
          :cy="p.cy"
          r="2.6"
          :fill="dv.color"
          :opacity="selectedPair && !inPair(dv.dancer.id) ? 0.35 : 0.9"
        >
          <title>{{ dv.dancer.name }} 路点 {{ i }} · t={{ p.t }}</title>
        </circle>

        <template v-if="dv.pos">
          <circle
            :cx="sx(dv.pos.x)"
            :cy="sy(dv.pos.y)"
            :r="dv.dancer.radius * scale"
            :fill="dv.color"
            fill-opacity="0.08"
            :stroke="dv.color"
            stroke-opacity="0.55"
            stroke-dasharray="3 3"
          />
          <circle :cx="sx(dv.pos.x)" :cy="sy(dv.pos.y)" r="4.2" :fill="dv.color" stroke="#0f1420" stroke-width="1.5">
            <title>{{ dv.dancer.name }} @ t={{ currentTime.toFixed(2) }}</title>
          </circle>
        </template>
      </g>

      <g v-if="witnessView">
        <line
          :x1="sx(witnessView.ax)"
          :y1="sy(witnessView.ay)"
          :x2="sx(witnessView.bx)"
          :y2="sy(witnessView.by)"
          stroke="#ef6b6b"
          stroke-width="2"
          stroke-dasharray="5 4"
        />
        <circle :cx="sx(witnessView.ax)" :cy="sy(witnessView.ay)" r="6" fill="none" stroke="#ef6b6b" stroke-width="2" />
        <circle :cx="sx(witnessView.bx)" :cy="sy(witnessView.by)" r="6" fill="none" stroke="#ef6b6b" stroke-width="2" />
      </g>

      <!-- 双人错峰预演候选轨迹：坐标路径相同（加粗虚线覆盖），候选位置用空心方块表示 -->
      <g v-if="preview">
        <g v-for="ps in previewShifts" :key="'pv' + ps.id">
          <polyline
            :points="ps.path"
            fill="none"
            :stroke="ps.color"
            stroke-width="4"
            stroke-dasharray="7 5"
            stroke-linejoin="round"
            opacity="0.55"
          />
          <rect
            :x="ps.labelX - 6"
            :y="ps.labelY - 16"
            width="12"
            height="12"
            rx="2"
            fill="#0f1420"
            :stroke="ps.color"
            stroke-width="1.4"
          />
          <text
            :x="ps.labelX"
            :y="ps.labelY - 20"
            :fill="ps.color"
            font-size="10"
            text-anchor="middle"
          >
            +{{ ps.delay }}
          </text>
          <rect
            v-if="ps.pos"
            :x="sx(ps.pos.x) - 5"
            :y="sy(ps.pos.y) - 5"
            width="10"
            height="10"
            rx="1.5"
            fill="#0f1420"
            :stroke="ps.color"
            stroke-width="2.4"
          >
            <title>预演候选位置 · 后移 {{ ps.delay }}</title>
          </rect>
        </g>
      </g>
    </svg>
    <div class="legend">
      <span v-for="dv in dancersView" :key="dv.dancer.id" class="legend-item">
        <i :style="{ background: dv.color }" />{{ dv.dancer.name }} · r={{ dv.dancer.radius }}
      </span>
      <span v-if="preview" class="legend-item note">虚线方框 = 错峰预演候选轨迹（不改正式编排）</span>
    </div>
  </div>
</template>

<style scoped>
.stage-wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.stage-svg {
  width: 100%;
  flex: 1;
  min-height: 0;
  background: #0c111c;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}
.legend-item {
  font-size: 12px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend-item i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
</style>
