/**
 * dsh-open-with — DSH 專用的「副檔名 → 開啟 app」規則（宿主半）
 *
 * 目的：DSH 按下檔案的「開啟」時，改用你指定的 app，而**不改變 macOS 的系統預設 app**。
 * 也就是說，Finder 雙擊 .docx 仍然是你平常的預設；只有 DSH 內的開啟動作被改寫。
 *
 * 原理（為什麼這樣做有效）：
 *   1. DSH 所有「開啟檔案」的最終出口都是 `sessionController.openPath(path, signal)`，
 *      而它最後呼叫的是 macOS 的 `open <path>`（副檔名關聯）——見 dsh-native-command
 *      的 path-opener.js。這裡把 `openPath` 換成 `open -a <app> <path>`，系統預設不動。
 *   2. 卡片／預覽按鈕顯示哪個 app 是預設，來自 `sessionController.fileApplications()`；
 *      這裡把規則指定的 app 排到最前並標成 default，讓按鈕文字與實際行為一致。
 *   3. 使用者在選單「這次改用別的 app」時走 `openFileApplication()`；只有當他選的
 *      正好是規則指定的 app 時才由這裡接手，其餘照原流程（含驗證）。
 *
 * 四條硬約束：
 *   - 外掛從工作區的檔案路徑載入（file://...），Node 不會解析 `@deepseek-ai/*` 裸名，
 *     所以**不得 import 任何 @deepseek-ai 套件**，Config 用手寫 standard-schema。
 *   - 任何例外都要收斂，絕不可冒到宿主頂層（否則可能讓 DSH 起不來）。
 *   - 只改寫這三個方法，且以 `ctx.effect` 的 disposer 還原；不要動 LaunchServices。
 *   - 規則檔每次開啟時以 mtime 快取重讀，改設定不必重啟 DSH。
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** cordis 外掛名稱（補丁的 id 可另取）。 */
export const name = "open-with";

/** 診斷路由：查目前載入的規則與最近一次開啟結果（同源、唯讀）。 */
export const ROUTE_PATH = "/local/open-with";

/** 設定路由：GET 取規則＋可選 app 清單，POST 寫回規則檔（給設定頁用）。 */
export const CONFIG_ROUTE = "/local/open-with/config";

/** DSH 家目錄；規則檔預設放在這裡。 */
const DSH_HOME =
	typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
		? process.env.DSH_HOME
		: join(homedir(), ".dsh");

/** 預設規則檔路徑。 */
export const DEFAULT_CONFIG_FILE = join(DSH_HOME, "open-with.json");

/** 看起來像 bundle id（例：com.microsoft.Word）→ 用 `open -b`，其餘用 `open -a`。 */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/u;

/**
 * 外掛設定。手寫 standard-schema，**刻意不 import schemastery**（見檔頭約束）。
 * 只有一個欄位：規則檔位置；平常不必填。
 */
export const Config = {
	"~standard": {
		vendor: "open-with",
		version: 1,
		/**
		 * 驗證並補預設值；壞值一律收斂成預設，不讓外掛載入失敗。
		 * @param value - 補丁裡給的原始 config（可能是 undefined）
		 * @returns `{ value }`
		 */
		validate(value) {
			const input = value !== null && typeof value === "object" ? value : {};
			const configFile =
				typeof input.configFile === "string" && input.configFile !== "" ? input.configFile : DEFAULT_CONFIG_FILE;
			return { value: { configFile } };
		},
	},
};

/**
 * 把設定檔的 key 正規化成副檔名：`docx`、`.docx`、`*.docx`、`DOCX` 都收斂成 `docx`。
 * @param key - 設定檔裡的鍵
 * @returns 小寫、不含點與星號的副檔名；無法辨識時回空字串
 */
export function normalizeExtension(key) {
	return String(key ?? "")
		.trim()
		.toLowerCase()
		.replace(/^\*?\./u, "");
}

/**
 * 取一個路徑的副檔名（小寫、不含點）。
 * @param path - 絕對或相對路徑
 * @returns 副檔名；沒有副檔名（含 `.gitignore` 這種點開頭的檔名）時回空字串
 */
