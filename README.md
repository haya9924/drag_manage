# 服薬管理

服薬記録・在庫・購入・残日数・服薬時刻の通知をまとめて扱う、セルフホスト型のWebアプリです。
家計簿アプリ `budget_manage` と同じ構成（Node.js 標準機能のみ、`node:sqlite`、静的な SPA、Hermes 用 Bearer API）に合わせています。

## できること

- **今日の服薬**: 予定時刻ごとに「服用」「スキップ」「取消」。飲み忘れも表示
- **服薬記録**: 予定外の頓服・臨時服薬も記録
- **在庫管理**: 購入の追加、残数の棚卸し補正、服用に連動した自動減算
- **残数・残日数**: 曜日と予定時刻から1日平均使用量を計算し、残日数となくなる日を表示
- **在庫アラート**: 薬ごとに「残り何日分」で警告
- **服薬時間の通知**: ブラウザ通知（アプリを開いている間）と、Hermes がポーリングして外部通知するための API
- **履歴**: 服用・購入・残数修正の履歴
- **Hermes 操作用 API**: `/api/agent/*` に Bearer 認証付きで全操作を公開

## 起動

必要環境: **Node.js 22.18 以上**（型剥がし・`node:sqlite` を使用）。外部パッケージのインストールは不要です。

```bash
cp .env.example .env   # HERMES_TOKEN を必ず変更する
npm start              # http://127.0.0.1:8898
```

既定では `127.0.0.1` だけに待ち受けます（同じPCからのみアクセス可能）。LAN 内の別端末から使う場合だけ、`HOST=0.0.0.0` などを明示してください。`HERMES_TOKEN` が未設定の場合、`/api/agent/*` は fail closed となり、すべてのリクエストを拒否します。

```bash
HOST=0.0.0.0 npm start   # LAN 公開（UI API は認証なしなので信頼できるネットワークに限定）
```

データは `data/app.db`（SQLite）に保存されます。

```bash
npm test               # node:test による API テスト
```

### 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 待ち受けアドレス。LAN 公開時は `0.0.0.0` などを明示 |
| `PORT` | `8898` | 待ち受けポート |
| `HERMES_TOKEN` | 未設定 | `/api/agent/*` の Bearer トークン。未設定時は `/api/agent/*` を全面拒否（fail closed） |
| `INGEST_TOKEN` | 未設定 | `HERMES_TOKEN` の互換フォールバック（`HERMES_TOKEN` が未設定のときのみ） |
| `APP_TZ_OFFSET_MINUTES` | `540` | ローカル時刻の UTC オフセット（日本時間 = 540） |
| `MISS_AFTER_MINUTES` | `120` | 予定時刻から何分後に「飲み忘れ」とするか |
| `REMINDER_WINDOW_MINUTES` | `60` | 通知 API が返す猶予（予定時刻から何分後まで通知するか） |

日時はタイムゾーンなしのローカル文字列（`YYYY-MM-DDTHH:mm`）で保存します。日本時間には夏時間がないため固定オフセットで運用します。

## 画面

- **今日**: 服薬回数・飲み忘れ・在庫アラート・次の服薬。予定ごとの服用/スキップ/取消、頓服の記録
- **お薬**: 残数、残日数、なくなる日、服薬時刻。購入追加・残数修正・編集・服用予定の停止
- **履歴**: 期間を選んで服用・購入・残数修正を確認。履歴から服用/取消も可能

ブラウザ通知は「通知を有効に」から許可します。ページを開いている間（非表示タブを含む）は 30 秒ごとに通知 API を確認します。ただし、タブが閉じられている場合や、OS／ブラウザがバックグラウンドのタイマーを停止・間引いた場合は動作しません。Service Worker や Push API による配信は行いません。

アプリを閉じている間の通知は、Hermes が `/api/agent/notifications/due` を定期実行して外部（Telegram 等）へ送る想定です。`HERMES_TOKEN` が未設定の間はこの API 自体が拒否されるため、外部通知も行われません。

## 計算ルール

- **残数** = 購入数の合計 − 服用済みの数量 + 残数修正の合計
- **1日平均使用量** = 今日から7日間の曜日・期間条件を考慮した予定数量の合計 ÷ 7
- **残日数** = `floor(残数 / 1日平均使用量)`（予定がない薬は `null`）
- **在庫アラート** = 残日数が薬ごとの `low_stock_days` 以下（予定がない薬は残数 0 以下）
- 服用予定を変更しても、過去の服用履歴は残します。今日以降の未服薬分だけを新しい時刻・曜日で作り直します。
- 薬の削除は「服用予定の停止」（`active=0`）で、履歴と在庫は保持します。

