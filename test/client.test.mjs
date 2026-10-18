import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

/** 讀取瀏覽器半的原始碼（不經過打包器，跟 DSH 載入的是同一份）。 */
const source = readFileSync(new URL("../plugin/client.js", import.meta.url), "utf8");

/**
 * 在 vm 裡執行瀏覽器半，回傳它註冊進 `window.__ModuleLoader__` 的定義。
 * @returns `{ id, factory }`
 */
function loadBundle(globals = {}) {
	let loaded;
	const sandbox = {
		...globals,
		window: {
			__ModuleLoader__: {
				load(definition) {
					loaded = definition;
				},
			},
		},
		require: () => undefined,
		URL,
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "client.js" });
	assert.ok(loaded, "bundle 應該呼叫 window.__ModuleLoader__.load");
	return loaded;
}

/** 最小可用的 React 替身，只覆蓋這個 bundle 用到的 API。 */
const React = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
};

test("bundle id 與 package 名稱一致", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const loaded = loadBundle();
	assert.equal(loaded.id, pkg.name);
	assert.equal(pkg.dsh.client.platform, "web");
	assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
	assert.equal(pkg.exports["./client"].default, "./plugin/client.js");
});

test("apply 會把分頁註冊進 settings.section", () => {
	const loaded = loadBundle();
	const exports = loaded.factory((id) => (id === "react" ? React : undefined));
	assert.equal([...exports.inject].join(","), "slots");

	const registered = [];
	const ctx = {
		slots: {
			inject(name, callback) {
				assert.equal(name, "settings.section");
				callback();
			},
			register(options, component) {
				registered.push({ options, component });
				return () => {};
			},
		},
	};
	exports.apply(ctx);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].options.name, "settings.section");
	assert.equal(registered[0].options.id, "open-with");
	assert.equal(registered[0].options.label(), "檔案開啟方式");
	assert.equal(typeof registered[0].component, "function");
});

test("configUrl 跟著 transport 的 streamBaseUrl 走（不可寫死開頭斜線）", () => {
	const loaded = loadBundle();
	const scoped = loadBundle({ __DSH_TRANSPORT__: { streamBaseUrl: "http://127.0.0.1:51714/" } });
	const exports = scoped.factory((id) => (id === "react" ? React : undefined));
	assert.equal(exports.configUrl(), "http://127.0.0.1:51714/local/open-with/config");
});
