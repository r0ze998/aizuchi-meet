# Aizuchi – Meet 英会話サポート（Chrome 拡張 + ローカル中継）

Google Meet タブの音声**だけ**を取得し、相手の英語を日本語で追いながら、登録した自分の情報に沿った**短い英語の返答候補（最大3つ）**を表示します。自動発話・チャット送信・マイクへの注入はしません。候補を見て、あなたが自分の声で話します。

状態ラベルの凡例（本リポジトリの文書で共通）:

| ラベル | 意味 |
|---|---|
| **実装済み** | コードがあり、ユニットテストまたは手元で動作確認済み |
| **モックで確認** | 専用 Chrome（Chrome for Testing）とテスト用音声・モック中継で自動確認済み |
| **実通話で確認** | 実際の 2 人の Meet 通話で確認済み（**まだありません**） |
| **未検証** | 実装はあるが動作確認していない |

## 構成

```
extension/   Manifest V3 拡張（service worker / offscreen document / side panel / options）
relay/       127.0.0.1 専用の中継サーバー（API キーはここだけが持つ。mock / anthropic）
test/        ユニットテスト（bun test）、自動検証ハーネス（Chrome for Testing + CDP）、音声フィクスチャ
docs/        計画・費用・プライバシー・テスト結果・遅延・既知の制約・Meet 実通話テストの依頼
```

音声の流れ: Meet タブ →(`tabCapture`)→ offscreen document → ① `AudioContext.destination`（会議を聞き続ける） ② 音声認識（Chrome Web Speech API）→ 日本語訳（Chrome Translator API・端末内）→ 質問の検知 → 返答候補（ローカル中継 → Claude、またはモック）→ サイドパネル。

## 必要なもの

- macOS、Google Chrome 139 以降（検証は 155 / Chrome for Testing 155）
- Node.js 20 以降（中継）、Bun 1.3 以降（テストとハーネス。`~/.bun/bin/bun`）
- 返答候補を本物の Claude で出す場合のみ: Anthropic Console の API キー（従量課金。**開発に使っている Claude Code の枠とは別**。docs/COST.md 参照）

## セットアップ

### 1. 拡張を読み込む（ブランド版 Chrome）

1. `chrome://extensions` → 右上「デベロッパーモード」をオン
2. 「パッケージ化されていない拡張機能を読み込む」→ このリポジトリの `extension/` を選ぶ
3. 一覧に表示された ID が `hkdniejckkeajnajkpdhgamjolbbcpch` であることを確認（manifest の `key` で固定しています。中継はこの ID からの呼び出しだけを受け付けます）
4. ツールバーのパズルアイコンから Aizuchi をピン留め（ショートカットは ⌘⇧Y）

Chrome 137 以降のブランド版は `--load-extension` フラグを無視するため、自動テストは Chrome for Testing を使います。手動の「読み込む」は通常の Chrome で動きます。

### 2. 中継を起動する（まずは mock）

```bash
cd relay && npm install && npm start
```

起動時にペアリングトークンが 1 回表示されます（`relay/relay-token` に 0600 で保存）。拡張の設定画面「ローカル中継」にトークンを貼り付けて保存し、「接続を確認」で `upstream=mock` が返ることを確認してください。トークンはチャットや Issue に貼らないでください。

### 3. 設定画面で準備する

- 「翻訳モデルを準備」: Chrome Translator API の en→ja モデルを初回ダウンロード（端末内で翻訳）
- 「登録情報」: プロジェクト・相手・目的・話せる事実／構想／未確定／避けたい約束を、更新日と出典付きで入力（「サンプルを読み込む」で雛形）
- 「明示する意思」: チェックしない限り、価格・納期・契約の質問には承諾ではなく確認・保留の候補だけが出ます

### 4. 使う

1. Meet タブでツールバーの Aizuchi アイコン（または ⌘⇧Y）を押す → サイドパネルが開き、そのタブが対象になります
2. パネルの「開始」→ 取得する音声と送信先の確認 → 同意して開始
3. 上から順に: 相手の英語と日本語訳（聞き取り中／確定を区別）／いま聞かれていること／返答候補（固定・「これを話した」）／「こう言いたい」入力／取りこぼし・エラー／遅延の計測
4. 「停止」で音声トラックと外部通信を止め、会議中の文脈をメモリから破棄します（既定）

### 5. 本物の Claude を使う（費用の確認後）

docs/COST.md の確認事項に同意したうえで `relay/.env` を作成します（`relay/.env.example` 参照、`chmod 600`）。

```
UPSTREAM=anthropic
ANTHROPIC_API_KEY=（Console のキー。チャットには貼らない）
REPLY_MODEL=claude-opus-5-5        # 低遅延・低費用なら claude-haiku-5-5
MAX_SESSION_USD=1.00
```

## テスト

```bash
bun test test/unit                              # ユニット／シナリオテスト（42 件）
bun test/harness/verify-capture.mjs             # 専用 Chrome で tabCapture を自動検証（docs/TEST-RESULTS.md）
bun test/harness/e2e-speech.mjs                 # 合成音声で認識→翻訳→候補を通し、遅延を計測（モック中継）
./test/fixtures/make-audio.sh                   # テスト音声を作り直す（macOS say）
```

初回のみ Chrome for Testing を取得します: `npx @puppeteer/browsers install chrome@stable --path .dev/browsers`

## ドキュメント

- [docs/PLAN.md](docs/PLAN.md) 実装計画・採用方式・権限・未確定点
- [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md) 検証結果（実装済み／モックで確認／実通話で確認／未検証）
- [docs/LATENCY.md](docs/LATENCY.md) 遅延の計測方法と p50/p95
- [docs/COST.md](docs/COST.md) 実行時費用の見積もりと、有料 API 利用前の確認事項
- [docs/PRIVACY.md](docs/PRIVACY.md) 何を取得し、どこへ送り、何を保存しないか
- [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) 既知の制約
- [docs/MEET-TEST-REQUEST.md](docs/MEET-TEST-REQUEST.md) 実際の Meet 通話での確認をあなたに依頼する手順
- [docs/DEMO.md](docs/DEMO.md) デモ手順
