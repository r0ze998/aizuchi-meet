# Aizuchi – Meet英会話サポート 実装計画

作成日: 2026-10-17 / 状態: 初版（実装と並行して更新）

## 1. 目的と範囲

- Google Meet（Mac の Chrome）で相手の英語を日本語で理解し、自分の登録情報に沿った短い英語の返答候補（最大3つ）を見ながら自分の声で話すための支援ツール。
- 自動発話、Meet チャットへの送信、マイクへの合成音声注入は実装しない。
- 既存の他プロジェクトとは独立したプロジェクト（このリポジトリで完結）。

## 2. 採用方式（比較の結論）

### 2.1 音声取得

| 方式 | 取得範囲 | 権限・操作 | 採否 |
|---|---|---|---|
| `chrome.tabCapture.getMediaStreamId` + offscreen document | 対象タブの音声のみ | `tabCapture`。ユーザーが拡張を「呼び出した」タブに限る（アクションクリック／ショートカット） | **採用** |
| `getDisplayMedia` | ユーザーが選んだタブ・ウィンドウ・画面 | 毎回ピッカー。画面共有と誤認しやすい | 不採用（フォールバック候補） |
| `desktopCapture` / システム全体の音声 | 全アプリ音声 | 範囲が広すぎる。要求外 | 不採用 |

- tabCapture 中はタブ音声がユーザーに再生されなくなるため、offscreen document の `AudioContext` で取得ストリームを `destination` に接続して再生を続ける。自分のマイクはこの経路に混ぜない。
- 取得は Meet タブのアクションクリック（またはショートカット）で拡張を呼び出した後、サイドパネルの「開始」で始める。呼び出しが失効していれば「アイコンをクリックしてください」と案内する。

### 2.2 音声認識・翻訳・返答生成（差し替え可能）

| 工程 | 既定 | 代替 | 送信先 | 費用 |
|---|---|---|---|---|
| 音声認識 | Chrome Web Speech API（`SpeechRecognition.start(MediaStreamTrack)`） | オンデバイス（`processLocally`、言語パック要）／ローカル中継経由の外部STT（**未実装**、拡張点のみ） | 既定: Google 音声認識サーバー。オンデバイス時: 送信なし | 無料 |
| 日本語訳 | Chrome Translator API（オンデバイス） | ローカル中継 → Claude | 既定: 送信なし。代替: Anthropic | 既定: 無料 |
| 返答候補・要約・言い直し | ローカル中継 → Claude（`claude-opus-5-5` 既定、`claude-haiku-5-5` 選択可） | Chrome Prompt API（Gemini Nano、**任意・未検証**）／モック | Anthropic（中継は 127.0.0.1 のみ） | 従量課金（docs/COST.md） |

選定理由: 遅延（ストリーミング認識・オンデバイス翻訳で往復を減らす）、日本語品質（翻訳はオンデバイスでも実用、候補生成は Claude）、費用（認識・翻訳を無料化し、有料は候補生成に限定）、送信先（音声そのものは Google か端末内に留まり、Anthropic へは文字起こしの一部と登録情報だけを送る）。

### 2.3 秘密情報の扱い

- API キーは拡張のソース・配布物・`chrome.storage` に置かない。
- ローカル中継（`relay/`）が 127.0.0.1 にのみ bind し、`Origin: chrome-extension://<固定ID>` とペアリングトークンを検証する。
- キーは中継プロセスの環境変数（または 0600 の `relay/.env`）からのみ読む。ログに本文・キーを出さない。
- 中継はセッション上限（USD）と毎分リクエスト上限を持つ。

## 3. 構成

