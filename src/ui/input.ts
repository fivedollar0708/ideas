/**
 * 录入控制器。
 *
 * 这个文件的全部价值在于"不丢字"：
 *  - 中文输入法打字途中不能误提交
 *  - 空输入不产生垃圾记录
 *  - 超长要截断并告知，而不是默默吃掉
 *  - 🔴 写入失败时**保留原文**，不能让用户白打一遍
 *
 * 阶段 1 只有"回车即存"，飞入动画在阶段 4 接入，届时复用同一个控制器。
 */

import { clampText, norm } from '../text';
import { MAX_TEXT } from '../types';

/** 提示的种类，决定样式。 */
export type NoticeKind = 'info' | 'warn' | 'error';

export interface InputOptions {
  el: HTMLTextAreaElement;
  /** 收到一条合法文本时调用。抛错表示没存上，输入框会保留原文。 */
  onSubmit(text: string): void | Promise<void>;
  /** 展示一行提示。 */
  onNotice?(message: string, kind: NoticeKind): void;
}

export interface InputHandle {
  destroy(): void;
  focus(): void;
}

export function mountInput(options: InputOptions): InputHandle {
  const { el, onSubmit, onNotice } = options;

  /** 是否处于输入法组字中。 */
  let composing = false;
  /** 上一次提交还没结束，避免并发写。 */
  let busy = false;

  const autoGrow = (): void => {
    // 一次性布局更新（不是逐帧动画），不受"动画只准动 transform"的约束
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  };

  async function submit(): Promise<void> {
    if (busy) return;

    const cleaned = norm(el.value);
    if (cleaned === '') {
      onNotice?.('空的，没有记下', 'warn');
      return;
    }

    const { text, clipped } = clampText(cleaned, MAX_TEXT);
    if (clipped) onNotice?.(`超过 ${MAX_TEXT} 字，已截断`, 'warn');

    busy = true;
    try {
      await onSubmit(text);
      // 🔴 只有确认真写进去了才清空输入框。
      //    若在 await 之前就清空，写失败时用户的字就没了。
      el.value = '';
      autoGrow();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onNotice?.(`没存上：${message}`, 'error');
      // 原文保留在输入框里，用户可以直接再按一次回车重试
    } finally {
      busy = false;
    }
  }

  const onCompositionStart = (): void => {
    composing = true;
  };

  const onCompositionEnd = (): void => {
    composing = false;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;

    // Shift + 回车 = 输入框内换行，不提交
    if (e.shiftKey) return;

    // 🔴 中文输入法守卫，三道都要：
    //    composing —— 自己跟踪的组字状态
    //    e.isComposing —— 浏览器给的标准标记
    //    keyCode === 229 —— 部分输入法在组字期间给的是 229
    //    漏了这道守卫，打拼音时每按一次回车都会提交一段半成品拼音。
    if (composing || e.isComposing || e.keyCode === 229) return;

    e.preventDefault();
    void submit();
  };

  const onInput = (): void => {
    autoGrow();
  };

  el.addEventListener('compositionstart', onCompositionStart);
  el.addEventListener('compositionend', onCompositionEnd);
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('input', onInput);

  autoGrow();

  return {
    focus: () => el.focus(),
    destroy: () => {
      el.removeEventListener('compositionstart', onCompositionStart);
      el.removeEventListener('compositionend', onCompositionEnd);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('input', onInput);
    },
  };
}
