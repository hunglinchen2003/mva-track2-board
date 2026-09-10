# MVA Hackathon 2026 · Track 2 討論板

組員留言板：輸入姓名與 Track 2 進行方式提案、互相回覆，也可請本機 Ollama `gpt-oss:20b` 依提案產出規劃。留言存在 [Google 試算表](https://docs.google.com/spreadsheets/d/1lBt_9ARLPNZUOkS68ApBpddYzTcLCKJaHxh8Duc45dU/edit?usp=sharing)，網頁用 GitHub Pages 發布。

- 討論板：https://hunglinchen2003.github.io/mva-track2-board/
- 分析前言與流程：https://hunglinchen2003.github.io/mva-hackathon-2026-data/#workflow

## 架構

```
組員瀏覽器  ──GET/POST──►  Google Apps Script  ──►  Google 試算表
      ▲                         ▲
      │                         │
 GitHub Pages              Python worker（本機）
                                  │
                                  └──► Ollama gpt-oss:20b
```

GitHub Pages 只放靜態網頁。試算表負責存留言；跑在你電腦上的 `worker/ollama_worker.py` 會輪詢待規劃的提案，呼叫本機 Ollama，再把 AI 回覆寫回同一張表。

## 一次性設定：Apps Script

1. 打開 [共用試算表](https://docs.google.com/spreadsheets/d/1lBt_9ARLPNZUOkS68ApBpddYzTcLCKJaHxh8Duc45dU/edit?usp=sharing)。
2. 擴充功能 → Apps Script，貼上 [`apps-script/Code.gs`](apps-script/Code.gs) 後儲存。
3. 部署 → 新增部署 → 類型選「網頁應用程式」。
   - 執行身分：我
   - 存取權限：任何人
4. 複製 Web App URL（`https://script.google.com/macros/s/…/exec`）。
5. 寫進倉庫根目錄 `config.json` 的 `sheetsWebAppUrl`，推上 GitHub。組員瀏覽器也可先在網頁設定區暫存同一個 URL。

腳本會自動建立 `posts` 與 `meta` 兩個工作表。

## 本機 AI worker

先確認 Ollama 已安裝且模型存在：

```bat
ollama list
ollama run gpt-oss:20b
```

另開一個終端機：

```bat
cd worker
run.bat
```

或：

```bat
python worker\ollama_worker.py
```

程式會每 8 秒檢查試算表。討論板上勾選「請 AI 規劃」後，worker 會把規劃當成回覆寫進該串。網頁右上角在 worker 心跳 45 秒內會顯示「AI 在線」。

若不想改公共 `config.json`，可在 `worker/local_config.json` 覆寫：

```json
{
  "sheetsWebAppUrl": "https://script.google.com/macros/s/XXXX/exec"
}
```

## 留言欄位

| 欄位 | 說明 |
| --- | --- |
| id | UUID |
| parent_id | 空值為主串；有值則為回覆 |
| author | 姓名；AI 回覆為 `AI · gpt-oss:20b` |
| role | `human` 或 `ai` |
| content | 提案或回覆本文 |
| created_at | Asia/Taipei ISO 時間 |
| ask_ai | 是否請求 AI |
| ai_status | `none` / `pending` / `done` |

`config.json` 裡的 `teamToken` 必須與 `Code.gs` 的 `TEAM_TOKEN` 相同。
