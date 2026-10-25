import type { GeneratedAvatarStyle } from './generatedAvatarImage'

export const normalizeAvatarTextStyle = (value: unknown): GeneratedAvatarStyle | '' => (
  value === 'a' || value === 'b' || value === 'c' ? value : ''
)
