//! 应用状态：已添加的站点及其登录会话。

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, RwLock};

use crate::paths::Paths;
use crate::service::GroupView;
use crate::session_store;
use crate::sites::{self, AccountInfo, Kind, Site, SiteClient};

pub struct SiteRuntime {
    pub site: Site,
    /// 是否声明为站点管理员（可变，随登录时的勾选更新；保存时写回 `site.is_admin`）。
    pub admin: std::sync::atomic::AtomicBool,
    pub client: SiteClient,
    pub account: AsyncMutex<Option<AccountInfo>>,
    /// 最近一次出错的原因（登录过期、网络问题等），用于界面提示。
    pub error: AsyncMutex<Option<String>>,
    /// 应用数据目录（登录凭据存在这里）。
    pub data_dir: std::path::PathBuf,
    /// 最近一次成功拉到的分组。网络抖动、登录恢复中拉取失败时继续显示它，避免分组忽有忽无。
    pub last_groups: AsyncMutex<Option<Vec<crate::sites::GroupInfo>>>,
    /// 上面这份分组是什么时候拉到的（unix 秒）。菜单栏面板反复打开时，用它避免每次都向站点要一遍。
    pub last_groups_at: std::sync::atomic::AtomicI64,
    /// 分组成本统计的缓存（分组 id -> 结果），约 10 分钟内不重复向站点取数。
    pub usage_cache: std::sync::Mutex<std::collections::HashMap<String, crate::usage::GroupUsage>>,
}

pub struct AppState {
    pub paths: Paths,
    pub sites: RwLock<Vec<Arc<SiteRuntime>>>,
    /// 最近一次汇总到的分组，用来生成菜单栏菜单。
    pub groups: Mutex<Vec<GroupView>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SiteView {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub base_url: String,
    pub connected: bool,
    pub account: Option<AccountInfo>,
    pub error: Option<String>,
    /// 凭据已失效或不存在，只能重新登录；为 false 而未连接时是网络等暂时性问题，会自动重试。
    pub needs_login: bool,
    /// 登录时勾选了“我是该站点管理员”
    pub is_admin: bool,
}

impl AppState {
    pub fn new(paths: Paths) -> Self {
        AppState { paths, sites: RwLock::new(vec![]), groups: Mutex::new(vec![]) }
    }

    /// 建立站点运行时。凭据轮换时自动写回应用数据目录。
    pub fn make_runtime(paths: &Paths, site: Site) -> Arc<SiteRuntime> {
        let id = site.id.clone();
        let data_dir = paths.data.clone();
        let sink: sites::SecretSink = Arc::new(move |secret| session_store::save(&data_dir, &id, &secret));
        let client = SiteClient::new(site.kind, &site.base_url, sink);
        Arc::new(SiteRuntime { admin: std::sync::atomic::AtomicBool::new(site.is_admin), site, client, account: AsyncMutex::new(None), error: AsyncMutex::new(None), data_dir: paths.data.clone(), last_groups: AsyncMutex::new(None), last_groups_at: std::sync::atomic::AtomicI64::new(0), usage_cache: Default::default() })
    }

    pub async fn find(&self, id: &str) -> Result<Arc<SiteRuntime>, String> {
        self.sites.read().await.iter().find(|r| r.site.id == id).cloned().ok_or_else(|| "站点不存在".to_string())
    }

    pub async fn views(&self) -> Vec<SiteView> {
        let mut out = vec![];
        for r in self.sites.read().await.iter() {
            out.push(r.view().await);
        }
        out
    }

    pub async fn persist_sites(&self) -> Result<(), String> {
        let list: Vec<Site> = self.sites.read().await.iter().map(|r| Site { is_admin: r.admin.load(std::sync::atomic::Ordering::Relaxed), ..r.site.clone() }).collect();
        // 备忘写失败不影响主流程（它只用来在数据被误删后提示用户）
        let _ = sites::save_known_sites(&self.paths.ferrydeck_home, &list);
        sites::save_sites(&self.paths.data, &list)
    }
}

impl SiteRuntime {
    pub async fn view(&self) -> SiteView {
        let account = self.account.lock().await.clone();
        let error = self.error.lock().await.clone();
        let logged_in = self.client.is_logged_in().await;
        let needs_login = !logged_in || error.as_deref().is_some_and(sites::is_expired);
        SiteView { id: self.site.id.clone(), kind: self.site.kind, name: self.site.name.clone(), base_url: self.site.base_url.clone(), connected: account.is_some() && logged_in, account, error, needs_login, is_admin: self.admin.load(std::sync::atomic::Ordering::Relaxed) }
    }

    pub async fn set_error(&self, e: Option<String>) {
        *self.error.lock().await = e;
    }

    /// 确保登录可用并更新账号信息：还没恢复登录就用钥匙串里的凭据恢复。
    /// 凭据已被站点明确拒绝的不再自动重试（免得反复请求站点），等用户重新登录。
    pub async fn reconnect(&self) {
        if !self.client.is_logged_in().await {
            if self.error.lock().await.as_deref().is_some_and(sites::is_expired) {
                return;
            }
            let Some(secret) = session_store::load(&self.data_dir, &self.site.id) else {
                self.set_error(Some("需要重新登录".into())).await;
                return;
            };
            if let Err(e) = self.client.resume(&secret).await {
                self.set_error(Some(e)).await;
                return;
            }
        }
        match self.client.me().await {
            Ok(acc) => {
                *self.account.lock().await = Some(acc);
                self.set_error(None).await;
            }
            Err(e) => self.set_error(Some(e)).await,
        }
    }
}