export function extensionOf(path) {
	const base = basename(String(path ?? ""));
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * 把 `open-with.json` 的內容轉成 Map（副檔名 → app 指定）。
 * @param value - 解析後的 JSON
 * @returns 規則 Map；格式不對時回空 Map（不拋錯）
 */
export function parseRules(value) {
	const out = new Map();
	const apps = value !== null && typeof value === "object" ? value.apps : undefined;
	if (apps === null || typeof apps !== "object" || Array.isArray(apps)) return out;
	for (const [key, spec] of Object.entries(apps)) {
		if (typeof spec !== "string" || spec.trim() === "") continue;
		const ext = normalizeExtension(key);
		if (ext === "" || ext === "*") continue;
		out.set(ext, spec.trim());
	}
	return out;
}

/**
 * 一個關聯 app 是否符合規則指定的 app。
 * 路徑比對 id；名稱（例如 `Pages`）比對顯示名稱，不分大小寫。
 * @param app - `{ id, name }` 形狀的關聯 app
 * @param spec - 規則值（絕對路徑或 app 顯示名稱）
 * @returns 是否符合
 */
export function matchesApp(app, spec) {
	if (app === null || typeof app !== "object") return false;
	if (spec.startsWith("/")) return app.id === spec;
	const target = spec.toLowerCase();
	const name = typeof app.name === "string" ? app.name.toLowerCase().replace(/\.app$/u, "") : "";
	const base = basename(String(app.id ?? ""), ".app").toLowerCase();
	// 顯示名稱可能是在地化名稱（例：TextEdit → 文字編輯.app），所以再比一次 id 的檔名。
	return name === target || base === target;
}

/**
 * 使用者從選單送回來的 application id 是否就是規則指定的 app。
 * @param application - 選單送回的 id（通常是 app 路徑）
 * @param spec - 規則值
 * @returns 是否為同一個 app
 */
export function applicationMatches(application, spec) {
	if (application === spec) return true;
	if (spec.startsWith("/")) return false;
	return basename(String(application ?? ""), ".app").toLowerCase() === spec.toLowerCase();
}

/**
 * 規則值在選單／按鈕上要顯示的名稱。
 * @param spec - 規則值
 * @returns 例：`/Applications/Pages.app` → `Pages`
 */
export function displayName(spec) {
	return spec.startsWith("/") ? basename(spec, ".app") : spec;
}

/**
 * 用 macOS 的 `open` 開啟一個檔案。
 * @param spec - app 路徑、bundle id 或顯示名稱
 * @param path - 要開啟的檔案絕對路徑
 * @param signal - 呼叫端生命週期；中止時結束子程序
 * @returns `open` 交棒給系統後 resolve
 */
export function launch(spec, path, signal) {
	const flag = BUNDLE_ID.test(spec) ? "-b" : "-a";
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/open", [flag, spec, path], { timeout: 15000, signal }, (error) => {
			if (error === null) resolve();
			else reject(new Error(`open ${flag} ${spec} 失敗：${error.message}`));
		});
	});
}

/**
 * 建立規則儲存（含 mtime 快取與最近一次開啟紀錄）。
 * @param configFile - 規則檔絕對路徑
 * @returns 讀取、比對、改寫應用程式清單與開啟的介面
 */
