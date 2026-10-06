# Richart 今天切哪個 — 開發上下文

## 專案
台新 Richart 卡 8 個回饋方案的查詢小工具（非官方），部署在 GitHub Pages：https://yachiof94.github.io/richart-tool/
原始執行計畫在 `notes/richart_tool_plan.md`（本機筆記，不進版控）。

## 技術
純靜態：HTML＋Vanilla JS＋JSON，沒有建置步驟，也不載入任何外部資源（CDN、外部字型、GA 都不用）。

## 關鍵檔案
- 判斷邏輯：`js/rules.js`（純函式；`rateFor` 是三個功能共用的回饋判斷）
- 介面：`index.html`、`js/app.js`、`assets/css/style.css`
- 資料：`data/richart_plans.json`（App 畫面轉錄，只改 `plans`）、`data/extras.json`（別名、餐飲、不回饋項目等補充規則）、`data/holidays.json`（人事總處辦公日曆表）
- 驗收：`test.html`（計畫書第 5 節＋補充案例；改規則或資料後要全部通過）
- 工具：`tools/build_lookup.py`（重建 `lookup.by_store`、印核對數字）

## 與計畫書不同的決定（2026-10-06）
- 部署改走 GitHub Pages（計畫書原本是 artifact），資料拆成 `data/*.json`，不內嵌在 HTML。
- 三個功能都做：查店家、清單外店家、今日試算。
- 版面：查店家放最上面，日期／假日／目前方案收在最下面一行（使用者選的 A 版）。
- 查店家、清單外店家不再用全域付款方式，改成比較各付款方式（`comparePayments`）；「若店家可用」的回饋列為可能、不當最佳；台新Pay+ 只在海外或日韓店家才列。

## 協作規則
- 任何程式碼修改前，先說明計畫，等確認後才動工
- 不自行 push、不開 PR；push 前先列出 remote URL、分支、commit 作者、要推的檔案，等確認
- commit 作者用 repo-local 設定（GitHub noreply 信箱），不要改用全域 git 身分；commit 訊息不加 Co-Authored-By
- remote URL 要內嵌帳號（`https://yachiof94@github.com/yachiof94/richart-tool.git`），Git Credential Manager 才會挑對帳號的憑證

## 本機測試
在專案根目錄執行 `python -m http.server 8765 --bind 127.0.0.1`，開 `http://127.0.0.1:8765/test.html`。
