<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NCheckboxGroup, NInputNumber, NModal, NSpin, useMessage } from 'naive-ui'
import AvatarVue from '@/components/avatar.vue'
import { resolveAttachmentUrl } from '@/composables/useAttachmentResolver'
import { normalizeAvatarTextStyle } from '@/utils/channelIdentityAvatar'
import { useChatStore } from '@/stores/chat'
import { useUserStore } from '@/stores/user'
import type { ChannelIdentity } from '@/types'

const props = defineProps<{
  show: boolean
  channelId: string
  content: string
  icMode: 'ic' | 'ooc'
}>()

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
}>()

const chat = useChatStore()
const user = useUserStore()
const message = useMessage()

const selectedIdentityIds = ref<string[]>([])
const delaySeconds = ref(0)
const loading = ref(false)
const sending = ref(false)

const identities = computed(() => {
  const items = chat.channelIdentities[props.channelId] || []
  return items.filter((identity) => identity.id && identity.userId === user.info.id)
})

const selectedCount = computed(() => selectedIdentityIds.value.length)

const sleep = (ms: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, ms)
})

const resolveDisplayName = (identity: ChannelIdentity) => (
  chat.getActiveIdentityVariant(props.channelId, identity.id)?.displayName || identity.displayName
)

const resolveAvatarSrc = (identity: ChannelIdentity) => {
  const variant = chat.getActiveIdentityVariant(props.channelId, identity.id)
  const resolved = resolveAttachmentUrl(variant?.avatarAttachmentId || identity.avatarAttachmentId)
  if (resolved) {
    return resolved
  }
  return identity.isTemporary || normalizeAvatarTextStyle(identity.avatarTextStyle) ? '' : (user.info.avatar || '')
}

const close = () => {
  if (!sending.value) {
    emit('update:show', false)
  }
}

const send = async () => {
  if (sending.value || !selectedIdentityIds.value.length) {
    return
  }
  if (!props.channelId || chat.curChannel?.id !== props.channelId) {
    message.warning('当前频道已切换，请重新选择消息')
    emit('update:show', false)
    return
  }

  const selectedSet = new Set(selectedIdentityIds.value)
  const targets = identities.value.filter((identity) => selectedSet.has(identity.id))
  if (!targets.length) {
    message.warning('请选择至少一个频道角色')
    return
  }

  const delayMs = Math.max(0, Number(delaySeconds.value) || 0) * 1000
  let sentCount = 0
  let failedCount = 0
  let stoppedByChannelChange = false
  sending.value = true

  try {
    for (let index = 0; index < targets.length; index += 1) {
      if (chat.curChannel?.id !== props.channelId) {
        stoppedByChannelChange = true
        break
      }

      const identity = targets[index]
      const variantId = chat.getActiveIdentityVariantId(props.channelId, identity.id) || undefined
      try {
        const created = await chat.messageCreate(
          props.content,
          undefined,
          undefined,
          undefined,
          identity.id,
          undefined,
          [],
          undefined,
          undefined,
          variantId,
          props.icMode,
          props.channelId,
        )
        if (created) {
          sentCount += 1
        } else {
          failedCount += 1
        }
      } catch {
        failedCount += 1
      }

      if (index < targets.length - 1 && delayMs > 0 && chat.curChannel?.id === props.channelId) {
        await sleep(delayMs)
      }
    }
  } finally {
    sending.value = false
  }

  if (stoppedByChannelChange) {
    message.warning(`频道已切换，已发送 ${sentCount} 条并停止剩余复读`)
    return
  }
  if (failedCount === 0 && sentCount === targets.length) {
    message.success(`已复读 ${sentCount} 条消息`)
    emit('update:show', false)
    return
  }
  if (sentCount > 0) {
    message.warning(`已发送 ${sentCount} 条，失败 ${failedCount} 条`)
    return
  }
  message.error('复读发送失败')
}

