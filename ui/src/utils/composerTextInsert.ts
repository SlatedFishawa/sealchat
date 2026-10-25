import type { Editor } from '@tiptap/core';

// 输入框插入的通用实现：纯文本按选区替换并返回新光标；富文本在编辑器当前 selection 处插入纯文本。

/**
 * chatEvent：请求当前聊天输入框在光标/选区处插入纯文本。
 * payload: { content: string; channelId?: string }，channelId 不匹配当前频道时忽略。
 */
export const COMPOSER_INSERT_TEXT_EVENT = 'composer-insert-text';

export interface ComposerSelectionRange {
  start: number;
  end: number;
}

const clampIndex = (value: number, length: number) => {
  const numeric = Number.isFinite(value) ? Math.floor(value) : length;
  return Math.max(0, Math.min(length, numeric));
};

export const spliceTextAtSelection = (text: string, selection: ComposerSelectionRange, insert: string) => {
  const source = String(text || '');
  const start = clampIndex(Math.min(selection.start, selection.end), source.length);
  const end = clampIndex(Math.max(selection.start, selection.end), source.length);
  return {
    text: source.slice(0, start) + insert + source.slice(end),
    cursor: start + insert.length,
  };
};

export const insertTextIntoRichEditor = (editor: Pick<Editor, 'state' | 'view' | 'chain'>, content: string) => {
  const { from, to } = editor.state.selection;
  editor.view.dispatch(editor.state.tr.insertText(content, from, to).scrollIntoView());
  editor.chain().focus().run();
};

/** 用纯文本替换富文本编辑器的全部内容（例如补全整条快捷触发词）。 */
export const replaceRichEditorText = (editor: Pick<Editor, 'chain'>, content: string) => {
  editor.chain().focus().selectAll().insertContent(content).run();
};
