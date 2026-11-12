---
name: drag-manage
description: 服薬管理アプリ（drag_manage）の服薬予定・服用記録・在庫・通知をHermesから安全に確認・操作する。今日の服薬確認、服用・スキップ・取消、頓服の記録、購入・棚卸し、残数アラート、通知取得を依頼されたときに使う。重複服薬を避ける確認手順を含む。
---

# 服薬管理（drag_manage）Hermes スキル

## 1. このスキルの目的

セルフホスト型の服薬管理アプリ `drag_manage` を、Hermes から Bearer API 経由で操作します。

- 今日の服薬予定・飲み忘れ・在庫アラートを確認する
- ユーザーの明示的な指示に従って、服用・スキップ・取消を記録する
- 頓服、購入、棚卸し補正を記録する
- 服薬時刻の通知候補を取得して外部通知へ流す
- 薬の登録・予定変更・服用予定の停止を行う

**このアプリは医療機器ではありません。** 服薬量・服用間隔・中止の判断は行わず、処方医・薬剤師・添付文書に従うよう案内してください。

---

## 2. 接続情報

- 既定のベース URL: `http://localhost:8898`
- 環境に応じて `http://<host>:8898` などに読み替える。
- Hermes 用 API のパスは `/api/agent/*`。
- 認証ヘッダー:

```http
Authorization: Bearer $HERMES_TOKEN
```

- トークンは環境変数から読み、**値を表示・記録・送信しない**。
- `HERMES_TOKEN` が未設定の場合は操作を開始しない。ユーザーにトークン設定を依頼する。UI 用の `/api/*` を代用しない。
- `curl` は `-sS` を使い、`-v` は使わない（認証ヘッダーが出力される可能性がある）。

疎通確認（認証不要）:

```bash
curl -fsS http://localhost:8898/api/health
```

認証確認:

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  http://localhost:8898/api/agent/summary
```

`401 {"error":"unauthorized"}` の場合は、トークンの設定・変更・再起動を確認します。トークンを推測して総当たりしないでください。

---

## 3. 絶対に守る安全ルール

1. **通知の取得だけで服用済みにしない。** `notifications/due` は通知候補を返すだけです。ユーザーが「飲んだ」と明示した場合だけ `take` します。
2. **予定の服薬は `doses/:id/take` を使う。** 同じイベントに対する `take` は冪等で、在庫を二重に減らしません。
3. **`POST /doses`（予定外の服薬）は重複防止がない。** 記録前に今日の記録を確認し、同じ薬・同じ時刻の記録がないことを確かめます。二重登録すると在庫も二重に減ります。
4. **購入・残数補正も重複防止がない。** 同じ操作を二重送信しない。通信エラー後に盲目的に再送しない。
5. **薬は名前ではなく `medication_id` と `event_id` で特定する。** 同名の薬が複数登録される可能性があります。
6. **対象が曖昧なら操作しない。** どの薬・どの予定・何錠かが不明な場合は、ユーザーに確認します。
7. **服薬量・服用間隔・中止を判断しない。** 医療上の判断はせず、必要なら医療従事者への相談を促します。
8. **スキップ・取消・購入・残数補正・予定変更・削除は、ユーザーの明示的な指示がある場合だけ行う。** 推測で変更しない。
9. **緊急時はアプリ操作より救急・医療機関への連絡を優先する。** 過量服薬、アナフィラキシー、意識障害などが疑われる場合は、操作を中断して救急へ連絡するよう伝えます。
10. **トークンと健康情報を外部へ漏らさない。** トークンを URL・ログ・通知本文・スクリーンショット・チャットに含めない。

### 重複服薬チェックリスト（服用記録の前）

- [ ] `medication_id` と `event_id` を確認した
- [ ] 予定の日時と薬名が、ユーザーの指示と一致している
- [ ] `status` が `pending`（または `display_status` が `due` / `upcoming` / `missed`）である
- [ ] すでに `taken` ではない（`taken` なら再記録しない）
- [ ] 予定外の服薬の場合、今日の `doses` に同じ薬・同時刻の記録がない
- [ ] 数量がユーザーの指示と一致している
- [ ] 飲み忘れ・重複が疑われる場合、追加服用せず医療従事者へ相談するよう案内した

---

## 4. まず状態を確認する

### 今日のサマリー

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/summary"
```

主なフィールド:

