export type EmotionCategory = 'basic' | 'subtle' | 'expressive'
export interface EmotionPreset {
  id: string
  category: EmotionCategory
  label: string
  description: string
  instruction: string
}
export const emotionCategories: ReadonlyArray<{ id: EmotionCategory; label: string }> = [
  { id: 'basic', label: '基础' }, { id: 'subtle', label: '细腻' }, { id: 'expressive', label: '表现型' },
]
export const emotionPresets: readonly EmotionPreset[] = [
  { id: 'happy', category: 'basic', label: '开心', description: '明亮而自然', instruction: '用开心、明亮、自然的语气朗读' },
  { id: 'excited', category: 'basic', label: '兴奋', description: '轻快而充满期待', instruction: '用兴奋、轻快、充满期待的语气朗读' },
  { id: 'calm', category: 'basic', label: '平静', description: '平稳而放松', instruction: '用平静、自然、放松的语气朗读' },
  { id: 'gentle', category: 'basic', label: '温柔', description: '轻柔而舒缓', instruction: '用温柔、轻柔、舒缓的语气朗读' },
  { id: 'sad', category: 'basic', label: '悲伤', description: '低沉而略带失落', instruction: '用悲伤、低沉、略带失落感的语气朗读' },
  { id: 'angry', category: 'basic', label: '愤怒', description: '强烈而清晰', instruction: '用愤怒、强烈但保持吐字清晰的语气朗读' },
  { id: 'nervous', category: 'basic', label: '紧张', description: '略显不安', instruction: '用紧张、略显不安的语气朗读，保持清晰' },
  { id: 'afraid', category: 'basic', label: '害怕', description: '胆怯而谨慎', instruction: '用害怕、胆怯、谨慎的语气朗读' },
  { id: 'surprised', category: 'basic', label: '惊讶', description: '意外而鲜明', instruction: '用惊讶、意外、语调鲜明的语气朗读' },
  { id: 'serious', category: 'basic', label: '严肃', description: '郑重而认真', instruction: '用严肃、郑重、认真的语气朗读' },
  { id: 'aggrieved', category: 'subtle', label: '委屈', description: '轻声诉说不平', instruction: '用委屈、轻声、略带不平的语气朗读' },
  { id: 'dejected', category: 'subtle', label: '沮丧', description: '低落而无力', instruction: '用沮丧、低落、略显无力的语气朗读' },
  { id: 'shy', category: 'subtle', label: '害羞', description: '含蓄而轻柔', instruction: '用害羞、含蓄、轻柔的语气朗读' },
  { id: 'playful', category: 'subtle', label: '俏皮', description: '灵动而轻快', instruction: '用俏皮、灵动、轻快的语气朗读' },
  { id: 'leisurely', category: 'subtle', label: '慵懒', description: '松弛而悠闲', instruction: '用慵懒、松弛、悠闲的语气朗读' },
  { id: 'tired', category: 'subtle', label: '疲惫', description: '倦怠而低缓', instruction: '用疲惫、倦怠、低缓但清晰的语气朗读' },
  { id: 'detached', category: 'subtle', label: '冷淡', description: '疏离而平淡', instruction: '用冷淡、疏离、情绪平淡的语气朗读' },
  { id: 'friendly', category: 'subtle', label: '亲切', description: '友好而自然', instruction: '用亲切、友好、自然的语气朗读' },
  { id: 'comforting', category: 'subtle', label: '安慰', description: '温暖而安抚', instruction: '用温暖、安抚、让人安心的语气朗读' },
  { id: 'worried', category: 'subtle', label: '担忧', description: '关切而不安', instruction: '用担忧、关切、略带不安的语气朗读' },
  { id: 'resolute', category: 'expressive', label: '坚定', description: '笃定而有力', instruction: '用坚定、笃定、有力的语气朗读' },
  { id: 'urgent', category: 'expressive', label: '急切', description: '迫切而清楚', instruction: '用急切、迫切但吐字清楚的语气朗读' },
  { id: 'mysterious', category: 'expressive', label: '神秘', description: '低缓而含蓄', instruction: '用神秘、低缓、含蓄的语气朗读' },
  { id: 'gloomy', category: 'expressive', label: '阴沉', description: '沉郁而压抑', instruction: '用阴沉、沉郁、略带压抑感的语气朗读' },
  { id: 'haughty', category: 'expressive', label: '傲慢', description: '高傲而自负', instruction: '用傲慢、高傲、自负的语气朗读' },
  { id: 'sarcastic', category: 'expressive', label: '嘲讽', description: '冷淡而讽刺', instruction: '用嘲讽、冷淡、带有讽刺意味的语气朗读' },
  { id: 'provocative', category: 'expressive', label: '挑衅', description: '带有挑战意味', instruction: '用挑衅、带有挑战意味但清晰的语气朗读' },
  { id: 'agitated', category: 'expressive', label: '激动', description: '情绪饱满而鲜明', instruction: '用激动、情绪饱满、语调鲜明的语气朗读' },
  { id: 'restrained', category: 'expressive', label: '克制', description: '冷静而收敛', instruction: '用克制、冷静、压低情绪起伏的语气朗读' },
  { id: 'whisper', category: 'expressive', label: '低语', description: '轻声而清晰', instruction: '用轻声、贴近耳语但保持清晰的方式朗读' },
]

// Presets are explicit selections, never inferred from a role's saved instruction.
export function selectedEmotion(instruction: string | undefined, presetId?: string) {
  return instruction === undefined ? undefined : emotionPresets.find(preset => preset.id === presetId && preset.instruction === instruction)
}
