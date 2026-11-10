//! 分组成本统计：近 7 天实际花了多少钱、用了多少 token、缓存命中率、真实首字时延，以及按官方价和倍率的预估。
//!
//! 数据来自站点自己的用量记录（sub2api 的 `/usage/*`，new-api 的 `/api/log/self`），只读元数据，不涉及对话内容。
//!
//! 口径（和界面上的说明一致）：
//! - **有效 token = 输入 + 输出**，缓存读取 / 缓存创建单独列出，不混进去（缓存读取很便宜，混进去会让成本看起来虚低）。
//! - **每百万有效 token 成本 = 实付总额 ÷ 有效 token × 100 万**。实付包含了缓存的花费，所以这个数是“为这些有效 token 实际付出的钱”。
//! - **缓存命中率 = 缓存读取 ÷ (输入 + 缓存创建 + 缓存读取)**，即有多大比例的输入是从缓存里读的。
//! - **实际倍率 = 实付 ÷ 官方价**（sub2api 才有官方价）：和模型无关，可以直接比较不同分组。

use serde::Serialize;

/// 统计窗口：最近 7 天。
pub const WINDOW_DAYS: u32 = 7;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ModelUsage {
    pub model: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    /// 实付（站点货币）。
    pub cost: f64,
    /// 该模型每百万有效 token 的实付成本；有效 token 为 0 时没有。
    pub cost_per_m_effective: Option<f64>,
}

/// 按官方价和倍率算出来的预估价格，单位：站点货币 / 百万 token。已经乘过分组倍率。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct PriceEstimate {
    pub model: String,
    pub input_per_m: f64,
    pub output_per_m: f64,
    pub cache_read_per_m: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct GroupUsage {
    pub window_days: u32,
    /// 货币符号：`$`、`¥`…；new-api 显示为“额度”时是“额度”。
    pub currency: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    /// 输入 + 输出。
    pub effective_tokens: i64,
    /// 实付总额。
    pub cost: f64,
    /// 官方价合计（只有 sub2api 有）。
    pub official_cost: Option<f64>,
    pub cost_per_m_effective: Option<f64>,
    pub cache_hit_rate: Option<f64>,
    /// 实付 ÷ 官方价。
    pub actual_multiplier: Option<f64>,
    /// 站点标称的分组倍率。
    pub nominal_multiplier: f64,
    /// 真实请求的首字时延（毫秒）：中位数和 P90，以及样本数。
    pub first_token_median_ms: Option<u64>,
    pub first_token_p90_ms: Option<u64>,
    pub first_token_samples: usize,
    pub avg_duration_ms: Option<f64>,
    /// 过去 24 小时的 Token 总量（输入 + 输出 + 缓存），代表这个分组 / 上游的重要程度。只有站长视角会算。
    pub tokens_24h: Option<i64>,
    /// 只统计了最近一部分记录，真实值比这个大。
    pub tokens_24h_capped: bool,
    /// 过去 24 小时的流水：用户实付（站点货币）和官方价口径的合计（只有 sub2api 有）。下游分组的收入 = 实付；上游账号的成本 = 官方价 × 上游倍率。
    pub cost_24h: Option<f64>,
    pub official_cost_24h: Option<f64>,
    /// 只统计了最近一部分请求（new-api 按日志翻页，有上限）：这里是实际统计的条数，`total_requests` 是窗口内的总条数。
    pub sampled: bool,
    pub sample_requests: usize,
    pub total_requests: i64,
    pub models: Vec<ModelUsage>,
    pub estimates: Vec<PriceEstimate>,
    /// 取数时间（unix 秒）。
    pub fetched_at: i64,
    /// 需要告诉用户的情况（比如站点没有开放某项统计）。
    pub notes: Vec<String>,
}

/// 每百万有效 token 的成本。有效 token 为 0 时没有意义。
pub fn cost_per_m(cost: f64, effective_tokens: i64) -> Option<f64> {
    (effective_tokens > 0 && cost >= 0.0).then(|| cost / effective_tokens as f64 * 1_000_000.0)
}