### 通知配送の保証範囲

通知は「確実に届く」ものではありません。以下を前提にしてください。

- ブラウザ通知はアプリのページを開いている間だけです。非表示タブでも動くよう努めますが、OS／ブラウザの省電力・バックグラウンド制限、端末のスリープ、通知権限の変更などで止まることがあります。
- 通知 API の `claim=1` は、返却前にチャネル単位で既読化します。これは「同じ通知を二度返さない」ための仕組みで、配送成功の保証ではありません。Hermes が既読化後に外部送信へ失敗した場合、その通知は再送されません。
- `lookback`（既定 `REMINDER_WINDOW_MINUTES` = 60分）より長くポーリングが止まると、その間の通知候補は返りません。
- 通知権限が未許可のブラウザは `claim=0` で確認だけ行い、既読化しません。許可後に取得できる可能性がありますが、`lookback` を過ぎた分は対象外です。

### 残日数の限界

残日数と「なくなる日」は目安です。次の点を正確には扱いません。

- 今日から7日間の予定だけから1日平均を出すため、7日より先に始まる予定や、7日以内に終了する予定の影響は限定的です。
- 頓服・臨時服薬、飲み忘れ、将来の服薬予定変更、薬の有効期限、紛失などを予測しません。
- すべての予定を予定どおり服用する前提で、`floor` により日単位で切り捨てます。
- 残数がマイナスになることもあります（購入より服用・修正が多い場合）。
- 予定がない薬は `days_left = null` となり、残数が 0 以下のときだけ在庫アラートになります。

### 過去の予定と履歴

- 服薬予定の実体化（`dose_events` の生成）は「今日から先」だけです。過去の日付を表示しても、現在の予定設定から過去分を新規生成しません。
- 予定変更時に作り直すのは、今日以降の未服薬（pending）イベントだけです。服用済み・スキップ済み・過去日の記録は変更しません。
- アプリが停止していた期間など、実体化されなかった過去の予定は履歴に現れません。
- UI で時刻・曜日を編集できるのは、全時刻で曜日と1回量が同じで、終了日や未来の開始日がない「単純な予定」だけです。時刻ごとに曜日・量・期間が異なる予定は、UI では予定を上書きせず、名前・在庫設定などのみ保存できます（予定変更は API を使用）。

## API

### UI 用（認証なし）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/health` | 稼働確認 |
| GET | `/api/state?date=YYYY-MM-DD` | 当日（または指定日）の予定・薬・集計 |
| GET | `/api/medications` | 有効な薬の一覧（在庫・残日数つき） |
| POST | `/api/medications` | 薬の登録（`times` / `schedules` で予定も同時作成） |
| GET | `/api/medications/:id` | 薬1件 |
| PATCH | `/api/medications/:id` | 薬の更新（`schedules` / `times` を送ると予定も置換。送らない場合は予定の曜日・数量・期間を変更しない） |
| DELETE | `/api/medications/:id` | 服用予定を停止（論理削除） |
| PUT | `/api/medications/:id/schedules` | 服薬時刻・曜日を置換 |
| POST | `/api/medications/:id/purchases` | 購入を追加 |
| POST | `/api/medications/:id/adjustments` | 残数を補正（`delta` は符号つき） |
| GET | `/api/doses?date=YYYY-MM-DD` | 指定日の服薬予定・記録 |
| GET | `/api/doses?from=YYYY-MM-DD&to=YYYY-MM-DD` | 期間指定（最大366日） |
| POST | `/api/doses` | 予定外の服薬を記録 |
| POST | `/api/doses/:id/take` | 服用を記録（冪等） |
| POST | `/api/doses/:id/skip` | スキップ（冪等） |
| POST | `/api/doses/:id/undo` | 服用/スキップを取り消して未服薬に戻す |
| GET | `/api/history?days=30` | 服用・購入・残数修正の履歴 |
| GET | `/api/notifications/due` | 服薬時刻の通知候補 |

### Hermes 用（`Authorization: Bearer <HERMES_TOKEN>` 必須）

