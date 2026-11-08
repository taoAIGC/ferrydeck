/**
 * 主窗口的悬停相关逻辑。
 *
 * 1. 行 / 站点卡的“悬停”状态（`.is-hover`）由脚本根据鼠标位置维护，而不是靠 CSS `:hover`。
 *    原因：界面每次重绘都会把节点整个换掉（测速时尤其频繁），鼠标正下方的新节点不会立刻得到 `:hover`，
 *    鼠标移开后旧状态也可能残留，表现为“启动图标不消失”。脚本在每次重绘后都按鼠标最后的位置重新算一遍。
 * 2. 快速提示（`data-tip`）：系统自带的 `title` 提示要停留一两秒才出现，用户着急看失败原因时太慢。
 *    带 `data-tip` 的元素鼠标一停上去约 0.1 秒就显示。
 */

let mx = -1;
let my = -1;
let inside = false;

let tipEl: HTMLDivElement | null = null;
let tipFor: Element | null = null;
let tipTimer: number | undefined;
const TIP_DELAY_MS = 90;

function hideTip() {
  window.clearTimeout(tipTimer);
  tipTimer = undefined;
  tipFor = null;
  if (tipEl) tipEl.style.display = "none";
}

function showTip(target: HTMLElement) {
  const text = target.dataset.tip;
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "fd-tip";
    tipEl.id = "fd-tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.append(tipEl); // 放在 #app 外面，界面重绘不会把它清掉
  }
  tipEl.textContent = text;
  tipEl.style.display = "block";
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6); // 下面放不下就放上面
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
  tipFor = target;
}

/** 按鼠标当前位置重新计算：哪张卡处于悬停、该显示哪条快速提示。每次重绘后、鼠标移动时、滚动时都会调用。 */
export function syncHover(): void {
  const under = inside ? document.elementFromPoint(mx, my) : null;

  const card = under?.closest(".card:not(.list-head), .site-card, .panel-row") ?? null;
  document.querySelectorAll(".card.is-hover, .site-card.is-hover, .panel-row.is-hover").forEach((e) => {
    if (e !== card) e.classList.remove("is-hover");
  });
  card?.classList.add("is-hover");

  const tip = (under?.closest("[data-tip]") as HTMLElement | null) ?? null;
  if (!tip) {
    if (tipFor || tipTimer) hideTip();
  } else if (tip !== tipFor) {
    // 换了一个元素（或重绘后换成了同位置的新节点）：先收起旧的，稍等一下再显示新的
    const keepShown = tipFor !== null && tipEl !== null && tipEl.textContent === tip.dataset.tip && tipEl.style.display === "block";
    hideTip();
    if (keepShown) showTip(tip);
    else tipTimer = window.setTimeout(() => showTip(tip), TIP_DELAY_MS);
  }
}

export function initHover(): void {
  document.addEventListener(
    "mousemove",
    (e) => {
      mx = e.clientX;
      my = e.clientY;
      inside = true;
      syncHover();
    },
    { passive: true },
  );
  // 鼠标离开窗口
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) {
      inside = false;
      syncHover();
    }
  });
  // 滚动时鼠标下面的内容变了
  document.addEventListener("scroll", () => syncHover(), { capture: true, passive: true });
  window.addEventListener("blur", () => {
    inside = false;
    syncHover();
  });
}
