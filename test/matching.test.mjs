import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createStore,
	displayName,
	extensionOf,
	install,
	normalizeExtension,
	parseRules,
	sameApp,
	sanitizeApps,
	uninstall,
} from "../plugin/index.mjs";

/** 建一個用完即刪的暫存目錄，回傳目錄路徑。 */
function tempDir() {
	return mkdtempSync(join(tmpdir(), "dsh-open-with-"));
}

test("normalizeExtension 收斂常見寫法", () => {
	assert.equal(normalizeExtension(".DOCX"), "docx");
	assert.equal(normalizeExtension("*.md"), "md");
	assert.equal(normalizeExtension(" docx "), "docx");
	assert.equal(normalizeExtension("*"), "*");
});

test("extensionOf 只認最後一個點，且排除點開頭的檔名", () => {
	assert.equal(extensionOf("/a/b/report.DOCX"), "docx");
	assert.equal(extensionOf("/a/.gitignore"), "");
	assert.equal(extensionOf("no-extension"), "");
});

test("parseRules 忽略壞值與萬用字元", () => {
	const rules = parseRules({
		apps: {
			".docx": "/Applications/Pages.app",
			"*.md": "Obsidian",
			pdf: "",
			xlsx: 42,
			"": "/Applications/Nope.app",
			"*": "/Applications/Nope.app",
		},
	});
	// 空字串是「保留這一列、但用系統預設」，不能被丟掉。
	assert.deepEqual(Object.fromEntries(rules), {
		docx: "/Applications/Pages.app",
		md: "Obsidian",
		pdf: "",
	});
	assert.deepEqual(Object.fromEntries(parseRules(null)), {});
	assert.deepEqual(Object.fromEntries(parseRules({ apps: [] })), {});
});

test("sameApp：路徑比 id、名稱不分大小寫（設定頁與選單共用同一條規則）", () => {
	assert.equal(sameApp({ id: "/Applications/Pages.app", name: "Pages" }, "/Applications/Pages.app"), true);
	assert.equal(sameApp({ id: "/Applications/Pages.app", name: "Pages" }, "pages"), true);
	assert.equal(sameApp({ id: "/Applications/Pages.app", name: "Pages" }, "/Applications/Other.app"), false);
	assert.equal(sameApp({ id: "/Applications/Pages.app", name: "Pages.app" }, "Pages"), true, "顯示名稱帶 .app");
	assert.equal(sameApp({ id: "/System/Applications/TextEdit.app", name: "文字編輯.app" }, "TextEdit"), true, "在地化名稱也能比對");
	assert.equal(displayName("/Applications/Microsoft Word.app"), "Microsoft Word");
	// 選單送回來的是 id 字串（沒有顯示名稱可比）：檔名比對得到，在地化名稱比不到。
	assert.equal(sameApp("/Applications/Pages.app", "Pages"), true, "選單點回來：檔名");
	assert.equal(sameApp("/Applications/Pages.app", "/Applications/Pages.app"), true, "選單點回來：路徑");
	assert.equal(sameApp("/System/Applications/TextEdit.app", "文字編輯"), false, "選單只有 id，在地化名稱是資料限制");
	// 壞值不拋錯。
	assert.equal(sameApp(null, "Pages"), false);
	assert.equal(sameApp({ id: "/Applications/Pages.app" }, ""), false);
	assert.equal(sameApp({ id: "/Applications/Pages.app" }, null), false);
});