`/api/agent/*` は認証後、上記の `/api/*` と同じハンドラへ委譲されます。

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/agent/summary` | 今日の集計・薬一覧・在庫アラート・次の服薬 |
| GET | `/api/agent/low-stock` | 在庫アラートの一覧 |
| GET | `/api/agent/notifications/due` | 通知候補（既定チャネル `hermes`、取得と同時に既読化） |
| GET | `/api/agent/medications` | 薬一覧（`/api/medications` と同じ） |
| POST | `/api/agent/medications` | 薬の登録 |
| PATCH | `/api/agent/medications/:id` | 薬の更新 |
| DELETE | `/api/agent/medications/:id` | 服用予定の停止 |
| PUT | `/api/agent/medications/:id/schedules` | 予定の置換 |
| POST | `/api/agent/medications/:id/purchases` | 購入追加 |
| POST | `/api/agent/medications/:id/adjustments` | 残数補正 |
| GET | `/api/agent/doses?date=YYYY-MM-DD` | 服薬予定・記録 |
| POST | `/api/agent/doses` | 予定外の服薬記録 |
| POST | `/api/agent/doses/:id/take` | 服用を記録 |
| POST | `/api/agent/doses/:id/skip` | スキップ |
| POST | `/api/agent/doses/:id/undo` | 取消 |

### 通知 API

```bash
# Hermes が1分ごとに実行し、返った notifications を外部通知へ流す
curl -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/notifications/due?claim=1&lookback=60"
```

```json
{
  "now": "2026-11-11T20:52:57",
  "channel": "hermes",
  "claimed": true,
  "lookback_minutes": 60,
  "notifications": [
    {
      "event_id": 2,
      "medication_id": "8dbc663d-...",
      "medication_name": "ロキソニン",
      "scheduled_for": "2026-11-11T20:00",
      "quantity": 1,
      "unit": "錠",
      "message": "服薬時間です: 20:00 ロキソニン（1錠）",
      "minutes_overdue": 52
    }
  ]
}
```

- `claim=1`（既定）でチャネルごとに既読化し、同じ通知を二度返しません。`claim=0` は確認のみ。
- `channel` は `web` / `hermes` などの任意の名前（`[a-z0-9_-]`）。チャネル同士は独立しているため、ブラウザ通知と Hermes 通知が競合しません。
- `lookback` は予定時刻から何分後まで通知対象にするか（1〜1440、既定は `REMINDER_WINDOW_MINUTES`）。

### 主なリクエスト例

薬の登録（毎日 08:00 / 20:00、1回1錠）:

```bash
curl -X POST http://localhost:8898/api/medications \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "ロキソニン",
    "dose_quantity": 1,
    "unit": "錠",
    "times": ["08:00", "20:00"],
    "days": "1111111",
    "low_stock_days": 7
  }'
```

`days` は月〜日の7文字（`1`=服用）。`times` の代わりに以下のように時刻ごとの予定も指定できます。

```json
{
  "name": "薬A",
  "schedules": [
    { "time": "08:00", "days": "1111100", "quantity": 1 },
    { "time": "20:00", "days": "1111111", "quantity": 2 }
  ]
}
```

購入・残数補正・頓服:

```bash
curl -X POST http://localhost:8898/api/medications/<id>/purchases \
  -H 'Content-Type: application/json' \
  -d '{"quantity": 14, "purchased_at": "2026-11-11", "price": 980, "note": "2週間分"}'

curl -X POST http://localhost:8898/api/medications/<id>/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"delta": -2, "reason": "棚卸し"}'

curl -X POST http://localhost:8898/api/doses \
  -H 'Content-Type: application/json' \
  -d '{"medication_id": "<id>", "quantity": 1, "note": "頓服"}'
```

## 設計メモ

- 依存パッケージゼロ。Node の `http` / `node:sqlite` / `node:test` のみ
- 服薬予定は起動時と API アクセス時に `dose_events` へ実体化（`INSERT OR IGNORE`）し、履歴を失わずに予定変更へ追従。実体化は今日以降に限定し、過去へ現在の設定を遡及させない
- 通知は「予定 × チャネル」の既読テーブルで重複排除（at-most-once。配送保証なし）
- UI 用 API には認証がありません。既定で `127.0.0.1` にのみ待ち受け、外部公開する場合は `HOST` の指定とリバースプロキシ等による保護を行ってください
- 複数ユーザー・ログイン機能はありません（単一ユーザー向け）

## テスト

```bash
npm test
```

固定時刻（2026-05-01 08:05 JST）で、認証、予定生成、購入、服用、スキップ、取消、通知の既読化、予定変更、残日数アラート、履歴、バリデーションを検証します。

安全策のテストとして、トークン未設定時の `/api/agent/*` 拒否、薬の更新で時刻別の曜日・数量・期間が暗黙に変わらないこと、予定変更後に過去日へ新しい予定が生成されないことも検証します。
