# dsh-open-with — per-extension "open with" for DSH

## English

DSH opens a file by handing it to macOS, so it always uses your **system** default application.
This plugin gives DSH its own per-extension app map instead — Finder double-click keeps your
normal default, while DSH's delivery cards, right-sidebar preview and change review open the app
you picked here.

- **Settings → File opening** (new tab) edits the map; changes apply immediately, no restart.
- Rules live in `~/.dsh/open-with.json`: `{"apps":{"docx":"/Applications/Pages.app"}}` — value is an
  absolute app path, a display name, or a bundle id. Unlisted extensions keep the system default.
- Only DSH's own "Open" actions are affected. "Show file location" still reveals in Finder.
- macOS only (it launches `/usr/bin/open`). MIT.

Install from the plugin market, from GitHub (`dsh plugin add github:HildebrandYu/dsh-open-with`),
or mount `plugin/index.mjs` from a checkout (see 安裝 below).

---

## 中文說明

讓 **DSH 內**按「開啟」時使用你指定的 app，而**不動 macOS 的系統預設 app**。
Finder 雙擊仍然是你平常的預設；只有 DSH 的檔案卡片、右側預覽、變更審查這幾個「開啟」動作會被改寫。

> 為什麼不是 SwiftDefaultApps：SwiftDefaultApps（或 `duti`）改的是 LaunchServices 的**全域**預設，
> 一改就是整個系統、連 Finder 雙擊都跟著變，而且它沒有「只對某個 app 生效」的範圍，也不能嵌進 DSH。
> 要「只在 DSH 裡不同」，只能改 DSH 自己開啟檔案的那一步——就是這個外掛在做的事。

## 規則檔

`~/.dsh/open-with.json`

```json
{
  "apps": {
    "docx": "/Applications/Pages.app",
    "md": "Obsidian",
    "pdf": "/System/Applications/Preview.app"
  }
}
```

value 也可以只寫顯示名稱（`"docx": "Pages"`），效果相同。

- key：副檔名，`docx`、`.docx`、`*.docx`、`DOCX` 都接受（正規化成小寫）。
- value：app 的**絕對路徑**或**顯示名稱**（例：`Pages`、`Obsidian`）；也接受 bundle id（例：`com.apple.Preview`）。
- **空字串 `""`**＝「這一列保留，但用系統預設」：設定頁會留著那一列，開啟行為跟沒有規則一樣。
- 沒有列到的副檔名 → 完全照原本行為（系統預設 app）。
- `*` 這種萬用鍵刻意不支援，避免一個手滑讓所有檔案都跑掉。
- **存檔即生效**，不必重啟 DSH（外掛每次開啟前會看 mtime 重讀）。

## 目前規則（2026-10-18 掃過整個 BrainVault 後選定）

| 類別 | 副檔名 | app |
|---|---|---|
| Markdown | md | Obsidian |
| Word | docx、doc、odt | LibreOffice |
| PDF | pdf | Stirling PDF |
| 試算表 | xlsx、xls、csv | LibreOffice |
| 簡報 | pptx | LibreOffice |
| 純文字 | txt、log、vtt | TextEdit |
| 點陣圖 | png、jpg、jpeg、gif | Preview |
| 音訊 | wav、mp3 | QuickTime Player |
| 影片 | mp4 | VLC |
| 向量圖 | svg | Google Chrome |
| 程式碼 | py、js、mjs、cjs、ts、tsx、sh、rs、css | TextEdit |
| 設定／資料 | json、yaml、yml、toml、jsonl | Obsidian |
| 網頁 | html | Google Chrome |
| 壓縮 | zip | The Unarchiver |

共 36 條；沒有列到的副檔名維持系統預設。

## 設定頁（GUI）

DSH 設定（`⌘,`）→ 左側「**檔案開啟方式**」：

- 列出目前所有「副檔名 → app」，每列一個下拉，換了立刻寫回（不必按儲存）。
- 「— 用系統預設 —」＝**保留這一列**、改用系統預設（檔案會存成 `""`）；要整列刪掉請按右邊的「移除」。
- 最下面一列可新增副檔名（例：`epub`）＋ app。
- 下方顯示規則筆數與規則檔路徑。

資料走宿主路由 `GET/POST /local/open-with/config`；寫入時保留 `_readme` 等其他欄位，採原子寫入（暫存檔＋rename）。

> 補丁裡的 entry 名稱帶 `?v=1` 是刻意的：`dsh-client-modules` 會把每條 entry 的 package.json
> 按 loader name **快取一輩子**；這個外掛第一次載入時 package.json 還沒有 `dsh.client`，
> 不快取破一次就永遠不會把瀏覽器半編進前端。查詢字串只影響 ESM 的模組身分，找 package.json 時會被忽略。
> **不要把它清掉**，否則設定頁會消失（要等下一次 App 重啟才回來）。

## 它在 DSH 裡怎麼運作

1. DSH 開啟檔案的最終出口是 `sessionController.openPath()`，最後呼叫 macOS 的 `open <path>`。
   外掛把它換成 `open -a <你指定的 app> <path>`。
2. 按鈕／選單要顯示哪個 app 是預設，來自 `sessionController.fileApplications()`；
   外掛把規則指定的 app 排到最前並標成 `(default)`，所以按鈕文字和實際行為一致。
