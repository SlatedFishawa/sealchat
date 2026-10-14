import dayjs from 'dayjs';

export type WorldInviteStatusState = 'missing' | 'invalid' | 'warning' | 'ok';

export interface WorldInviteStatusInfo {
  state: WorldInviteStatusState;
  text: string;
  tagType: 'default' | 'error' | 'warning' | 'success';
}

export const remainingUses = (invite?: any) => {
  if (!invite || !invite.maxUse) return Infinity;
  const used = Number(invite.usedCount) || 0;
  return Math.max(invite.maxUse - used, 0);
};

export const isInviteExpired = (invite?: any) => {
  if (!invite?.expireAt) return false;
  const expireAt = dayjs(invite.expireAt);
  if (!expireAt.isValid()) return false;
  return expireAt.isBefore(dayjs());
};

export const isInviteExhausted = (invite?: any) => {
  if (!invite) return false;
  if (!invite.maxUse) return false;
  return remainingUses(invite) <= 0;
};

export const getInviteStatusInfo = (invite?: any): WorldInviteStatusInfo => {
  if (!invite) {
    return { state: 'missing', text: '未创建', tagType: 'default' };
  }
  if (isInviteExpired(invite)) {
    return { state: 'invalid', text: '已过期', tagType: 'error' };
  }
  if (isInviteExhausted(invite)) {
    return { state: 'invalid', text: '次数已用尽', tagType: 'error' };
  }
  const expireAt = invite?.expireAt ? dayjs(invite.expireAt) : null;
  if (expireAt?.isValid()) {
    const diffMinutes = expireAt.diff(dayjs(), 'minute');
    if (diffMinutes <= 60) {
      return { state: 'warning', text: '1 小时内过期', tagType: 'warning' };
    }
    if (diffMinutes <= 24 * 60) {
      const hours = Math.ceil(diffMinutes / 60);
      return { state: 'warning', text: `约 ${hours} 小时后过期`, tagType: 'warning' };
    }
  }
  if (invite?.maxUse > 0) {
    const remaining = remainingUses(invite);
    if (remaining <= 2) {
      return { state: 'warning', text: `仅剩 ${remaining} 次`, tagType: 'warning' };
    }
  }
  return { state: 'ok', text: '可用', tagType: 'success' };
};

/** Keeps the first (newest) invite per role, matching the server's created_at DESC order. */
export const pickLatestInviteByRole = (list: unknown): Record<string, any> => {
  const map: Record<string, any> = {};
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    const role = item?.role || 'member';
    if (!map[role]) {
      map[role] = item;
    }
  }
  return map;
};
