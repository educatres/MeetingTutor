# MeetingTutor 會議記錄、上課錄音助教

目前 repository 已完成第一版 MVP；規格文件仍是後續擴充與驗收的基準。

文件入口：

- [附件判讀與需求來源](docs/00_附件判讀與需求來源.md)
- [產品規格書](docs/01_產品規格書.md)
- [開發手冊](docs/02_開發手冊.md)
- [實施路線圖與驗收計畫](docs/03_實施路線圖與驗收計畫.md)

目前版本是可部署至 GitHub Pages 的靜態前端：以瀏覽器端 Whisper-base（可切換 Whisper-tiny 或 Whisper-medium）進行語音轉錄，讓使用者自行提供並測試 OpenAI、xAI／Grok、Google 或 CGU 的 API Key，再以使用者選定的文字模型修飾語句、參照 PDF／文字資料並產出會議文件。CGU base URL 已預設為 `https://air.cgu.edu.tw/cgullmapi/v1`；仍需要確認模型清單格式與 CORS 政策，介面不會把操作頁當成 REST API。

本機開發：`npm install` → `npm run dev`；發布建置：`npm run build`。GitHub Actions 已設定為推送 `main` 後部署 GitHub Pages。

## GitHub Pages 一次性設定

到 repository 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**，再重新推送或在 Actions 手動執行 `Deploy to GitHub Pages`。目前若尚未啟用 Pages，workflow 的 `Configure Pages` 會失敗，但前面的依賴安裝與 production build 仍會通過。

## MVP 已知限制

- CGU 已預設 base URL，但仍需要確認模型清單格式與 CORS 政策；若呼叫不符合正式契約，介面會拒絕假成功。
- OpenAI、xAI、Google 是否允許瀏覽器直連取決於各服務的 CORS／帳戶設定；失敗時需使用供應商允許的 endpoint 或日後另建受控 relay。
- Whisper 模型與 ONNX runtime 初次下載較大，第一次轉錄需要等待；目前使用 WASM 基線，尚未加入 WebGPU 自動切換。
- MVP 以段落編輯與人工標記 speaker 為主，尚未提供可靠的自動說話者分離。
- API Key、Provider、Base URL、選定模型、推理程度與自訂 System Prompt 會保存在目前瀏覽器的 `localStorage`，重新整理後可直接沿用；使用者可從頁首的「AI 設定」面板清除 API Key 或修改設定。請只在自己信任的裝置使用此功能。

