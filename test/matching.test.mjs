import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	applicationMatches,
	createStore,
	displayName,
	extensionOf,
	install,
	matchesApp,
	normalizeExtension,
	parseRules,
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
			xlsx: 42,
			"": "/Applications/Nope.app",
			"*": "/Applications/Nope.app",
		},
	});
	assert.deepEqual(Object.fromEntries(rules), {
		docx: "/Applications/Pages.app",
		md: "Obsidian",
	});
	assert.deepEqual(Object.fromEntries(parseRules(null)), {});
	assert.deepEqual(Object.fromEntries(parseRules({ apps: [] })), {});
});

test("matchesApp 路徑比 id、名稱不分大小寫", () => {
	assert.equal(matchesApp({ id: "/Applications/Pages.app", name: "Pages" }, "/Applications/Pages.app"), true);
	assert.equal(matchesApp({ id: "/Applications/Pages.app", name: "Pages" }, "pages"), true);
	assert.equal(matchesApp({ id: "/Applications/Pages.app", name: "Pages" }, "/Applications/Other.app"), false);
	assert.equal(matchesApp({ id: "/Applications/Pages.app", name: "Pages.app" }, "Pages"), true, "顯示名稱帶 .app");
	assert.equal(matchesApp({ id: "/System/Applications/TextEdit.app", name: "文字編輯.app" }, "TextEdit"), true, "在地化名稱也能比對");
	assert.equal(displayName("/Applications/Microsoft Word.app"), "Microsoft Word");
	assert.equal(applicationMatches("/Applications/Pages.app", "Pages"), true);
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
