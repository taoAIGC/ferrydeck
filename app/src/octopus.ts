/**
 * 章鱼小动画（主窗口和菜单栏面板共用）：
 * - octopusSpinner：测速时在时延列里旋转，直到出结果
 * - octopusWorking：配置某个分组时，腿一前一后地划动，像在干活
 */

const LEGS = [
  "M32 50 C 24 58, 14 60, 12 70",
  "M38 54 C 34 64, 30 70, 32 80",
  "M44 56 C 44 66, 44 72, 44 80",
  "M50 54 C 54 64, 58 70, 56 80",
  "M56 50 C 64 58, 74 60, 76 70",
];
const BODY = "M44 8 C 60 8, 68 20, 68 32 C 68 46, 58 54, 44 54 C 30 54, 20 46, 20 32 C 20 20, 28 8, 44 8 Z";

function markup(size: number): string {
  const legs = LEGS.map((d) => `<path class="octo-leg" d="${d}"/>`).join("");
  return (
    `<svg viewBox="0 0 88 88" width="${size}" height="${size}" aria-hidden="true">` +
    `<g class="octo-legs" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round">${legs}</g>` +
    `<g class="octo-body"><path d="${BODY}" fill="currentColor"/><circle cx="36" cy="32" r="5" fill="var(--panel, #fff)"/><circle cx="52" cy="32" r="5" fill="var(--panel, #fff)"/></g>` +
    `</svg>`
  );
}

function make(cls: string, size: number, label: string, tid?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = cls;
  span.title = label;
  span.setAttribute("aria-label", label);
  if (tid) span.setAttribute("data-testid", tid);
  span.innerHTML = markup(size);
  return span;
}

/** 测速中：整只章鱼旋转。 */
export function octopusSpinner(tid: string): HTMLElement {
  return make("octo-spin", 18, "测速中…", `probing-${tid}`);
}

/** 配置中：章鱼原地不动，五条腿依次划动。 */
export function octopusWorking(size = 20): HTMLElement {
  return make("octo-work", size, "配置中…", "octo-working");
}