export function createStore(configFile) {
	let mtimeMs = Number.NaN;
	let rules = new Map();
	let error = null;
	let last = null;

	/**
	 * 需要時重讀規則檔；同一 mtime 直接回快取。
	 * @returns 目前的規則 Map
	 */
	function load() {
		let stat;
		try {
			stat = statSync(configFile);
		} catch (statError) {
			if (statError?.code === "ENOENT") {
				if (mtimeMs !== -1) {
					mtimeMs = -1;
					rules = new Map();
					error = null;
				}
				return rules;
			}
			error = String(statError?.message ?? statError);
			return rules;
		}
		if (stat.mtimeMs === mtimeMs) return rules;
		mtimeMs = stat.mtimeMs;
		try {
			rules = parseRules(JSON.parse(readFileSync(configFile, "utf8")));
			error = null;
		} catch (parseError) {
			error = `讀取 ${configFile} 失敗：${String(parseError?.message ?? parseError)}`;
		}
		return rules;
	}

	/**
	 * 查一個路徑對應的 app 規則。
	 * @param path - 檔案路徑
	 * @returns app 指定；沒有規則時 undefined
	 */
	function specFor(path) {
		const ext = extensionOf(path);
		return ext === "" ? undefined : load().get(ext);
	}

	/**
	 * 依規則重排關聯 app 清單，讓規則指定的 app 成為第一個並標成 default。
	 * @param apps - 宿主原本回傳的關聯 app 清單
	 * @param path - 檔案路徑
	 * @returns 新陣列；沒有規則時原樣回傳
	 */
	function reorder(apps, path) {
		const spec = specFor(path);
		if (spec === undefined || !Array.isArray(apps)) return apps;
		const cleared = apps.map((app) => (app?.default === true ? { ...app, default: false } : app));
		const index = cleared.findIndex((app) => matchesApp(app, spec));
		if (index >= 0) {
			const [hit] = cleared.splice(index, 1);
			return [{ ...hit, default: true }, ...cleared];
		}
		return [{ id: spec, name: displayName(spec), default: true, icon: null }, ...cleared];
	}

	/**
	 * 依規則開啟，並記錄結果供診斷路由查詢。
	 * @param spec - app 指定
	 * @param path - 檔案路徑
	 * @param signal - 呼叫端生命週期
	 * @returns 開啟完成
	 */
	async function open(spec, path, signal) {
		const record = { at: Date.now(), path, spec, ok: false, error: null };
		try {
			await launch(spec, path, signal);
			record.ok = true;
		} catch (openError) {
			record.error = String(openError?.message ?? openError);
			throw openError;
		} finally {
			last = record;
		}
	}

	return {
		load,
		specFor,
		reorder,
		open,
		/** @returns 目前的規則物件（給診斷路由用） */
		rules() {
			return Object.fromEntries(load());
		},
		/** @returns 最近一次讀取規則檔的錯誤，沒有則 null */
		error() {
			load();
			return error;
		},
		/** @returns 最近一次開啟紀錄，沒有則 null */
		last() {
			return last;
		},
	};
}

/**
 * 原始方法的存放位置。用 `Symbol.for`（跨模組實例共用的全域符號）掛在 controller 本身，
 * 這樣外掛熱重載換了新的模組實例時，仍然找得到上一層的原始方法，不會愈包愈多層。
 */
const PREVIOUS = Symbol.for("dsh-open-with.previous");

/**
 * 改寫 sessionController 的三個方法。
 * @param controller - 宿主 sessionController
 * @param store - 規則儲存
 * @param ctx - 宿主 context（只拿來寫警告）
 * @param configFile - 規則檔路徑（只用在啟動訊息）
 */
export function install(controller, store, ctx, configFile = DEFAULT_CONFIG_FILE) {
	if (controller === null || typeof controller !== "object") throw new Error("sessionController 不存在");
	if (typeof controller.openPath !== "function" || typeof controller.fileApplications !== "function") {
		throw new Error("sessionController 缺少 openPath／fileApplications，DSH 版本可能已改變");
	}
	uninstall(controller);
	const previous = {
		openPath: controller.openPath,
		fileApplications: controller.fileApplications,
		openFileApplication: controller.openFileApplication,
	};
	Object.defineProperty(controller, PREVIOUS, { value: previous, configurable: true, writable: true });

	controller.openPath = async function openPath(path, signal) {
		const spec = store.specFor(path);
		if (spec === undefined) return previous.openPath.call(this, path, signal);
		await store.open(spec, path, signal);
	};

	controller.fileApplications = async function fileApplications(path, signal) {
		const apps = await previous.fileApplications.call(this, path, signal);
		return store.reorder(apps, path);
	};

	if (typeof previous.openFileApplication === "function") {
		controller.openFileApplication = async function openFileApplication(path, application, signal) {
			const spec = store.specFor(path);
			if (spec !== undefined && applicationMatches(application, spec)) {
				await store.open(spec, path, signal);
				return;
			}
			return previous.openFileApplication.call(this, path, application, signal);
		};
	}
	ctx?.logger?.info?.(`[open-with] 已接管檔案開啟（規則檔：${configFile}）`);
}

/**
 * 還原被改寫的方法（外掛卸載或重載時）。
 * @param controller - 宿主 sessionController
 */
export function uninstall(controller) {
	const previous = controller?.[PREVIOUS];
	if (previous === undefined) return;
	controller.openPath = previous.openPath;
	controller.fileApplications = previous.fileApplications;
	if (typeof previous.openFileApplication === "function") controller.openFileApplication = previous.openFileApplication;
	delete controller[PREVIOUS];
}

