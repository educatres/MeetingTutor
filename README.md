# MeetingTutor 會議記錄轉錄器

目前 repository 已完成第一版 MVP；規格文件仍是後續擴充與驗收的基準。

文件入口：

- [附件判讀與需求來源](docs/00_附件判讀與需求來源.md)
- [產品規格書](docs/01_產品規格書.md)
- [開發手冊](docs/02_開發手冊.md)
- [實施路線圖與驗收計畫](docs/03_實施路線圖與驗收計畫.md)

目前版本是可部署至 GitHub Pages 的靜態前端：以瀏覽器端 Whisper 進行語音轉錄，讓使用者自行提供並測試 OpenAI、xAI／Grok、Google 或 CGU 的 API Key，再以使用者選定的文字模型修飾語句、參照 PDF／文字資料並產出會議文件。CGU 仍需要正式 API 契約與 CORS 確認；若未提供可程式化 endpoint，介面會明確阻止假成功，不會把操作頁當成 REST API。

本機開發：`npm install` → `npm run dev`；發布建置：`npm run build`。GitHub Actions 已設定為推送 `main` 後部署 GitHub Pages。