/// 缓存命中率：缓存读取 ÷ (输入 + 缓存创建 + 缓存读取)。没有任何输入时没有意义。
pub fn cache_hit_rate(input: i64, cache_creation: i64, cache_read: i64) -> Option<f64> {
    let total = input + cache_creation + cache_read;
    (total > 0).then(|| cache_read as f64 / total as f64)
}

/// 百分位（最近邻法）。`p` 取 0.0 ~ 1.0。样本为空返回 None。
pub fn percentile(values: &mut [u64], p: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let rank = ((values.len() as f64) * p).ceil().max(1.0) as usize;
    Some(values[rank.min(values.len()) - 1])
}

impl GroupUsage {
    /// 由各项原始累计值补全派生指标。
    pub fn finish(&mut self) {
        self.effective_tokens = self.input_tokens + self.output_tokens;
        self.cost_per_m_effective = cost_per_m(self.cost, self.effective_tokens);
        self.cache_hit_rate = cache_hit_rate(self.input_tokens, self.cache_creation_tokens, self.cache_read_tokens);
        self.actual_multiplier = match self.official_cost {
            Some(o) if o > 0.0 => Some(self.cost / o),
            _ => None,
        };
        for m in &mut self.models {
            m.cost_per_m_effective = cost_per_m(m.cost, m.input_tokens + m.output_tokens);
        }
        // 花得多的模型排前面
        self.models.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal).then(b.requests.cmp(&a.requests)));
    }

    /// 近 7 天没有任何用量。
    pub fn is_empty(&self) -> bool {
        self.requests == 0 && self.effective_tokens == 0
    }
}

/// 把首字时延样本整理成中位数和 P90。
pub fn latency_summary(mut samples: Vec<u64>) -> (Option<u64>, Option<u64>, usize) {
    let n = samples.len();
    let median = percentile(&mut samples, 0.5);
    let p90 = percentile(&mut samples, 0.9);
    (median, p90, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_per_million_effective_tokens() {
        assert_eq!(cost_per_m(1.5, 3_000_000), Some(0.5));
        assert_eq!(cost_per_m(0.0, 1_000), Some(0.0));
        assert_eq!(cost_per_m(1.0, 0), None, "没有有效 token 就没有成本可言");
    }

    #[test]
    fn cache_hit_rate_counts_reads_over_all_input_side_tokens() {
        assert_eq!(cache_hit_rate(100, 100, 800), Some(0.8));
        assert_eq!(cache_hit_rate(100, 0, 0), Some(0.0));
        assert_eq!(cache_hit_rate(0, 0, 0), None);
    }

    #[test]
    fn percentiles_use_nearest_rank() {
        let mut v = vec![900, 100, 500, 300, 700];
        assert_eq!(percentile(&mut v, 0.5), Some(500));
        assert_eq!(percentile(&mut v, 0.9), Some(900));
        assert_eq!(percentile(&mut [], 0.5), None);
        assert_eq!(percentile(&mut [42], 0.9), Some(42));
        assert_eq!(latency_summary(vec![]).2, 0);
    }

    #[test]
    fn finish_derives_everything_and_sorts_models_by_spend() {
        let mut u = GroupUsage {
            input_tokens: 600_000,
            output_tokens: 400_000,
            cache_creation_tokens: 100_000,
            cache_read_tokens: 300_000,
            cost: 2.0,
            official_cost: Some(4.0),
            models: vec![
                ModelUsage { model: "cheap".into(), input_tokens: 100, output_tokens: 100, cost: 0.1, requests: 1, ..Default::default() },
                ModelUsage { model: "big".into(), input_tokens: 500_000, output_tokens: 300_000, cost: 1.9, requests: 5, ..Default::default() },
            ],
            ..Default::default()
        };
        u.finish();
        assert_eq!(u.effective_tokens, 1_000_000);
        assert_eq!(u.cost_per_m_effective, Some(2.0));
        assert_eq!(u.cache_hit_rate, Some(300_000.0 / 1_000_000.0));
        assert_eq!(u.actual_multiplier, Some(0.5));
        assert_eq!(u.models[0].model, "big");
        assert_eq!(u.models[0].cost_per_m_effective, Some(1.9 / 800_000.0 * 1_000_000.0));
        assert!(!u.is_empty());
        assert!(GroupUsage::default().is_empty());
    }
}
