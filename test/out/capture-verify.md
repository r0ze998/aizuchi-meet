# tabCapture 検証結果 (自動)

- 実行: 2026-10-17T09:52:29.240Z
- ブラウザ: Chrome/155.0.8059.84（Chrome for Testing。ブランド版 Chrome は `--load-extension` を無視するため）
- 拡張 ID: hkdniejckkeajnajkpdhgamjolbbcpch

| ID | 検証項目 | 結果 | 詳細 |
|---|---|---|---|
| A0 | 対象タブでトーン再生開始 | メモ | {"toneA":{"state":"running","hz":440},"tabId":809276974} |
| A0b | パネルの開始操作（同意画面経由） | メモ | {"r1":"clicked","consentVisible":true} |
| F | offscreen で使える API | メモ | {"speechRecognition":true,"speechAvailable":true,"translator":true,"languageModel":true,"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"} |
| C1 | 対象タブの音声を取得できる (440Hz トーンを offscreen で検出) | PASS | {"dominantHz":431,"dominantDb":-27,"rms":0.125,"captured":[{"fullscreen":false,"status":"active","tabId":809276974}],"trackLabel":""} |
| C1b | Web Speech API が tab 音声トラック入力で起動 (マイク要求なし) | PASS | {"sttState":"listening","sttIssues":[]} |
| C2 | 元のタブ音声を再生し続ける経路 (取得ストリーム→AudioContext.destination) が有効 | PASS | {"passthrough":true,"offscreenCtx":"running","tabCtx":"running","note":"スピーカー出力の聴感は自動計測不可。実通話で要確認"} |
| C3 | 別タブ (880Hz) の音声が混ざらない | PASS | {"dominantHz":431,"dominantDb":-25,"peak880":null,"peaks":[{"hz":431,"db":-25}]} |
| C3b | 取得音声は対象タブに追従する (440→523Hz) | PASS | {"dominantHz":517} |
| C4 | 任意マイクを有効にしない限り自分のマイクを取得しない | PASS | {"micActive":false,"micState":{"enabled":false,"state":"off"},"trackLabel":""} |
| C8 | 一時停止中も会議音声の再生経路は維持され、再開できる | PASS | {"pausedPassthrough":true,"ctx":"running"} |
| C5 | 停止すると取得が止まる (トラック終了・capture 状態解除)、タブ側の再生は継続 | PASS | {"captured":[{"fullscreen":false,"status":"stopped","tabId":809276974}],"trackState":"ended","ctxState":"closed","tabStillPlaying":{"ctx":"running","hz":523},"wiped":true} |
| C6 | 開始／停止を 3 回繰り返せる | PASS | {"repeatDetail":[{"i":0,"hz":517},{"i":1,"hz":517},{"i":2,"hz":517}]} |
| C7 | 対象タブを閉じると取得が止まる | PASS | {"reason":"track-ended","issues":["track-ended"]} |
| B1 | 呼び出し前は getMediaStreamId が拒否される (activeTab 型のゲート) | PASS | {"ok":false,"code":"needs-invoke","error":"Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured."} |
| B2a | 拡張の呼び出し経路 | メモ | {"via":"osascript","invokedTab":{"at":1792230767986,"tabId":733753838,"title":"Tone A (capture target)","url":"http://127.0.0.1:65397/tone-a.html","windowId":733753837}} |
| B2 | 実経路: ショートカットで拡張を呼び出した後は対象タブを取得できる (サイドパネルも開く) | PASS | {"startResult":{"ok":true},"invokedTab":{"at":1792230767986,"tabId":733753838,"title":"Tone A (capture target)","url":"http://127.0.0.1:65397/tone-a.html","windowId":733753837},"dominantHz":431} |
| B3 | 実サイドパネルが開いたか (CDP ターゲットに sidepanel.html が存在) | メモ | {"opened":false} |