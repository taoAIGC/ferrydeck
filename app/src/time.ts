/** “刷新时间”的中文相对写法：刚刚刷新 / N秒前刷新 / N分钟前刷新 / N小时前刷新 / N天前刷新。 */
export function agoText(sec: number, nowMs: number = Date.now()): string {
  if (sec <= 0) return "";
  const d = Math.max(0, Math.floor(nowMs / 1000 - sec));
  if (d < 5) return "刚刚刷新";
  if (d < 60) return `${d}秒前刷新`;
  if (d < 3600) return `${Math.floor(d / 60)}分钟前刷新`;
  if (d < 86400) return `${Math.floor(d / 3600)}小时前刷新`;
  return `${Math.floor(d / 86400)}天前刷新`;
}

/** 完整的日期时间，放在鼠标悬停提示里。 */
export function fullTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 让页面上带 `data-ago` 属性的元素每隔几秒自己更新文字，不触发整页重绘
 * （整页重绘会打断正在展开的下拉框，也没必要）。属性值是 unix 秒。
 */
export function startAgoTicker(intervalMs = 5000): void {
  window.setInterval(() => {
    document.querySelectorAll<HTMLElement>("[data-ago]").forEach((e) => {
      const sec = Number(e.dataset.ago);
      if (sec <= 0) return;
      e.textContent = agoText(sec);
      // 悬停提示里也带着“N 秒前”，同样要跟着变；模板里用 {ago} 占位
      const tpl = e.dataset.tipTpl;
      if (tpl) e.dataset.tip = tpl.replace("{ago}", agoText(sec));
    });
  }, intervalMs);
}