/**
 * 診斷路由：`GET /local/open-with`，可加 `?path=` 做不開啟的乾跑。
 * @param store - 規則儲存
 * @param configFile - 規則檔路徑
 * @returns Node http handler
 */
export function createHandler(store, configFile, status = { installed: false, error: null }, clientModules = undefined) {
	return async function handler(req, res) {
		try {
			const url = new URL(req?.url ?? ROUTE_PATH, "http://127.0.0.1");
			const probe = url.searchParams.get("path");
			let apps = null;
			if (probe !== null && url.searchParams.get("apps") === "1" && status?.controller !== undefined) {
				try {
					apps = await status.controller.fileApplications(probe, AbortSignal.timeout(10000));
				} catch (queryError) {
					apps = { error: String(queryError?.message ?? queryError) };
				}
			}
			const payload = {
				ok: true,
				configFile,
				status: { installed: status?.installed === true, error: status?.error ?? null },
				clientModule: describeClientModule(clientModules),
				rules: store.rules(),
				error: store.error(),
				last: store.last(),
				probe:
					probe === null
						? null
						: {
								path: probe,
								extension: extensionOf(probe),
								spec: store.specFor(probe) ?? null,
								apps,
							},
			};
			res.statusCode = 200;
			res.setHeader("content-type", "application/json; charset=utf-8");
			res.setHeader("cache-control", "no-store");
			res.end(JSON.stringify(payload));
		} catch (handlerError) {
			try {
				res.statusCode = 500;
				res.setHeader("content-type", "application/json; charset=utf-8");
				res.end(JSON.stringify({ ok: false, error: String(handlerError?.message ?? handlerError) }));
			} catch {
				res.end?.();
			}
		}
	};
}

/** 可選 app 的來源目錄（只掃第一層的 .app）。 */
const APP_DIRS = ["/Applications", "/System/Applications", join(homedir(), "Applications")];
/** app 清單快取（毫秒）。 */
const APP_CACHE_MS = 60_000;
let appCache = { at: 0, list: [] };

/**
 * 列出本機已安裝的 .app（第一層），給設定頁的下拉選單用。結果快取 60 秒。
 * @returns `{ name, path }[]`，依名稱排序
 */
export function listApplications() {
	const now = Date.now();
	if (now - appCache.at < APP_CACHE_MS) return appCache.list;
	const seen = new Map();
	for (const dir of APP_DIRS) {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
			const path = join(dir, entry.name);
			if (seen.has(path)) continue;
			seen.set(path, { name: entry.name.slice(0, -4), path });
		}
	}
	const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
	appCache = { at: now, list };
	return list;
}

/**
 * 補上 CORS 白名單標頭（頁面來源是 `dsh-app://app` 或本機回環）。
 * @param req - 進來的請求
 * @param res - 要回應的物件
 */
function applyCors(req, res) {
	const origin = req?.headers?.origin;
	if (typeof origin !== "string" || origin === "") return;
	const allowed = origin === "dsh-app://app" || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(origin);
	if (!allowed) return;
	try {
		res.setHeader("access-control-allow-origin", origin);
		res.setHeader("vary", "origin");
	} catch {
		// 標頭設不進去也不影響主流程。
	}
}

/**
 * 送 JSON 回應。
 * @param res - node ServerResponse
 * @param status - HTTP 狀態碼
 * @param payload - 要序列化的內容
 */
function sendJson(res, status, payload) {
	try {
		res.statusCode = status;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify(payload));
	} catch {
		try {
			res.end();
		} catch {
			// 連 end 都不行就只能放棄。
		}
	}
}

/**
 * 讀取並限制大小的請求內容。
 * @param req - 進來的請求
 * @param limit - 位元組上限
 * @returns 內容字串
 */