watch(
  () => props.show,
  async (show) => {
    if (!show) {
      return
    }
    selectedIdentityIds.value = []
    delaySeconds.value = 0
    loading.value = true
    const channelId = props.channelId
    try {
      await chat.loadChannelIdentities(channelId, false)
    } catch {
      message.error('频道角色加载失败')
    } finally {
      if (props.show && props.channelId === channelId) {
        loading.value = false
      }
    }
  },
)
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="多NPC复读消息"
    class="multi-npc-repeat-modal"
    :style="{ width: 'min(620px, calc(100vw - 24px))' }"
    :mask-closable="!sending"
    :close-on-esc="!sending"
    @update:show="(value) => !value && close()"
  >
    <p class="multi-npc-repeat-modal__description">
      选择当前频道中的多个角色，以它们的身份重新发送这条消息。可立即连续发送，也可设置每条消息之间的间隔。
    </p>

    <NSpin :show="loading">
      <div v-if="identities.length" class="multi-npc-repeat-modal__roles">
        <NCheckboxGroup v-model:value="selectedIdentityIds" class="multi-npc-repeat-modal__role-grid">
          <label
            v-for="identity in identities"
            :key="identity.id"
            class="multi-npc-repeat-modal__role"
          >
            <NCheckbox :value="identity.id" :disabled="sending" />
            <AvatarVue
              :size="34"
              :border="false"
              :src="resolveAvatarSrc(identity)"
              :use-text-fallback="Boolean(identity.isTemporary || normalizeAvatarTextStyle(identity.avatarTextStyle))"
              :text-fallback-style="normalizeAvatarTextStyle(identity.avatarTextStyle)"
              :text-fallback-accent-color="identity.avatarTextStyle ? (chat.getActiveIdentityVariant(channelId, identity.id)?.color || identity.color) : undefined"
              :fallback-text="resolveDisplayName(identity)"
            />
            <span class="multi-npc-repeat-modal__role-name">{{ resolveDisplayName(identity) }}</span>
          </label>
        </NCheckboxGroup>
      </div>
      <div v-else class="multi-npc-repeat-modal__empty">
        当前频道没有可用的角色。
      </div>
    </NSpin>

    <div class="multi-npc-repeat-modal__settings">
      <span>发送间隔</span>
      <NInputNumber
        v-model:value="delaySeconds"
        :min="0"
        :max="30"
        :step="0.5"
        :disabled="sending"
        size="small"
        class="multi-npc-repeat-modal__delay"
      >
        <template #suffix>秒</template>
      </NInputNumber>
      <span class="multi-npc-repeat-modal__hint">0 秒表示立即连续发送</span>
    </div>

    <template #footer>
      <div class="multi-npc-repeat-modal__footer">
        <NButton :disabled="sending" @click="close">取消</NButton>
        <NButton
          type="primary"
          :loading="sending"
          :disabled="selectedCount === 0 || loading"
          @click="send"
        >
          发送 {{ selectedCount }} 条
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.multi-npc-repeat-modal__description {
  margin: 0 0 14px;
  color: var(--n-text-color-2);
  line-height: 1.6;
}

.multi-npc-repeat-modal__role-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.multi-npc-repeat-modal__role {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--n-border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.multi-npc-repeat-modal__role:hover {
  background: var(--n-color-hover);
  border-color: var(--n-border-color-hover);
}

.multi-npc-repeat-modal__role-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.multi-npc-repeat-modal__empty {
  padding: 28px 12px;
  color: var(--n-text-color-3);
  text-align: center;
}

.multi-npc-repeat-modal__settings {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}

.multi-npc-repeat-modal__delay {
  width: 128px;
}

.multi-npc-repeat-modal__hint {
  color: var(--n-text-color-3);
  font-size: 12px;
}

.multi-npc-repeat-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@media (max-width: 560px) {
  .multi-npc-repeat-modal__role-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .multi-npc-repeat-modal__settings {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .multi-npc-repeat-modal__hint {
    flex-basis: 100%;
  }
}
</style>
