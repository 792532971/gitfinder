<script setup lang="ts">
import { state } from '../store'
</script>

<template>
  <div class="toasts">
    <TransitionGroup name="toast">
      <div v-for="t in state.toasts" :key="t.id" :class="['toast', t.type]">
        <span class="dot"></span>
        <span class="text">{{ t.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 200;
  pointer-events: none;
  max-width: 460px;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text);
  pointer-events: auto;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 6px;
  flex-shrink: 0;
  background: var(--accent);
}
.toast.ok .dot {
  background: var(--green);
}
.toast.warn .dot {
  background: var(--amber);
}
.toast.error .dot {
  background: var(--red);
}
.toast.ok {
  border-color: #b7e0c3;
}
.toast.error {
  border-color: #ffcecb;
}
.toast.warn {
  border-color: #f0e0a0;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.22s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