function readBody(req, limit = 256 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("內容過大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * 檢查送進來的規則物件，順便正規化副檔名。
 * @param value - 解析後的 `apps` 值
 * @returns 正規化後的規則物件
 * @throws 值不是物件或筆數過多時
 */
export function sanitizeApps(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("apps 必須是物件");
	const out = {};
	for (const [key, spec] of Object.entries(value)) {
		if (typeof spec !== "string") continue;
		const trimmed = spec.trim();
		if (trimmed === "") continue;
		if (trimmed.includes("\u0000")) throw new Error("app 值不合法");
		const ext = normalizeExtension(key);
		if (ext === "" || ext === "*") continue;
		out[ext] = trimmed;
	}
	if (Object.keys(out).length > 500) throw new Error("規則筆數過多");
	return out;
}

/**
 * 回報瀏覽器半有沒有被宿主編進前端圖（給診斷頁與測試用）。
 * @param getModules - 取得 `clientModules` 服務的函式
 * @returns `{ id, present, rev?, url? }` 或錯誤訊息
 */
export function describeClientModule(getModules) {
	try {
		const graph = getModules?.()?.graph?.();
		const entries = Array.isArray(graph?.entries) ? graph.entries : [];
		const hit = entries.find((entry) => entry.id === "dsh-open-with");
		if (hit === undefined) return { id: "dsh-open-with", present: false, composed: entries.length };
		return { id: hit.id, present: true, rev: hit.rev, url: hit.url };
	} catch (error) {
		return { id: "dsh-open-with", present: false, error: String(error?.message ?? error) };
	}
}

/**
 * 建立設定路由（GET 讀取、POST 寫回），只允許同源。
 * @param store - 規則儲存
 * @param configFile - 規則檔路徑
 * @returns Node http handler
 */
export function createConfigHandler(store, configFile) {
	return async function handler(req, res) {
		applyCors(req, res);
		const method = req?.method ?? "GET";
		if (method === "OPTIONS") {
			res.statusCode = 204;
			res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
			res.setHeader("access-control-allow-headers", "content-type");
			res.end();
			return;
		}
		try {
			if (method === "GET" || method === "HEAD") {
				sendJson(res, 200, { ok: true, configFile, rules: store.rules(), apps: listApplications(), error: store.error() });
				return;
			}
			if (method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			const apps = sanitizeApps(body?.apps);
			let current = {};
			try {
				const parsed = JSON.parse(readFileSync(configFile, "utf8"));
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
			} catch {
				// 舊檔壞掉或不存在：直接寫新的。
			}
			const next = { ...current, apps };
			const temp = `${configFile}.tmp-${process.pid}`;
			writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
			renameSync(temp, configFile);
			sendJson(res, 200, { ok: true, rules: store.rules(), error: store.error() });
		} catch (error) {
			sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 掛載宿主半。
 * @param ctx - cordis 宿主 context
 * @param config - 補丁給的 config（可省略）
 * @returns 這個 fiber 的 disposer（或 undefined）
 */
export function apply(ctx, config) {
	const resolved = Config["~standard"].validate(config).value;
	const store = createStore(resolved.configFile);
	const status = { installed: false, error: null };
	let fiber;
	try {
		fiber = ctx.inject(["sessionController"], (sessionCtx) => {
			const controller = sessionCtx.sessionController;
			try {
				install(controller, store, ctx, resolved.configFile);
				status.installed = true;
				status.error = null;
				status.controller = controller;
			} catch (installError) {
				status.installed = false;
				status.error = String(installError?.message ?? installError);
				ctx?.logger?.warn?.(`[open-with] 無法接管：${status.error}`);
				return;
			}
			sessionCtx.effect(() => () => uninstall(controller), "open-with: 還原開啟方法");
		});
	} catch (injectError) {
		ctx?.logger?.warn?.(`[open-with] 注入失敗：${String(injectError?.message ?? injectError)}`);
	}

	let route;
	try {
		route = ctx.inject(["webServer"], (webCtx) => {
			try {
				webCtx.effect(() => {
					const offDiagnostic = webCtx.webServer.register({
						kind: "exact",
						path: ROUTE_PATH,
						handler: createHandler(store, resolved.configFile, status, () => ctx.get("clientModules")),
					});
					const offConfig = webCtx.webServer.register({
						kind: "exact",
						path: CONFIG_ROUTE,
						handler: createConfigHandler(store, resolved.configFile),
					});
					return () => {
						offDiagnostic?.();
						offConfig?.();
					};
				}, "open-with: 診斷與設定路由");
			} catch (registerError) {
				ctx?.logger?.warn?.(`[open-with] 路由註冊失敗：${String(registerError?.message ?? registerError)}`);
			}
		});
	} catch (injectError) {
		ctx?.logger?.warn?.(`[open-with] webServer 注入失敗：${String(injectError?.message ?? injectError)}`);
	}

	return () => {
		try {
			fiber?.();
		} catch {
			/* disposer 失敗不影響卸載 */
		}
		try {
			route?.();
		} catch {
			/* 同上 */
		}
	};
}