3. 你從選單「這次改用別的 app」時，只有選到規則指定的那個 app 才由外掛接手，其餘照原流程。

**完全不碰** LaunchServices、`duti`、`defaults write`；移除外掛即恢復原狀。

## 驗證

```bash
# 1) 外掛是否活著、規則是否載入、某個路徑會用哪個 app（乾跑，不會開啟）
curl -s http://127.0.0.1:51714/local/open-with | python3 -m json.tool

# 2) 連關聯 app 清單一起看（會即時問 macOS，不會開啟）
curl -s "http://127.0.0.1:51714/local/open-with?path=/Volumes/BrainVault/x.docx&apps=1" | python3 -m json.tool

# 3) 一鍵版
node scripts/verify.mjs "/Volumes/BrainVault/x.docx"
```

回應重點：

| 欄位 | 意義 |
|---|---|
| `status.installed` | `true` ＝ 已接管 `openPath`（false 時看 `status.error`） |
| `rules` | 目前載入的規則 |
| `error` | 規則檔讀取／解析錯誤（壞檔時保留上一次成功的規則） |
| `probe.spec` | 這個路徑會用哪個 app（`null` ＝ 照系統預設） |
| `probe.apps` | DSH 選單會看到的 app 清單（第一筆、`default: true` 就是按鈕上的那個） |
| `last` | 最近一次真正開啟的紀錄（成功或失敗原因） |

## 安裝

### 1. 插件市場（推薦）

DSH → 設定 → Plugin Market → 搜尋 `dsh-open-with` → 安裝 → 重載頁面。
（市場上架需要 repo 滿一天，收錄狀態見 https://github.com/HildebrandYu/dsh-open-with）

### 2. 從 GitHub 安裝（web profile）

```sh
dsh plugin --profile web add github:HildebrandYu/dsh-open-with
```

### 3. 本機 checkout 直掛（本機目前的做法）

`~/.dsh/cordis.patch.yml`：

```yaml
- insert:
    - id: open-with
      name: 'file:///Volumes/BrainVault/30-CodingSkills/dsh-open-with/plugin/index.mjs'
```

再把 `hmr.config.root` 加上 `.../dsh-open-with/plugin`（改程式才需要熱重載；只改規則不用）。

> `plugin/index.mjs` 往上一個目錄就是套件根，`package.json` 宣告了 `dsh.bundle` 與 `dsh.client`，
> 所以設定頁的瀏覽器半會一起被載入。

## 移除

- 市場安裝：市場 → 已安裝 → 移除。
- 直掛：刪掉 `# >>> open-with BEGIN` 到 `# <<< open-with END` 那段（含 hmr 的 root），重啟 DSH。
- 規則檔 `~/.dsh/open-with.json` 可留可刪；刪掉即完全回到系統預設。

## 授權

MIT，見 [LICENSE](LICENSE)。

## 已知限制

- 只影響 **DSH 的「開啟」**；「顯示文件位置」（Finder 選取）不受影響，仍是 Finder。
- 工作區外的檔案一樣適用（用絕對路徑）；但路徑必須存在且能被 Host 解析，否則 DSH 會回錯誤。
- 選單裡若出現重複的 app（例如 `Pages` 與 `/Applications/Pages.app`），那是 macOS 關聯清單本身有兩筆；
  外掛只把第一筆符合的標成預設，兩筆都能開。
- 選單中選擇**別的** app 只影響那一次，不會改規則檔。
- DSH 升版若改了 `sessionController` 的介面，`status.installed` 會變 `false` 並在 `status.error` 說明；
  此時檔案會回到系統預設行為，不會壞掉。

## 檔案

```
package.json             套件根：dsh.bundle（插件市場安裝）＋ dsh.client（設定頁）
cordis.patch.yml         安裝時插入 profile 的 bundle patch
plugin/index.mjs         宿主半：接管 openPath、規則、診斷與設定路由
plugin/client.js         瀏覽器半：設定頁「檔案開啟方式」
test/matching.test.mjs   規則比對與 install/uninstall 的單元測試
test/client.test.mjs     瀏覽器半的 bundle id／分頁註冊／URL 組法
scripts/verify.mjs       打診斷路由，印出規則、probe 與前端是否已收錄
```

測試：`node --test test/`（目前 13 項全過）。

## 規則比對只有一條（2026-10-29）

「這條規則是不是在講這支 app？」以前有兩支實作（設定頁一支、選單點回來一支），答案會
不一樣：關聯 app 清單有顯示名稱、選單只送 id。現在合成一支 `sameApp(candidate, spec)`
（`plugin/index.mjs`），兩個呼叫端共用：

- 規則值是**路徑**（`/` 開頭）→ 比 id 全等。
- 其餘（顯示名稱）→ 先比顯示名稱，再退 id 的檔名（`文字編輯.app` ↔ `TextEdit`）。

候選端的形狀由呼叫端決定：關聯清單給 `{id, name}`、選單只給 id 字串。字串沒有顯示名稱
可比，所以**手寫的在地化名稱規則**在選單那條路上只比得到檔名 —— 設定頁存的一律是路徑，
正常操作不會產生這種規則。這個限制寫進函式註解與測試，不再靠人記得。

