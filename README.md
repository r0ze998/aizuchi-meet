# Aizuchi – Google Meet 英会話サポート（Chrome 拡張）

Google Meet タブの音声**だけ**を取得し、相手の英語を日本語で追いながら、登録した自分の情報に沿った**短い英語の返答候補（最大3つ）**を表示します。自動発話・チャット送信・マイクへの注入はしません。候補を見て、あなたが自分の声で話します。

**拡張機能だけで動きます。** 中継サーバーやターミナルは不要です（キーをブラウザの外に置きたい人向けに、ローカル中継も選べます）。

状態ラベルの凡例（本リポジトリの文書で共通）:

| ラベル | 意味 |
|---|---|
| **実装済み** | コードがあり、ユニットテストまたは手元で動作確認済み |
| **モックで確認** | 専用 Chrome（Chrome for Testing）とテスト用音声・偽 API／モック中継で自動確認済み |
| **実通話で確認** | 実際の 2 人の Meet 通話で確認済み（**まだありません**） |
| **未検証** | 実装はあるが動作確認していない |

## かんたんセットアップ（約 5 分）

必要なもの: macOS の Google Chrome 139 以降、Anthropic の API キー（従量課金。[Anthropic Console](https://console.anthropic.com/) で作成）。

1. **取得**: このリポジトリを clone するか、ZIP でダウンロードして展開します。

   ```bash
   git clone https://github.com/r0ze998/aizuchi-meet.git ~/aizuchi-meet
   ```

2. **拡張を読み込む**: `chrome://extensions` → 右上「デベロッパーモード」をオン →「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを選ぶ。ツールバーで Aizuchi をピン留めします（ショートカット ⌘⇧Y）。
3. **API キーを入れる**: Aizuchi のアイコンを右クリック →「オプション」→「Anthropic API」にキーを貼り付けて「キーを保存」→「接続を確認（無料）」で「接続OK」になれば完了です。
   - **このツール専用のキーを作り、Anthropic Console で使用上限を低めに設定**してください。キーはこの Chrome の拡張内にだけ保存されますが、暗号化はされていません（[docs/PRIVACY.md](docs/PRIVACY.md)）。
   - 拡張側にも「この会議の費用上限」（既定 $1）があり、超えると候補生成を止めます。
4. **登録情報を入れる**: 同じ画面の「登録情報」に、話せる事実・構想・未確定・避けたい約束を、更新日と出典つきで入れます（「サンプルを読み込む」で雛形）。チェックしない限り、価格・納期・契約の質問には承諾ではなく確認・保留の候補だけが出ます。

## 使い方（会議のたび）

1. 会議前に、設定画面の「相手」「会議の目的」を書き換える。
2. Meet に入り、**Meet のタブで** Aizuchi のアイコン（⌘⇧Y）を押す → サイドパネルが開く。
3. 「開始」→ 取得する音声と送信先の確認 → 同意して開始。初回だけ、端末内翻訳のモデルを自動でダウンロードします。
4. 上から「相手の英語と日本語訳 → いま聞かれていること → 返答候補」の順に読み、候補を**自分の声で**話す。使った候補は「これを話した」、読み途中の候補は「固定」、言いたいことがなければ「こう言いたい」に日本語で入力。
5. 「停止」で音声取得と通信を止め、会議中の文脈をメモリから破棄します（録音・全文の保存はしません）。

参加者には「英語理解の補助として文字起こしをしていること」を伝えてください。既定では音声が Google の音声認識に送られます。

## 費用

返答候補だけが有料です（音声認識と端末内翻訳は無料）。目安は 60 分の会議で **Claude Opus 5.5 約 $1.0〜1.5**、**Claude Haiku 5.5 約 $0.03**（設定でモデルを選べます）。開発に使った Claude Code の利用枠とは別に、API の従量課金がかかります。詳細は [docs/COST.md](docs/COST.md)。

## 構成

```
extension/   Manifest V3 拡張（service worker / offscreen document / side panel / options）
  vendor/    公式 Anthropic TypeScript SDK のブラウザ用ビルド（@anthropic-ai/sdk 0.135.0）
relay/       上級者向けのローカル中継（127.0.0.1 専用。キーをブラウザの外に置きたい場合）
test/        ユニットテスト、自動検証ハーネス（Chrome for Testing + CDP）、偽 Anthropic API、音声フィクスチャ
docs/        計画・費用・プライバシー・テスト結果・遅延・既知の制約・Meet 実通話テストの依頼
```

音声の流れ: Meet タブ →（`tabCapture`）→ offscreen document → ① `AudioContext.destination`（会議を聞き続ける）② 音声認識（Chrome Web Speech API）→ 日本語訳（Chrome Translator API・端末内）→ 質問の検知 → 返答候補（拡張から Anthropic に直接）→ サイドパネル。

## 上級者向け：ローカル中継

キーをブラウザに置きたくない場合は、設定画面の「返答候補」を「ローカル中継」にし、`relay/.env`（`relay/.env.example` 参照、`chmod 600`）にキーを書いて中継を起動します。

```bash
cd relay && npm install && npm run start:claude
```

起動時に表示されるペアリングトークンを設定画面の「ローカル中継」に貼ります（`npm run token` で再表示）。

## テスト

```bash
bun test test/unit                                  # ユニット／シナリオテスト（54 件）
bun test/harness/verify-capture.mjs                 # 専用 Chrome で tabCapture を自動検証
E2E_REPLY=direct bun test/harness/e2e-speech.mjs    # 合成音声→認識→翻訳→候補（拡張から偽 Anthropic API へ直接）
bun test/harness/e2e-speech.mjs                     # 同上（ローカル中継・モック）
```

初回のみ Chrome for Testing を取得します: `npx @puppeteer/browsers install chrome@stable --path .dev/browsers`。SDK を更新したら `cd relay && bun build ./sdk-entry.mjs --target=browser --format=esm --minify --outfile ../extension/vendor/anthropic-sdk.js` で作り直します。

## ドキュメント

- [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md) 検証結果（実装済み／モックで確認／実通話で確認／未検証）
- [docs/LATENCY.md](docs/LATENCY.md) 遅延の計測方法と p50/p95
- [docs/COST.md](docs/COST.md) 実行時費用と上限
- [docs/PRIVACY.md](docs/PRIVACY.md) 何を取得し、どこへ送り、何を保存しないか
- [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) 既知の制約
- [docs/MEET-TEST-REQUEST.md](docs/MEET-TEST-REQUEST.md) 実際の Meet 通話での確認手順
- [docs/DEMO.md](docs/DEMO.md) デモ手順
- [docs/PLAN.md](docs/PLAN.md) 当初の実装計画

## ライセンス

[MIT](LICENSE)
