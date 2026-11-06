import { invoke } from "@tauri-apps/api/core";
import type { Backend } from "./types";
import { createMockBackend } from "./mock";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 错误统一转成可读字符串：Rust 命令返回的是字符串，其他情况兜底。 */
function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "未知错误");
  });
}

function createTauriBackend(): Backend {
  // 已发现的更新对象，安装时复用
  let pending: import("@tauri-apps/plugin-updater").Update | null = null;
  return {
    appVersion: async () => (await import("@tauri-apps/api/app")).getVersion(),
    checkUpdate: async () => {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await wrap(check());
      pending = u;
      return u ? { version: u.version, notes: u.body ?? null } : null;
    },
    installUpdate: async () => {
      if (!pending) throw new Error("没有可安装的更新");
      await wrap(pending.downloadAndInstall());
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
    loadSites: () => wrap(invoke("load_sites")),
    detectSite: (url) => wrap(invoke("detect_site", { baseUrl: url })),
    addSite: ({ baseUrl, name, username, password }) => wrap(invoke("add_site", { baseUrl, name: name ?? null, username, password })),
    removeSite: (siteId) => wrap(invoke("remove_site", { siteId })),
    refreshAccounts: () => wrap(invoke("refresh_accounts")),
    listGroups: () => wrap(invoke("list_groups")),
    overview: () => wrap(invoke("overview")),
    enableGroup: (siteId, groupId, client, model) => wrap(invoke("enable_group", { siteId, groupId, client, model: model ?? null })),
    groupModels: (siteId, groupId) => wrap(invoke("group_models", { siteId, groupId })),
    topupUrl: (siteId) => wrap(invoke("topup_url", { siteId })),
    openUrl: async (url) => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
  };
}

export const backend: Backend = inTauri ? createTauriBackend() : createMockBackend();
export const isMock = !inTauri;
