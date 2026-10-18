#!/usr/bin/env node
/**
 * 打 DSH 的 open-with 診斷路由，印出外掛狀態、規則、以及某個路徑會用哪個 app。
 *
 * 用法：
 *   node scripts/verify.mjs                     # 只看狀態與規則
 *   node scripts/verify.mjs "/path/to/file.docx" # 加上乾跑（不開啟）
 *   node scripts/verify.mjs "/path/to/file.docx" --apps  # 連關聯 app 清單一起問 macOS
 *
 * 環境變數 DSH_WEB_URL 可覆寫，預設 http://127.0.0.1:51714。
 */

const base = process.env.DSH_WEB_URL ?? "http://127.0.0.1:51714";
const path = process.argv[2];
const withApps = process.argv.includes("--apps");

const url = new URL("/local/open-with", base);
if (path !== undefined) url.searchParams.set("path", path);
if (withApps) url.searchParams.set("apps", "1");

try {
	const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
	const body = await response.json();
	console.log(`GET ${url.pathname}${url.search} → HTTP ${response.status}`);
	console.log(`外掛狀態：${body.status?.installed === true ? "已接管 openPath" : "未接管"}${body.status?.error ? `（${body.status.error}）` : ""}`);
	console.log(`規則檔：${body.configFile}`);
	console.log(`規則：${JSON.stringify(body.rules)}`);
	if (body.error) console.log(`規則檔錯誤：${body.error}`);
	if (body.probe) {
		console.log(`probe：${body.probe.path} → 副檔名 ${body.probe.extension || "（無）"} → ${body.probe.spec ?? "照系統預設"}`);
		if (Array.isArray(body.probe.apps)) {
			for (const app of body.probe.apps) {
				console.log(`  ${app.default === true ? "★" : " "} ${app.name}（${app.id}）`);
			}
		} else if (body.probe.apps?.error) {
			console.log(`  關聯查詢失敗：${body.probe.apps.error}`);
		}
	}
	if (body.last) {
		console.log(`最近一次開啟：${body.last.ok ? "成功" : "失敗"} ${body.last.path} → ${body.last.spec}${body.last.error ? `（${body.last.error}）` : ""}`);
	}
	process.exitCode = body.ok === true ? 0 : 1;
} catch (error) {
	console.error(`打不到 ${url}：${error.message}`);
	console.error("確認 DSH App 正在執行，且外掛已掛在 ~/.dsh/cordis.patch.yml。");
	process.exitCode = 1;
}
