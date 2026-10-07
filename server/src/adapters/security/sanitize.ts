/**
 * Санитизация текста для WS-логов. Контракт фронта: в текст лога допустим
 * только <b>…</b>, всё остальное — как текст. Экранируем ВСЁ, затем возвращаем
 * обратно единственный безопасный тег. Так имя мерчанта вида "<img onerror=…>"
 * станет текстом, а не исполнится (XSS). Граница — здесь, на сервере.
 */
const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE[c] ?? c);
}

/** Экранирует всё, кроме <b>/</b>. Длину ограничиваем (анти-флуд логов). */
export function safeLogText(input: unknown, max = 300): string {
  const s = typeof input === 'string' ? input : String(input ?? '');
  return escapeHtml(s.slice(0, max)).replace(/&lt;(\/?)b&gt;/g, '<$1b>');
}

/** Обычный текст без какого-либо HTML (имена, ремарки) — для REST/БД. */
export function plainText(input: unknown, max = 300): string {
  const s = typeof input === 'string' ? input : String(input ?? '');
  // убираем управляющие символы и обрезаем
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