- `now`: アプリの現在時刻（ローカル、秒あり）
- `today`: 今日の日付
- `counts`: `total` / `taken` / `skipped` / `due` / `missed` / `upcoming` / `pending` / `done`
- `medications`: 有効な薬と在庫・残日数
- `low_stock`: 在庫アラート対象の薬
- `alerts`: 表示用の警告メッセージ
- `next_dose`: 次に飲む予定（`due` 優先、なければ `upcoming`）。なければ `null`
- `doses`: 今日の服薬予定・記録

服用記録に使う `doses` の例:

```json
{
  "id": 1,
  "medication_id": "8dbc663d-...",
  "scheduled_for": "2026-05-01T08:00",
  "planned_quantity": 1,
  "status": "pending",
  "quantity": 0,
  "taken_at": null,
  "medication_name": "ロキソニン",
  "unit": "錠",
  "display_status": "due",
  "minutes_from_now": -5
}
```

`status` は `pending` / `taken` / `skipped`、`display_status` は `taken` / `skipped` / `missed` / `due` / `upcoming` です。

### 指定日の予定

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/doses?date=2026-05-01"
```

期間指定（最大 366 日）:

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/doses?from=2026-04-01&to=2026-04-30"
```

### 状態 API（委譲）

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/state?date=2026-05-01"
```

`/api/agent/*` は、専用エンドポイント以外は `/api/*` と同じハンドラへ委譲されます。UI 用 API のパスを `/api/agent` に置き換えると、同じボディで呼べます。

---

## 5. 操作別の手順

### 5.1 今日の服薬を確認する

1. `GET /api/agent/summary` を呼ぶ。
2. `counts`、`next_dose`、`low_stock`、`alerts` を確認する。
3. 未服薬（`pending`）の予定を、予定時刻順にユーザーへ伝える。
4. 在庫アラートがあれば、薬名・残日数・なくなる日を伝える。
5. 飲み忘れ（`missed`）があっても、勝手に服用記録を付けない。ユーザーに確認する。

### 5.2 予定の服薬を記録する（服用）

ユーザーが「飲んだ」と明示した場合だけ行います。

1. `GET /api/agent/summary` または `GET /api/agent/doses?date=<today>` で対象イベントを探す。
2. `medication_id`、`scheduled_for`、`medication_name`、`status` を確認する。
3. `id` を使って服用を記録する。

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "http://localhost:8898/api/agent/doses/<event_id>/take"
```

数量を明示された場合:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"quantity": 1, "note": "ユーザー報告"}' \
  "http://localhost:8898/api/agent/doses/<event_id>/take"
```

レスポンス:

```json
{
  "dose": { "id": 1, "status": "taken", "quantity": 1 },
  "already": false
}
```

- `already: true` の場合は、すでに服用済みです。**再記録せず、在庫も変わりません。**
- `taken_at` を指定する場合は `YYYY-MM-DDTHH:mm` または `YYYY-MM-DDTHH:mm:ss`。通常は省略し、アプリの現在時刻を使います。
- `skipped` のイベントに `take` すると `taken` に変わります。ユーザーの指示を確認してください。

### 5.3 スキップする

ユーザーが「今回は飲まない」「スキップ」と明示した場合だけ行います。

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"note": "ユーザー指示"}' \
  "http://localhost:8898/api/agent/doses/<event_id>/skip"
```

- すでに `taken` の場合は `409 {"error":"already taken; undo first"}`。勝手に `undo` せず、ユーザーに確認します。
- すでに `skipped` の場合は `already: true` で、在庫は減りません。

### 5.4 服用・スキップを取り消す

ユーザーが「間違えて記録した」「取り消して」と明示した場合だけ行います。

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/doses/<event_id>/undo"
```

- 状態は `pending` に戻り、`quantity=0`、`taken_at=null` になります。在庫は服用前の計算に戻ります。
- `undo` の後に `take` し直すと、在庫計算が再び変わります。ユーザーの指示を確認してから行います。

### 5.5 予定外の服薬（頓服）を記録する

**最初に今日の記録を確認します。**

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/doses?date=<today>"
```

同じ `medication_id`・同じ時刻・同じ数量の記録がないことを確認してから:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "medication_id": "<medication_id>",
    "quantity": 1,
    "note": "頓服",
    "source": "hermes"
  }' \
  "http://localhost:8898/api/agent/doses"
```

- `scheduled_for` を省略すると、アプリの現在時刻で記録されます。
- 過去の服薬を記録する場合は `scheduled_for` を `YYYY-MM-DDTHH:mm` で明示します。
- `status` は既定 `taken`。`skipped` / `pending` も指定できますが、通常は使いません。
- **この API は呼ぶたびに新しい記録を作ります。** 同じ内容を二重送信すると、在庫も二重に減ります。
- `source: "hermes"` は監査用の区別です。指定しない場合は `manual` になります。

### 5.6 購入を追加する

ユーザーが購入数量・購入日・価格を明示した場合だけ行います。

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "quantity": 14,
    "purchased_at": "2026-05-01",
    "price": 980,
    "note": "2週間分",
    "source": "hermes"
  }' \
  "http://localhost:8898/api/agent/medications/<medication_id>/purchases"
```

- `quantity`: 0.01〜100000、必須。
- `purchased_at`: `YYYY-MM-DD`、省略時は今日。
- `price`: 0 以上の整数（円を想定）、省略可。
- 重複防止はありません。通信エラー後に再送する前に、薬の残数と履歴を確認してください。

### 5.7 残数を補正する（棚卸し）

ユーザーが補正値と理由を明示した場合だけ行います。

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"delta": -2, "reason": "棚卸し", "source": "hermes"}' \
  "http://localhost:8898/api/agent/medications/<medication_id>/adjustments"
```

- `delta` は符号つき（減らすならマイナス）。0 は不可。-100000〜100000。
- 「残数が 10 錠」と言われた場合、`delta` は「現在の残数との差」です。現在の `stock` を確認して計算し、ユーザーに確認してください。
- 重複防止はありません。二重送信すると残数が二重に補正されます。

### 5.8 薬を登録する

ユーザーが薬名・1 回量・服薬時刻・曜日・単位を明示した場合だけ行います。服薬量の医学的判断はしません。

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ロキソニン",
    "dose_quantity": 1,
    "unit": "錠",
    "times": ["08:00", "20:00"],
    "days": "1111111",
    "low_stock_days": 7,
    "notify": true
  }' \
  "http://localhost:8898/api/agent/medications"
```

- `name` は必須、最大 100 文字。
- `dose_quantity` は 0.01〜100000（既定 1）。
- `unit` は最大 20 文字（既定 `錠`）。
- `days` は月〜日の 7 文字（`1`=服用）。例: 平日だけなら `1111100`。曜日番号の配列（0=月〜6=日）も可。
- `low_stock_days` は 0〜3650 の整数（既定 7）。
- `times` の代わりに `schedules` を送ると、時刻ごとに曜日・数量・開始日・終了日を指定できます。

```json
{
  "name": "薬A",
  "schedules": [
    { "time": "08:00", "days": "1111100", "quantity": 1 },
    { "time": "20:00", "days": "1111111", "quantity": 2 }
  ]
}
```

- `schedules` は最大 24 件、同じ時刻の重複は不可。
- `schedules` と `times` を同時に送ると `schedules` が優先されます。
- 同名薬の登録は API では禁止されません。ユーザーに確認してください。

### 5.9 予定を変更する

**置換 API です。** 既存の予定を残したい場合も、希望する予定をすべて含めて送る必要があります。省略した時刻の予定は `enabled=0` になります。

1. `GET /api/agent/medications/<medication_id>` で現在の `schedules` を取得する。
2. ユーザーの希望を反映して、予定の全リストを作る。
3. `PUT /api/agent/medications/<medication_id>/schedules` に全リストを送る。

```bash
curl -fsS -X PUT \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schedules": [
      { "time": "08:00", "days": "1111111", "quantity": 1 },
      { "time": "20:00", "days": "1111100", "quantity": 1 }
    ]
  }' \
  "http://localhost:8898/api/agent/medications/<medication_id>/schedules"
```

- 未来の未服薬イベントは削除・再生成されます。過去の服用・スキップ履歴は残ります。
- 予定変更は服薬量の変更を意味する場合があります。ユーザーの明示的な指示を確認してください。
- `PATCH /api/agent/medications/<id>` でも `schedules` / `times` を送れば置換できます。`schedules` を送らない場合も、未来の未服薬イベントが再生成されます。

### 5.10 服用予定を停止する（論理削除）

ユーザーが「中止」「削除」と明示した場合だけ行います。

```bash
curl -fsS -X DELETE \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/medications/<medication_id>"
```

- 薬は `active=0` になり、一覧・サマリー・通知から外れます。履歴と在庫は残ります。
- 物理削除はできません。再有効化は `PATCH /api/agent/medications/<id>` に `{"active": true}` を送ります（予定が残っていれば再開します）。
- 一時的な休薬か完全な中止かを確認してください。医療判断はしません。

### 5.11 在庫アラートを確認する

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/low-stock"
```

`low_stock` と `alerts` を返します。`summary` の `low_stock` / `alerts` と同じ内容です。

### 5.12 履歴を確認する

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/history?days=30"
```

- `days` は 1〜365（既定 30）。
- `doses`、`purchases`、`adjustments` を返します。
- 服用・購入・残数修正の確認に使います。過去の飲み忘れを推測で埋めないでください。

---

## 6. 通知の取得と外部通知

### 6.1 基本のポーリング

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/notifications/due?claim=1&lookback=60"
```

レスポンス:

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

- `channel` の既定は `hermes`。ブラウザ通知は `web` を使うため、競合しません。
- `claim=1`（既定）は取得と同時に既読化します。同じチャネルでは同じ通知が二度返りません。
- `claim=0` は既読化せずに確認するだけです。配信前の下見・デバッグ用で、配信そのものには使わないでください。
- `lookback` は 1〜1440 分（既定 `REMINDER_WINDOW_MINUTES`、通常 60）。ポーリング間隔より十分大きくしてください。
- 通知対象は `pending` かつ薬が `active=1` かつ `notify=1` の予定だけです。服用済み・スキップ済みは返りません。

### 6.2 通知の配信上の注意

- **at-most-once です。** `claim=1` で既読化した後に外部通知の送信に失敗しても、同じチャネルでは再取得できません。
- 送信失敗時は、同じ通知を別チャネルで再取得しようとしないでください（重複通知になります）。`/api/agent/summary` で未服薬を確認し、ユーザーに伝えます。
- 1 つのチャネルにつき 1 つのポーラーにしてください。複数の Hermes が同じチャネルを同時に叩くと、取得が競合します。
- 通知メッセージには薬名が含まれます。送信先のプライバシー設定を確認してください。
- 通知は「服薬時間です」という促しであり、服用の指示ではありません。ユーザーが飲んだかどうかは別途確認します。

### 6.3 通知のテスト

既読化せずに候補を確認:

```bash
curl -fsS \
  -H "Authorization: Bearer $HERMES_TOKEN" \
  "http://localhost:8898/api/agent/notifications/due?claim=0&lookback=60"
```

実際に配信する場合だけ `claim=1` を使います。テストで `claim=1` を使うと、その通知は本番で返らなくなります。

---

## 7. API リファレンス

### 7.1 認証

- `/api/agent/*` は `Authorization: Bearer <HERMES_TOKEN>` が必要。
- `HERMES_TOKEN` と `INGEST_TOKEN` が未設定の場合、Agent API は利用できない。Hermes はトークン未設定なら操作を中止する。
- `INGEST_TOKEN` は `HERMES_TOKEN` の互換フォールバック。
- `/api/*`（UI 用）は認証なし。Hermes の書き込みには使わない。

### 7.2 読み取り

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/agent/summary` | 今日の集計・薬・在庫アラート・次の服薬・今日の予定 |
| GET | `/api/agent/low-stock` | 在庫アラート |
| GET | `/api/agent/state?date=YYYY-MM-DD` | 指定日の状態（委譲） |
| GET | `/api/agent/medications` | 有効な薬の一覧 |
| GET | `/api/agent/medications/:id` | 薬 1 件（無効な薬も ID 指定で取得可） |
| GET | `/api/agent/doses?date=YYYY-MM-DD` | 指定日の予定・記録 |
| GET | `/api/agent/doses?from=YYYY-MM-DD&to=YYYY-MM-DD` | 期間指定（最大 366 日） |
| GET | `/api/agent/history?days=30` | 履歴（1〜365 日） |
| GET | `/api/agent/notifications/due` | 通知候補 |

### 7.3 書き込み

| メソッド | パス | 用途 | 重複防止 |
|---|---|---|---|
| POST | `/api/agent/medications` | 薬の登録 | 同名可 |
| PATCH | `/api/agent/medications/:id` | 薬の更新 | — |
| DELETE | `/api/agent/medications/:id` | 服用予定の停止（論理削除） | 冪等 |
| PUT | `/api/agent/medications/:id/schedules` | 予定の置換 | 置換 |
| POST | `/api/agent/medications/:id/purchases` | 購入追加 | **なし** |
| POST | `/api/agent/medications/:id/adjustments` | 残数補正 | **なし** |
| POST | `/api/agent/doses` | 予定外の服薬 | **なし** |
| POST | `/api/agent/doses/:id/take` | 服用 | あり（同じイベント） |
| POST | `/api/agent/doses/:id/skip` | スキップ | あり（同じイベント） |
| POST | `/api/agent/doses/:id/undo` | 取消 | 冪等 |

### 7.4 主な入力制約

| 項目 | 制約 |
|---|---|
| 日付 | `YYYY-MM-DD`（実在する日付） |
| 時刻 | `HH:MM`（00:00〜23:59） |
| 日時 | `YYYY-MM-DDTHH:mm` |
| 秒つき日時 | `YYYY-MM-DDTHH:mm:ss` |
| `days` | 月〜日の 7 文字（`1`=服用）、または 0=月〜6=日の配列 |
| `dose_quantity` | 0.01〜100000 |
| `schedule.quantity` | 0.01〜100000 |
| `purchase.quantity` | 0.01〜100000 |
| `adjustment.delta` | -100000〜100000、0 不可 |
| `low_stock_days` | 0〜3650 の整数 |
| `note`（薬） | 最大 1000 文字 |
| `note` / `reason`（記録） | 最大 500 文字 |
| 予定数 | 最大 24 件、同時刻の重複不可 |
| リクエストボディ | 最大 1MB |

### 7.5 エラー対応

| コード | 意味 | Hermes の対応 |
|---|---|---|
| `400` | 入力不正 | リクエストを修正する。盲目的に再送しない |
| `401` | 認証失敗 | トークン設定を確認。値は表示しない |
| `404` | 薬・予定・パスがない | ID を再取得する |
| `409` | 状態の競合 | 最新状態を取得。`undo` はユーザー確認後のみ |
| `413` | ボディが大きすぎる | ボディを小さくする |
| `500` | サーバー内部エラー | 変更系は再送前に状態を確認する |

### 7.6 変更系リクエストの再送原則

- `take` / `skip` / `undo` / `DELETE` は同じ対象に対する再送が比較的安全です。ただし結果を必ず確認する。
- `POST /doses` / `purchases` / `adjustments` / `POST /medications` は再送すると二重作成・二重加算のおそれがあります。通信エラー時はまず `summary` / `medications` / `history` を読み、反映済みか確認する。
- 反映済みなら再送しない。未反映と確認できた場合だけ、ユーザーに確認して再送する。

---

## 8. 秘密情報・プライバシー

- `HERMES_TOKEN` は秘密情報。`echo`、`set -x`、`curl -v`、デバッグログに出さない。
- トークンを URL クエリ・通知本文・チャット・Issue・コミット・スクリーンショットに含めない。
- 漏えいが疑われる場合は、ユーザーにトークンの変更とサーバー再起動を依頼する。旧トークンは即時無効になる。
- `data/app.db` には薬名・服薬履歴などの健康情報が含まれる。バックアップやログを外部サービスへ無断で送らない。
- 外部通知（Telegram など）へ送るのは、ユーザーが設定した通知先と必要最小限の内容だけにする。
- UI 用 `/api/*` は認証なし。Hermes が UI 用 API を使って書き込みを行わない。
- アプリをインターネットへ直接公開しない。必要ならリバースプロキシで HTTPS と認証を設定する。

---

## 9. 既知の制限（Hermes が考慮すること）

- 単一ユーザー向け。ログイン・権限分離はない。
- UI 用 API は認証なし。
- レート制限・監査ログはない。
- `POST /doses`・購入・残数補正に重複防止はない。
- 通知は at-most-once。配信失敗時の再送 API はない。
- ブラウザ通知は画面を開いている間だけ。閉じている間は Hermes のポーリングに依存。
- 薬の無効一覧を取得する API はない（個別 ID 取得のみ）。
- データのエクスポート / インポート API はない。
- 薬の相互作用・副作用チェックはない。医療判断をしない。
- 複数端末の同時編集の競合防止はない。
- タイムゾーンは固定オフセット（既定 日本時間 540 分）。日時はアプリの `now` / `today` を基準にする。
- 履歴 API は最大 365 日。
- 残数はマイナスになり得る。

---

## 10. 操作後の報告テンプレート

変更を行った場合は、以下を簡潔に報告します。

```text
記録しました。
- 薬: <medication_name>
- 予定: <scheduled_for>
- 状態: 服用 / スキップ / 取消
- 数量: <quantity><unit>
- 残数: <stock><unit>（残り約<days_left>日分）
- 在庫アラート: あり / なし
```

注意:

- `already: true` の場合は「すでに記録済みで、在庫は変わりません」と伝える。
- エラーの場合は「変更されていない」と断言できない限り、状態を再確認してから報告する。
- 服薬の判断を求められた場合は、アプリの記録と通知の範囲で答え、医療判断は行わない。
