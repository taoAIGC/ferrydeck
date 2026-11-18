// 分组的模型类别：主窗口和菜单栏面板共用同一套识别规则，两边的分类才会一致。
import { BUILTIN_CATEGORIES, CLIENT_ORDER, type CategoryId, type ClientId, type CustomCategory, type GroupView } from "./types";

/** 按模型名识别类别（小写匹配）。一个分组里有几类模型就属于几类。 */
const CATEGORY_RULES: [CategoryId, RegExp][] = [
  ["claude", /^claude|anthropic|^fable|^opus|^sonnet|^haiku/],
  ["openai", /^gpt(?!.*image)|^o[134](-|$)|^chatgpt|^codex|^text-davinci/],
  ["gemini", /^gemini(?!.*image)/],
  ["deepseek", /deepseek/],
  ["cn", /kimi|moonshot|^glm|zhipu|qwen|qwq|ernie|^doubao(?!.*seed(ance|ream))|hunyuan|minimax|^yi-|baichuan|^spark|^step-|^mimo|longcat/],
  ["image", /image|dall-?e|^flux|midjourney|^mj|sdxl|stable-?diffusion|imagen|nano-?banana|seedream|^sd[0-9]/],
  ["video", /video|^sora|^veo|kling|seedance|runway|^wan|hailuo|^pika|^vidu|cogvideo/],
  ["audio", /tts|whisper|audio|speech|^suno|asr|transcribe|voice|^music/],
  ["embed", /embed|rerank|^bge-/],
];
const PLATFORM_CATEGORY: Record<string, CategoryId> = { anthropic: "claude", openai: "openai", gemini: "gemini" };
const CATEGORY_CLIENTS: Partial<Record<CategoryId, ClientId[]>> = { claude: ["claude", "claude_desktop"], openai: ["codex"], gemini: ["gemini"] };

export interface CategoryInfo {
  id: CategoryId;
  name: string;
  tip: string;
  custom?: boolean;
}

/** 全部类别（界面顺序）：内置的（不含“其他”）→ 自定义的 → 其他。 */
export function allCategories(custom: CustomCategory[]): CategoryInfo[] {
  return [
    ...BUILTIN_CATEGORIES.filter((c) => c.id !== "other"),
    ...custom.map((c) => ({ id: c.id, name: c.name, tip: c.keywords.length ? `自定义类别：模型名或分组名里含 ${c.keywords.join("、")}` : "自定义类别（还没设置关键词，只能手动归类）", custom: true })),
    ...BUILTIN_CATEGORIES.filter((c) => c.id === "other"),
  ];
}

/** 自动识别分组的类别：站点给的平台 + 模型名 + 自定义类别的关键词。识别不出就是“其他”。 */
export function inferCategories(g: GroupView, models: string[], custom: CustomCategory[]): CategoryId[] {
  const found = new Set<CategoryId>();
  const p = PLATFORM_CATEGORY[g.platform];
  if (p) found.add(p);
  const lower = models.map((m) => m.toLowerCase());
  for (const l of lower) for (const [c, re] of CATEGORY_RULES) if (re.test(l)) found.add(c);
  const hay = [g.name.toLowerCase(), ...lower];
  for (const c of custom) if (c.keywords.some((k) => k && hay.some((h) => h.includes(k)))) found.add(c.id);
  return found.size ? allCategories(custom).map((c) => c.id).filter((c) => found.has(c)) : ["other"];
}

/** 分组的类别：手动设置的优先，否则自动识别。 */
export function categoriesOf(g: GroupView, models: string[], custom: CustomCategory[]): CategoryId[] {
  return g.categories && g.categories.length ? g.categories : inferCategories(g, models, custom);
}

/**
 * 这个分组能一键配置到哪些客户端。sub2api 和手动设置过类别的，以后端给的为准；
 * new-api 没有平台分类，后端允许配到任何客户端：模型名认出了 Claude / OpenAI / Gemini 就收窄到对应的客户端，认不出就保持都能配（宁可多给，别让用户没法配）。
 */
export function clientsOf(g: GroupView, models: string[], custom: CustomCategory[]): ClientId[] {
  if (!g.clients_inferred) return g.clients;
  const cats = inferCategories(g, models, custom);
  const hit = CLIENT_ORDER.filter((c) => cats.some((cat) => CATEGORY_CLIENTS[cat]?.includes(c)));
  return hit.length ? hit : g.clients;
}