test("createStore：mtime 快取、壞 JSON 不拋錯、reorder 把規則 app 排到第一", () => {
	const dir = tempDir();
	try {
		const file = join(dir, "open-with.json");
		writeFileSync(file, JSON.stringify({ apps: { docx: "/Applications/LibreOffice.app" } }));
		const store = createStore(file);
		assert.equal(store.specFor("/x/a.docx"), "/Applications/LibreOffice.app");
		assert.equal(store.specFor("/x/a.txt"), undefined);

		const apps = [
			{ id: "/Applications/Pages.app", name: "Pages", default: true, icon: null },
			{ id: "/Applications/LibreOffice.app", name: "LibreOffice", default: false, icon: null },
		];
		const ordered = store.reorder(apps, "/x/a.docx");
		assert.equal(ordered[0].id, "/Applications/LibreOffice.app");
		assert.equal(ordered[0].default, true);
		assert.equal(
			ordered.some((app) => app.id === "/Applications/Pages.app" && app.default === true),
			false,
		);
		assert.equal(store.reorder(apps, "/x/a.txt"), apps);

		const missing = store.reorder([{ id: "/Applications/Pages.app", name: "Pages", default: true }], "/x/a.docx");
		assert.equal(missing[0].id, "/Applications/LibreOffice.app");
		assert.equal(missing[0].default, true);

		writeFileSync(file, "{ not json");
		assert.equal(store.error() === null, false);
		assert.equal(store.specFor("/x/a.docx"), "/Applications/LibreOffice.app", "壞檔時保留上一次成功的規則");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sanitizeApps 保留空字串（系統預設列）並擋掉壞值", () => {
	assert.deepEqual(sanitizeApps({ docx: "/Applications/Pages.app", pdf: "", pptx: null }), {
		docx: "/Applications/Pages.app",
		pdf: "",
		pptx: "",
	});
	assert.deepEqual(sanitizeApps({ DOCX: "  Pages  " }), { docx: "Pages" });
	assert.throws(() => sanitizeApps([]), /必須是物件/);
	assert.deepEqual(sanitizeApps({ "*": "X", "": "Y" }), {});
});

test("規則值為空字串時：specFor 回 undefined、reorder 不動清單", () => {
	const dir = tempDir();
	try {
		const file = join(dir, "open-with.json");
		writeFileSync(file, JSON.stringify({ apps: { pdf: "" } }));
		const store = createStore(file);
		assert.equal(store.specFor("/x/a.pdf"), undefined);
		const apps = [{ id: "/System/Applications/Preview.app", name: "Preview", default: true }];
		assert.equal(store.reorder(apps, "/x/a.pdf"), apps);
		assert.deepEqual(store.rules(), { pdf: "" }, "空字串仍要出現在規則裡，設定頁才留得住那一列");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("install 改寫三個方法、uninstall 完整還原；無規則時走原流程", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "open-with.json");
		writeFileSync(file, JSON.stringify({ apps: { docx: "/Applications/Pages.app" } }));
		const store = createStore(file);
		const calls = [];
		const original = {
			openPath: async (path) => calls.push(["openPath", path]),
			fileApplications: async (path) => {
				calls.push(["fileApplications", path]);
				return [
					{ id: "/Applications/Pages.app", name: "Pages", default: true },
					{ id: "/Applications/LibreOffice.app", name: "LibreOffice", default: false },
				];
			},
			openFileApplication: async (path, app) => calls.push(["openFileApplication", path, app]),
		};
		const controller = { ...original };
		install(controller, store, null);
		assert.notEqual(controller.openPath, original.openPath);
		assert.notEqual(controller.fileApplications, original.fileApplications);
		assert.notEqual(controller.openFileApplication, original.openFileApplication);

		await controller.openPath("/x/a.txt");
		assert.deepEqual(calls.at(-1), ["openPath", "/x/a.txt"], "沒有規則時交回原方法");

		await controller.openFileApplication("/x/a.docx", "/Applications/LibreOffice.app");
		assert.deepEqual(calls.at(-1), ["openFileApplication", "/x/a.docx", "/Applications/LibreOffice.app"], "選別的 app 時交回原方法");

		uninstall(controller);
		assert.equal(controller.openPath, original.openPath);
		assert.equal(controller.fileApplications, original.fileApplications);
		assert.equal(controller.openFileApplication, original.openFileApplication);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("install 對缺少方法的 controller 拋錯（不靜默）", () => {
	assert.throws(() => install({}, createStore("/nonexistent.json"), null), /openPath/);
});

test("openFileApplication：選單點回規則指定的 app 時由規則接手（與設定頁同一條 sameApp）", async () => {
	const opened = [];
	const handedBack = [];
	// 假的 store：只驗「接手的判定」，不真的去 launch（那會開一個真的 app）。
	const store = {
		specFor: (path) => (path.endsWith(".docx") ? "/Applications/Pages.app" : undefined),
		open: async (spec, path) => opened.push([spec, path]),
		reorder: (apps) => apps,
		rules: () => ({}),
		error: () => null,
		last: () => null,
	};
	const controller = {
		openPath: async () => {},
		fileApplications: async () => [],
		openFileApplication: async (path, application) => handedBack.push([path, application]),
	};
	install(controller, store, null);
	try {
		await controller.openFileApplication("/x/a.docx", "/Applications/Pages.app");
		assert.deepEqual(opened, [["/Applications/Pages.app", "/x/a.docx"]], "規則指定的 app：走規則，不交回原方法");
		assert.equal(handedBack.length, 0);

		await controller.openFileApplication("/x/a.docx", "/Applications/Other.app");
		assert.deepEqual(handedBack.at(-1), ["/x/a.docx", "/Applications/Other.app"], "選別的 app：交回原方法");

		await controller.openFileApplication("/x/a.txt", "/Applications/Pages.app");
		assert.equal(handedBack.length, 2, "沒有規則的副檔名：交回原方法");
	} finally {
		uninstall(controller);
	}
});
