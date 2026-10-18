/**
 * dsh-open-with — 瀏覽器半（client half）
 *
 * 在 DSH 設定裡加一個「檔案開啟方式」分頁：把 `~/.dsh/open-with.json` 的
 * 「副檔名 → app」規則用下拉選單編輯，存檔走宿主路由 `POST /local/open-with/config`。
 *
 * 供給規則（dsh-client-modules）：package.json 要宣告 dsh.client.platform = "web"
 * 與 exports["./client"]；bundle 走 `window.__ModuleLoader__.load({ id, factory })`，
 * id 必須等於 package.json 的 name。React 由平台模組表提供，直接 require。
 *
 * 取資料的 URL 不可寫死開頭斜線：Desktop 載體的頁面 origin 是 `dsh-app://app`，
 * 寫死 `/local/…` 會解析成別的位址而靜默失效。
 */

window.__ModuleLoader__.load({
	id: "dsh-open-with",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useState } = React;

		/** 設定頁的分頁 id 與標題。 */
		const SECTION_ID = "open-with";
		const SECTION_LABEL = "檔案開啟方式";

		/**
		 * 組出設定路由的絕對 URL。
		 * @returns 絕對 URL 字串
		 */
		function configUrl() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/open-with/config", base).href;
		}

		/**
		 * 打宿主路由並轉成資料；非 2xx 或 ok:false 一律丟錯。
		 * @param init - fetch 選項
		 * @returns 解析後的 JSON
		 */
		async function request(init) {
			const response = await fetch(configUrl(), init);
			let data = {};
			try {
				data = await response.json();
			} catch {
				// 非 JSON 回應就當作沒有內容。
			}
			if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`);
			return data;
		}

		/**
		 * 讀取目前規則與可選 app。
		 * @returns `{ rules, apps, configFile }`
		 */
		function loadConfig() {
			return request({ headers: { accept: "application/json" } });
		}

		/**
		 * 寫回整份規則。用 text/plain 當 Content-Type，避開 CORS 預檢。
		 * @param apps - 副檔名 → app 的物件
		 * @returns 宿主回傳的 `{ rules }`
		 */
		function saveConfig(apps) {
			return request({
				method: "POST",
				headers: { "content-type": "text/plain;charset=UTF-8" },
				body: JSON.stringify({ apps }),
			});
		}

		/**
		 * 把使用者輸入的副檔名正規化成小寫、不含點與星號。
		 * @param key - 原始輸入
		 * @returns 正規化後的副檔名
		 */
		function normalizeExtension(key) {
			return String(key ?? "")
				.trim()
				.toLowerCase()
				.replace(/^\*?\./u, "");
		}

		/** 共用樣式；顏色盡量跟隨 DSH 主題變數。 */
		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 2px", fontSize: "13px" },
			title: { fontSize: "14px", fontWeight: 600 },
			hint: { opacity: 0.65, fontSize: "12px", lineHeight: 1.6 },
			error: { color: "var(--dsw-danger, #d9534f)", fontSize: "12px" },
			table: { display: "flex", flexDirection: "column", gap: "6px", maxHeight: "46vh", overflowY: "auto", paddingRight: "4px" },
			row: { display: "grid", gridTemplateColumns: "96px minmax(0, 1fr) auto", gap: "8px", alignItems: "center" },
			addRow: { display: "grid", gridTemplateColumns: "96px minmax(0, 1fr) auto", gap: "8px", alignItems: "center", borderTop: "1px solid var(--dsw-border, rgba(127,127,127,.25))", paddingTop: "12px" },
			ext: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", opacity: 0.9 },
			input: {
				width: "100%",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-border, rgba(127,127,127,.3))",
				background: "transparent",
				color: "inherit",
				fontSize: "12px",
			},
			select: {
				width: "100%",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-border, rgba(127,127,127,.3))",
				background: "transparent",
				color: "inherit",
				fontSize: "12px",
			},
			button: {
				padding: "5px 12px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-border, rgba(127,127,127,.3))",
				background: "transparent",
				color: "inherit",
				fontSize: "12px",
				cursor: "pointer",
				whiteSpace: "nowrap",
			},
			empty: { opacity: 0.6, fontSize: "12px", padding: "8px 0" },
			footer: { display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", fontSize: "11px", opacity: 0.6 },
			toast: { fontSize: "12px" },
		};

		/**
		 * 設定頁的內容：規則清單＋新增列。
		 * @returns React 元素
		 */
		function OpenWithSection() {
			const [state, setState] = useState({ status: "loading", error: null, rules: {}, apps: [], configFile: "" });
			const [saving, setSaving] = useState(false);
			const [toast, setToast] = useState(null);
			const [draftExt, setDraftExt] = useState("");
			const [draftApp, setDraftApp] = useState("");

			const refresh = useCallback(async () => {
				try {
					const data = await loadConfig();
					setState({
						status: "ready",
						error: null,
						rules: data.rules ?? {},
						apps: Array.isArray(data.apps) ? data.apps : [],
						configFile: data.configFile ?? "",
					});
				} catch (error) {
					setState((current) => ({ ...current, status: "error", error: String(error?.message ?? error) }));
				}
			}, []);

			useEffect(() => {
				refresh();
			}, [refresh]);

			const commit = useCallback(
				async (nextRules) => {
					setSaving(true);
					try {
						const data = await saveConfig(nextRules);
						setState((current) => ({ ...current, rules: data.rules ?? nextRules }));
						setToast({ ok: true, text: "已儲存" });
					} catch (error) {
						setToast({ ok: false, text: String(error?.message ?? error) });
						refresh();
					} finally {
						setSaving(false);
						setTimeout(() => setToast(null), 2500);
					}
				},
				[refresh],
			);

			const entries = useMemo(() => Object.entries(state.rules).sort((a, b) => a[0].localeCompare(b[0])), [state.rules]);

			/**
			 * 下拉選項：目前值不在清單裡時補一筆，讓舊規則不會被默默蓋掉。
			 * @param current - 這一列目前的 app
			 * @returns `<option>` 陣列
			 */
			const optionsFor = (current) => {
				const list = state.apps.map((app) => ({ value: app.path, label: app.name }));
				if (current && !list.some((option) => option.value === current)) list.unshift({ value: current, label: `${current}（目前）` });
				return [{ value: "", label: "— 用系統預設 —" }, ...list].map((option) =>
					h("option", { key: option.value, value: option.value }, option.label),
				);
			};

			if (state.status === "loading") return h("div", { style: styles.hint }, "載入中…");
			if (state.status === "error") return h("div", { style: styles.error }, `讀不到設定：${state.error}`);

			const rows =
				entries.length === 0
					? [h("div", { key: "empty", style: styles.empty }, "目前沒有任何規則；沒列到的副檔名一律用 macOS 系統預設。")]
					: entries.map(([ext, app]) =>
							h("div", { key: ext, style: styles.row }, [
								h("code", { style: styles.ext }, `.${ext}`),
								h(
									"select",
									{
										style: styles.select,
										value: app,
										disabled: saving,
										onChange: (event) => {
											const next = { ...state.rules };
											if (event.target.value === "") delete next[ext];
											else next[ext] = event.target.value;
											commit(next);
										},
									},
									optionsFor(app),
								),
								h(
									"button",
									{
										type: "button",
										style: styles.button,
										disabled: saving,
										onClick: () => {
											const next = { ...state.rules };
											delete next[ext];
											commit(next);
										},
									},
									"移除",
								),
							]),
						);

			return h("div", { style: styles.wrap }, [
				h("div", { key: "title", style: styles.title }, "檔案開啟方式"),
				h(
					"div",
					{ key: "hint", style: styles.hint },
					"只在 DSH 內生效：卡片與右側預覽按「開啟」時使用這裡指定的 app；Finder 雙擊不受影響。改完立即生效，不必重啟。",
				),
				h("div", { key: "table", style: styles.table }, rows),
				h("div", { key: "add", style: styles.addRow }, [
					h("input", {
						key: "ext",
						style: styles.input,
						placeholder: "例如 epub",
						value: draftExt,
						disabled: saving,
						onChange: (event) => setDraftExt(event.target.value),
					}),
					h(
						"select",
						{
							key: "app",
							style: styles.select,
							value: draftApp,
							disabled: saving,
							onChange: (event) => setDraftApp(event.target.value),
						},
						optionsFor(draftApp),
					),
					h(
						"button",
						{
							key: "add",
							type: "button",
							style: styles.button,
							disabled: saving || normalizeExtension(draftExt) === "" || draftApp === "",
							onClick: () => {
								const ext = normalizeExtension(draftExt);
								if (ext === "") return;
								commit({ ...state.rules, [ext]: draftApp });
								setDraftExt("");
							},
						},
						"新增",
					),
				]),
				h("div", { key: "footer", style: styles.footer }, [
					h("span", { key: "count" }, `共 ${entries.length} 條 · ${state.configFile}`),
					toast === null
						? h("span", { key: "toast", style: styles.toast })
						: h(
								"span",
								{ key: "toast", style: { ...styles.toast, color: toast.ok ? "var(--dsw-success, #3c9d5d)" : "var(--dsw-danger, #d9534f)" } },
								toast.text,
							),
				]),
			]);
		}

		const inject = ["slots"];

		/**
		 * 掛載瀏覽器半：把分頁註冊進設定面板。
		 * @param ctx - cordis client context
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: SECTION_ID,
						order: 60,
						label: () => SECTION_LABEL,
					},
					OpenWithSection,
				),
			);
		}

		const module = { exports: {} };
		const exports = module.exports;
		exports.apply = apply;
		exports.inject = inject;
		exports.OpenWithSection = OpenWithSection;
		exports.configUrl = configUrl;
		return module.exports;
	},
});
