// 内置 LOG 样式的展示说明：只用于样式库的分类、简介与示意缩略图，不参与渲染与校验。
// 样式包协议没有描述字段，因此说明按内置包 id 维护在前端；私有样式与未知内置包没有条目。

export type LogStyleSketchKind = 'bubble' | 'compact' | 'script' | 'novel' | 'dossier' | 'terminal' | 'starter' | 'generic';

export interface LogBuiltinStyleInfo {
  id: string;
  /** 排版类别：说明这套样式的结构语言，而不是配色。 */
  category: string;
  /** 一句话说明它怎样组织信息。 */
  summary: string;
  /** 适合的 LOG 场景。 */
  scenes: string[];
  sketch: LogStyleSketchKind;
}

export const LOG_BUILTIN_STYLE_CATALOG: LogBuiltinStyleInfo[] = [
  {
    id: 'sealchat-bubble',
    category: '聊天现场',
    summary: '头像描边与气泡串保留群聊现场感，连续发言收拢成一组，系统消息是居中通知。',
    scenes: ['日常团与 RP 记录', '多人群聊', '有角色头像的团'],
    sketch: 'bubble',
  },
  {
    id: 'sealchat-compact',
    category: '高密度实录',
    summary: '小方头像列 + 行内署名，正文紧跟名字，轮次间一条细线；一页容纳更多发言，便于快速扫读与检索。',
    scenes: ['超长战役存档', '规则讨论与复盘', '打印成册备查'],
    sketch: 'compact',
  },
  {
    id: 'sealchat-script',
    category: '读本对白',
    summary: '角色名独占右对齐名列，括注写在名下，系统输出与旁白作为舞台指示缩进。',
    scenes: ['对白密集的团', '读剧本式回顾', '广播剧/配音台本'],
    sketch: 'script',
  },
  {
    id: 'sealchat-novel',
    category: '文学排版',
    summary: '衬线正文、首行缩进、台词自动加引号；场外退为旁注，一级标题另起一页。',
    scenes: ['剧情向长团', '跑团小说化整理', '印刷成书'],
    sketch: 'novel',
  },
  {
    id: 'sealchat-dossier',
    category: '卷宗笔录',
    summary: '每轮发言是带证件照的笔录，场外是红笔批注，检定是表格行，插图是证物照。',
    scenes: ['克苏鲁/调查团', '推理与刑侦', '证词与线索整理'],
    sketch: 'dossier',
  },
  {
    id: 'sealchat-terminal',
    category: '时间线日志',
    summary: '时间栏 + 贯穿的时间轴，每条消息是轴上的节点；深色屏幕，打印自动转浅底。',
    scenes: ['科幻/赛博朋克', '舰船与基地日志', '按时间复盘事件'],
    sketch: 'terminal',
  },
  {
    id: 'sealchat-starter',
    category: '起步骨架',
    summary: '只有最小结构的参照包，适合复制后从零编写自己的样式。',
    scenes: ['自制样式的起点'],
    sketch: 'starter',
  },
];

const BY_ID = new Map(LOG_BUILTIN_STYLE_CATALOG.map((info, index) => [info.id, { info, index }]));

export const builtinStyleInfo = (id: string): LogBuiltinStyleInfo | null => BY_ID.get(id)?.info || null;

/** 样式库排序：目录内的内置样式按目录顺序在前，其余（私有、未知）保持原顺序。 */
export const builtinStyleOrder = (id: string): number => BY_ID.get(id)?.index ?? Number.MAX_SAFE_INTEGER;