```
Meet タブ ──tabCapture──▶ offscreen document（セッションの本体）
                           ├─ AudioContext: 取得音声 → スピーカー（再生継続）
                           ├─ レベル監視（取りこぼし検知・VAD）
                           ├─ STT provider（Web Speech / mock）
                           ├─ Segmenter（安定した部分から日本語訳）
                           ├─ QuestionTracker（暫定／確定、訂正・否定の検知）
                           ├─ Translate provider（Chrome Translator / relay / mock）
                           ├─ Reply provider（relay → Claude / Prompt API / mock）
                           └─ Metrics（p50 / p95）
service worker: アクション・ショートカット・タブ終了の監視、streamId 取得、offscreen 作成
side panel: 表示と操作（開始・停止・一時停止・固定・「これを話した」・言い直し）
options: 登録情報（事実／構想／未確定、更新日・出典）、提供元設定、中継ペアリング
relay (127.0.0.1): /v1/translate, /v1/reply(SSE), /v1/health
```

## 4. 必要な権限（manifest）

- `tabCapture`（タブ音声）、`offscreen`（バックグラウンド処理）、`sidePanel`、`storage`（登録情報・設定。キーは保存しない）、`activeTab`（呼び出したタブの識別）。
- `host_permissions`: `http://127.0.0.1/*`（ローカル中継のみ）。
- `commands`: `_execute_action`（Cmd+Shift+Y）。
- 任意マイク（自分の発言を文脈に入れる）は既定オフ。オンにする時だけ別経路で `getUserMedia({audio})` を要求し、「自分(マイク)」ラベルで扱う。

## 5. 遅延の設計

- 翻訳: 認識途中のテキストのうち、一定時間変化しなかった前方部分を「途中訳」として先に訳し、確定で置き換える。
- 候補: 質問の意図が十分分かった時点（疑問文の形・沈黙）で「暫定」候補を生成し、確定で再生成。発言途中の否定・訂正（"actually", "no wait", "I mean" など）を検知したら進行中の生成を中止して作り直す。
- 保護: 短い待機（デバウンス）、同一テキストの重複排除、古い生成のキャンセル（AbortController）、音声・認識イベントキューの上限、音声落ちの表示。
- 計測: 取得→認識（発話開始→最初の途中結果、発話終了→確定）、認識→翻訳、質問確定→最初の候補表示を別々に記録し p50/p95 を表示・書き出し。目標値（訳は数秒、最初の候補は1〜2秒）は検証目標であり保証しない。

## 6. 検証の順序

1. 専用の Chrome for Testing（ブランド版 Chrome 137 以降は `--load-extension` を無視するため）で拡張を読み込み、テスト用トーンページを使って tabCapture の 5 項目を自動検証。
2. `say` で生成した英語音声で、認識→翻訳→候補の一連の流れをモック中継で通し、遅延を計測。
3. 実際の Meet 通話（2人）での確認は、あなたへの依頼事項として docs/MEET-TEST-REQUEST.md にまとめる。モックの成功を実通話の成功とは報告しない。

## 7. 未確定点（検証で潰す）

- `SpeechRecognition.start(track)` が offscreen document で動作するか（動かなければサイドパネル側で認識する構成を検討）。
- Translator API が offscreen document から使えるか、モデルダウンロードに user activation が必要か。
- 自動テストで「拡張の呼び出し」をどう再現するか（`--allowlisted-extension-id` は検証専用。実経路はショートカット送出または手動）。
- Gemini Nano（Prompt API）はモデルが数GBで、ダウンロードはあなたの承認後。
- Meet 実通話での認識精度・遅延。

## 8. 費用と承認が必要な事項

- 開発に使っている Claude Code（Fable）の利用枠は、完成アプリの実行時 API 利用とは別。実行時は Anthropic Console のキー（従量課金）が必要。
- 有料 API を実際に呼ぶ前に、送信先・送るデータ・30分/60分の推定費用・上限を docs/COST.md で提示し、あなたの確認を待つ。確認前はモック中継で進める。
- 拡張の権限付与、外部公開、push・マージも事前確認。

## 9. 実装しないこと

- 自動発話、Meet チャットへの送信、仮想マイクへの注入、録音ファイル保存、全文文字起こしの保存（既定）、システム全体の音声取得。
