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
    pub client: SiteClient,
    pub account: AsyncMutex<Option<AccountInfo>>,
    /// 最近一次出错的原因（登录过期、网络问题等），用于界面提示。
    pub error: AsyncMutex<Option<String>>,
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
}

impl AppState {
    pub fn new(paths: Paths) -> Self {
        AppState { paths, sites: RwLock::new(vec![]), groups: Mutex::new(vec![]) }
    }

    /// 建立站点运行时。凭据轮换时自动写回钥匙串。
    pub fn make_runtime(site: Site) -> Arc<SiteRuntime> {
        let id = site.id.clone();
        let sink: sites::SecretSink = Arc::new(move |secret| session_store::save(&id, &secret));
        let client = SiteClient::new(site.kind, &site.base_url, sink);
        Arc::new(SiteRuntime { site, client, account: AsyncMutex::new(None), error: AsyncMutex::new(None) })
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
        let list: Vec<Site> = self.sites.read().await.iter().map(|r| r.site.clone()).collect();
        sites::save_sites(&self.paths.data, &list)
    }
}

impl SiteRuntime {
    pub async fn view(&self) -> SiteView {
        let account = self.account.lock().await.clone();
        SiteView { id: self.site.id.clone(), kind: self.site.kind, name: self.site.name.clone(), base_url: self.site.base_url.clone(), connected: account.is_some() && self.client.is_logged_in().await, account, error: self.error.lock().await.clone() }
    }

    pub async fn set_error(&self, e: Option<String>) {
        *self.error.lock().await = e;
    }
}
