// dsh-autoupdate — browser half (Settings page UI). NEW in v1.1.0.
//
// Served by the host at /plugins/dsh-autoupdate/client.js and executed by
// the dsh ModuleLoader (lazy CJS: this file only REGISTERS a factory; the
// factory body runs at materialization).
//
// What it does:
//   1. registers zh/en dictionaries with the locale service (namespace
//      "dsh-autoupdate")
//   2. injects a "settings.section" slot entry (id: dsh-autoupdate) whose
//      component renders the 检查更新 row + result modal
//   3. talks to the cordis backend over plain same-origin fetch:
//      POST /dsh-autoupdate/autoupdate/{status,check,apply}
//
// Anti-breaking rules (docs/COMPATIBILITY.zh.md):
//   - requires only "react" / "react/jsx-runtime" from the module table
//     (no primitives / no slots package import — everything else arrives via
//     ctx services or plain fetch)
//   - the entire factory body is guarded: any host-side API change makes the
//     UI silently absent, never a broken page
//   - text falls back to built-in dictionaries when the locale service or
//     the injected `t` prop is missing or throws
//   - styles use dsw design tokens with hardcoded fallbacks
window.__ModuleLoader__.load({
  id: "dsh-autoupdate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // ---- dictionaries (zh is the key-set source of truth) ----
    var zh = {
      "nav": "自动更新",
      "title": "检查更新",
      "desc": "手动检测并应用 dsh 新版本；更新在 dsh 退出后自动安装、验证，失败自动回滚。",
      "button": "检查更新",
      "checking": "正在检查更新…",
      "upToDate": "当前已是最新版本，暂无可用更新",
      "newVersion": "发现新版本",
      "currentVersion": "当前版本",
      "latestVersion": "最新版本",
      "channel": "更新通道",
      "confirm": "确认更新",
      "cancel": "取消",
      "close": "关闭",
      "armed": "更新已排定：dsh 退出后将自动完成安装与验证，重启后生效。",
      "armedTarget": "目标版本",
      "checkFailed": "检查更新失败",
      "applyFailed": "排定更新失败",
      "unavailable": "更新服务不可用（后台通道未注册或 dsh 接口已变更）。可手动执行：npm install -g @deepseek-ai/dsh@latest",
      "statusError": "无法读取更新状态",
      "versionUnknown": "未知",
      "disabled": "自动更新插件已禁用，请在配置中启用后重启 dsh。",
    };
    var en = {
      "nav": "Updates",
      "title": "Check for Updates",
      "desc": "Manually check for and apply new dsh releases; the update installs and verifies after dsh exits, with automatic rollback on failure.",
      "button": "Check for updates",
      "checking": "Checking for updates…",
      "upToDate": "You are up to date. No update is available.",
      "newVersion": "New version available",
      "currentVersion": "Current version",
      "latestVersion": "Latest version",
      "channel": "Channel",
      "confirm": "Update",
      "cancel": "Cancel",
      "close": "Close",
      "armed": "Update scheduled: it will install and verify after dsh exits, and takes effect on the next start.",
      "armedTarget": "Target version",
      "checkFailed": "Update check failed",
      "applyFailed": "Failed to schedule the update",
      "unavailable": "Update service unavailable (backend channel not registered or the dsh API changed). Manual command: npm install -g @deepseek-ai/dsh@latest",
      "statusError": "Could not read update status",
      "versionUnknown": "unknown",
      "disabled": "Auto-update is disabled. Enable it in configuration and restart dsh.",
    };

    // ---- styles (dsw tokens with hardcoded fallbacks) ----
    var CSS = [
      ".dsh-au-row{box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border,rgba(31,35,41,.12))}",
      ".dsh-au-texts{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
      ".dsh-au-title{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".dsh-au-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#646a73);overflow:hidden;text-overflow:ellipsis}",
      ".dsh-au-btn{flex:none;cursor:pointer;height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border,rgba(31,35,41,.15));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-family:inherit;font-size:13px;line-height:30px}",
      ".dsh-au-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(31,35,41,.06))}",
      ".dsh-au-btn:disabled{cursor:not-allowed;opacity:.5}",
      ".dsh-au-btn-primary{border-color:transparent;background:var(--dsw-alias-interactive-bg-primary,#1677ff);color:var(--dsw-alias-label-on-primary,#fff)}",
      ".dsh-au-btn-primary:hover{background:var(--dsw-alias-interactive-bg-primary-hover,#0f6bdb)}",
      ".dsh-au-overlay{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center}",
      ".dsh-au-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45))}",
      ".dsh-au-panel{position:relative;box-sizing:border-box;width:420px;max-width:calc(100vw - 48px);border-radius:16px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-shadow-lv3,0 8px 32px rgba(0,0,0,.18));padding:22px 22px 18px;display:flex;flex-direction:column;gap:14px}",
      ".dsh-au-modal-title{font-size:15px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary,#1f2329)}",
      ".dsh-au-modal-body{font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary,#1f2329);display:flex;flex-direction:column;gap:8px;word-break:break-all}",
      ".dsh-au-kv{display:flex;justify-content:space-between;gap:12px}",
      ".dsh-au-k{color:var(--dsw-alias-label-secondary,#646a73)}",
      ".dsh-au-v{font-family:var(--dsw-font-mono,ui-monospace,monospace)}",
      ".dsh-au-error{color:var(--dsw-alias-state-error-primary,#d83931)}",
      ".dsh-au-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}",
    ].join("");
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="dsh-autoupdate/ui"]') === null) {
      var styleTag = document.createElement("style");
      styleTag.dataset.plugin = "dsh-autoupdate";
      styleTag.dataset.pluginCss = "dsh-autoupdate/ui";
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
    }

    // ---- backend channel (plain same-origin fetch, no RPC framework) ----
    function callBackend(endpoint, payload) {
      var rpcId = (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      return fetch(location.origin + "/dsh-autoupdate/" + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: rpcId, method: endpoint, payload: payload || {} }),
      }).then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      }).then(function (env) {
        if (!env || env.type !== "server-response" || env.rpcId !== rpcId) throw new Error("Invalid update service response");
        if (env && env.result && env.result.ok === true) return env.result.value;
        var msg = env && env.result && env.result.error && env.result.error.message;
        throw new Error(msg || "更新服务返回了无法识别的响应（dsh 版本可能已变更）");
      });
    }

    // ---- component ----
    function createSection(React) {
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var useRef = React.useRef;

      function Button(props) {
        return h("button", {
          className: "dsh-au-btn" + (props.primary ? " dsh-au-btn-primary" : ""),
          disabled: !!props.disabled,
          onClick: props.onClick,
          type: "button",
        }, props.children);
      }

      function KV(props) {
        return h("div", { className: "dsh-au-kv" },
          h("span", { className: "dsh-au-k" }, props.k),
          h("span", { className: "dsh-au-v" }, props.v));
      }

      return function AutoupdateSection(props) {
        var tProp = props && props.t;
        function tt(key) {
          try {
            if (typeof tProp === "function") {
              var v = tProp(key);
              if (typeof v === "string" && v !== "" && v !== key) return v;
            }
          } catch (e) {}
          var lang = (typeof navigator !== "undefined" && String(navigator.language || "").toLowerCase().indexOf("zh") === 0) ? zh : en;
          return lang[key] !== undefined ? lang[key] : (zh[key] !== undefined ? zh[key] : key);
        }

        var _status = useState({ loading: true, status: null, unavailable: false });
        var status = _status[0]; var setStatus = _status[1];
        var _modal = useState(null); // null | { phase, current, latest, channel, message }
        var modal = _modal[0]; var setModal = _modal[1];
        var seq = useRef(0);

        useEffect(function () {
          var alive = true;
          callBackend("autoupdate/status", {}).then(function (value) {
            if (alive) setStatus({ loading: false, status: value, unavailable: false });
          }).catch(function () {
            if (alive) setStatus({ loading: false, status: null, unavailable: true });
          });
          return function () { alive = false; };
        }, []);

        function onCheck() {
          var my = ++seq.current;
          setModal({ phase: "checking" });
          callBackend("autoupdate/check", {}).then(function (value) {
            if (seq.current !== my) return;
            if (!value || (value.state !== "update-available" && value.state !== "up-to-date")) throw new Error("Invalid update check result");
            setStatus({ loading: false, unavailable: false, status: { installedVersion: value.current, channel: value.channel } });
            if (value && value.state === "update-available") {
              setModal({ phase: "update-available", current: value.current, latest: value.latest, channel: value.channel });
            } else {
              setModal({ phase: "up-to-date", current: value && value.current, latest: value && value.latest });
            }
          }).catch(function (e) {
            if (seq.current !== my) return;
            setModal({ phase: "error", message: tt("checkFailed") + ": " + (e && e.message ? e.message : String(e)) });
          });
        }

        function onConfirm() {
          if (!modal || !modal.latest) return;
          var target = modal.latest;
          var my = ++seq.current;
          setModal({ phase: "arming", latest: target });
          callBackend("autoupdate/apply", { targetVersion: target }).then(function (value) {
            if (seq.current !== my) return;
            if (!value || value.armed !== true || value.targetVersion !== target) throw new Error("Update was not scheduled");
            setModal({ phase: "armed", latest: value && value.targetVersion ? value.targetVersion : target });
          }).catch(function (e) {
            if (seq.current !== my) return;
            setModal({ phase: "error", message: tt("applyFailed") + ": " + (e && e.message ? e.message : String(e)) });
          });
        }

        function closeModal() { seq.current++; setModal(null); }

        var desc;
        if (status.status && status.status.enabled === false) desc = tt("disabled");
        else if (status.unavailable) desc = tt("unavailable");
        else if (status.loading) desc = tt("desc");
        else {
          var v = status.status && status.status.installedVersion ? status.status.installedVersion : tt("versionUnknown");
          var ch = status.status && status.status.channel ? status.status.channel : "latest";
          desc = tt("currentVersion") + ": " + v + " · " + tt("channel") + ": " + ch;
        }

        var modalBody = null;
        if (modal !== null) {
          var body;
          var actions = null;
          if (modal.phase === "checking") {
            body = h("div", null, tt("checking"));
          } else if (modal.phase === "up-to-date") {
            body = h("div", null, tt("upToDate"));
            actions = h(Button, { onClick: closeModal }, tt("close"));
          } else if (modal.phase === "update-available") {
            body = h("div", null,
              h("div", { style: { fontWeight: 500 } }, tt("newVersion")),
              h(KV, { k: tt("currentVersion"), v: modal.current || tt("versionUnknown") }),
              h(KV, { k: tt("latestVersion"), v: modal.latest }),
              h(KV, { k: tt("channel"), v: modal.channel || "latest" }));
            actions = [
              h(Button, { key: "cancel", onClick: closeModal }, tt("cancel")),
              h(Button, { key: "ok", primary: true, onClick: onConfirm }, tt("confirm")),
            ];
          } else if (modal.phase === "arming") {
            body = h("div", null, tt("checking"));
          } else if (modal.phase === "armed") {
            body = h("div", null,
              h(KV, { k: tt("armedTarget"), v: modal.latest }),
              h("div", null, tt("armed")));
            actions = h(Button, { primary: true, onClick: closeModal }, tt("close"));
          } else {
            body = h("div", { className: "dsh-au-error" }, modal.message || tt("checkFailed"));
            actions = h(Button, { onClick: closeModal }, tt("close"));
          }
          modalBody = h("div", { className: "dsh-au-overlay" },
            h("div", { className: "dsh-au-mask", onClick: closeModal }),
            h("div", { className: "dsh-au-panel", role: "dialog", "aria-modal": "true", "aria-label": tt("title") },
              h("div", { className: "dsh-au-modal-title" }, tt("title")),
              h("div", { className: "dsh-au-modal-body" }, body),
              actions === null ? null : h("div", { className: "dsh-au-actions" }, actions)));
        }

        return h("div", null,
          h("div", { className: "dsh-au-row" },
            h("div", { className: "dsh-au-texts" },
              h("div", { className: "dsh-au-title" }, tt("title")),
              h("div", { className: "dsh-au-desc" }, desc)),
            h(Button, { disabled: status.loading || (status.status && status.status.enabled === false) || (modal && (modal.phase === "checking" || modal.phase === "arming")), onClick: onCheck }, tt("button"))),
          modalBody);
      };
    }

    // ---- registration ----
    var NS = "dsh-autoupdate";
    var inject = ["slots", "locale"];

    function apply(ctx) {
      // locale dictionaries (guarded: locale service shape may evolve)
      try {
        ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-autoupdate: dictionaries");
      } catch (e) { console.warn("[dsh-autoupdate] locale registration skipped:", e); }

      var labelFn = function () { return "自动更新"; };
      try {
        var bound = ctx.locale.bind(NS);
        labelFn = function () {
          try {
            var v = bound("nav");
            return typeof v === "string" && v !== "" ? v : "自动更新";
          } catch (e) { return "自动更新"; }
        };
      } catch (e) {}

      var React;
      try {
        React = require("react");
      } catch (e) {
        console.warn("[dsh-autoupdate] react unavailable in module table; UI disabled:", e);
        return;
      }
      var Section = createSection(React);

      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "dsh-autoupdate",
            order: 100,
            label: labelFn,
            locale: NS,
          }, Section);
        });
      } catch (e) {
        console.warn("[dsh-autoupdate] settings.section slot unavailable; UI disabled:", e);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
