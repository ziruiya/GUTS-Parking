# Guts 車両配置ボード

レンタカー会社向けの、ブラウザで使う車両共有ボードです。本店と加盟店ごとに、車両・駐車場・レイアウトが完全に分かれています。店舗アカウントは自店のデータだけを閲覧・操作できます。

- 技術構成: Node.js 24 / Express / SQLite（Debian 12 の VPS で 1 プロセス運用）
- 言語切り替え: 右上のセレクトで 日本語 / 中文 / English（ブラウザに保存。ユーザー入力データは翻訳されません）
- バージョン: ログイン画面とボード上部に表示（`package.json` と同期）

## 主な機能

### 車両配置
- 新規店舗には 13 か所を自動作成: 駐車場 1〜9、本店貸出中、駅前店貸出中、予備、立駐。
- 車両はクラスごとに色分けされ、ドラッグで移動できます（駐車場内の位置も保持）。変更は同じ店舗のログインユーザーへリアルタイム同期されます。
- 新規車両は、並び順が一番上の駐車場に入ります。
- 駐車場はサイズ変更・並べ替え・追加・名称変更・削除（空のもののみ）ができ、Google マップの HTTPS リンクも設定できます。
- 「直線を引く」で駐車場内に自由に線を引けます。線はサーバーに自動保存され、「取り消し」で最後の線を削除します。

### 車両情報・ステータス
- 車両の追加・編集で、クラス、オプション（ETC、ナビなど）、対応ステータス（洗車待ち、給油待ち、修理待ちなど）を設定できます。オプションとステータスは追加・削除が可能です。
- 「ステータス別の車両」「ジョブ」「点検」「タスク」は初期状態で折りたたまれています。「ステータス別の車両」は「対応ステータス」と同じ項目を自動で表示します。
- トークンの表示順: ステータス → 車番 → オプション。
- 「車両一覧」は車番で検索でき、クリックすると該当の駐車場へ移動して、車両アイコンが 2 回点滅します。

### 車両状態評価シート・損傷チェック
- 外装・内装・ホイールの 1〜5 評価、チェック項目、走行距離、初度登録年月、備考欄。管理者は評価項目を追加・削除できます。
- 車両ごとに「車検満了日」「法定点検日」を登録できます。期限の 30 日前から「点検」に表示され、全アカウントで完了チェックできます。チェック済み項目は当日中表示され、翌日 0 時以降は表示されません。同じ期限の完了状態は保存され、日付を更新すると新しい予定として扱われます。
- 3D 車両モデルを指やマウスで 360° 回転できます。傷・凹みのアイコンを 3D 上へドラッグして配置します（回転しても位置は維持）。

### ジョブ（配車タスク）
- 「ステータス別の車両」の下にある折りたたみ欄です。「＋ ジョブ管理」で追加します。
- 入力項目: 日時（手入力・貼り付け `2026/10/13 10:30`・カレンダー選択）、車番（数字を入力して候補から選択。クラスと現在地が自動表示）、送り先の駐車場。
- 日時の早い順に並びます。チェックを入れると薄くなり、下へ移動します。
- 完了済みジョブは毎日 0 時（既定 `Asia/Tokyo`、環境変数 `JOBS_TIMEZONE` で変更）に自動削除されます。未完了のジョブは手動で削除するまで残ります。

### タスク
- ボードの「タスク」から管理画面を開き、日付と自由入力の作業内容を登録できます。作成・完了チェックは全アカウントで利用できます。
- 完了チェックは当日中表示され、翌日 0 時以降に自動削除されます。未完了タスクは日付を過ぎても残ります。

### アカウント・加盟店管理
- パスワードは scrypt でハッシュ化。操作履歴（誰が何を動かしたか）は記録しません。
- 管理者: すべての操作。従業員アカウント: 車両の閲覧・移動・編集・追加、位置の管理、ジョブ・点検・タスクを利用できます。車両削除、管理パネル、設定管理は管理者のみです。
- 本店管理者は「＋ 加盟店管理」から加盟店と最初の管理者を作成できます。未払いの店舗は「利用停止」/「利用再開」、店名を入力して確認すれば完全削除もできます（元に戻せません）。支払いは手動管理です。
- スマートフォンでは駐車場が 1 列表示になります。

### バージョン管理（SemVer）
修正はパッチ、機能追加はマイナー、互換性を壊す変更はメジャーを上げます。`npm version patch|minor|major --no-git-tag-version` を使います。

## VPS へのデプロイ（Debian 12 + 宝塔パネル）

IP アドレスのみで、ドメインなしの例です。MySQL は不要で、SQLite ファイルを使います。アプリは `127.0.0.1:8000` だけで待ち受けるため、8000 番ポートは開放しないでください。

> 注意: 本番運用では HTTPS を使ってください。HTTP ではパスワードが平文で流れます。ドメインと証明書を用意するまでは、実データや本番パスワードを入れないでください。

### 1. 準備
1. VPS のファイアウォールで TCP 22、80、443 と、宝塔パネルのポート（自分の IP のみ）を開けます。
2. SSH でログインし、宝塔の公式 Debian 用インストールコマンドでパネルを導入します。
3. 宝塔のソフトストアで **Nginx** と **Node.js バージョンマネージャー** を入れ、Node.js **24.x** をインストールします。PM2 マネージャーは入れないでください（バージョンマネージャー付属の `pm2` を使います）。

### 2. コード取得と依存関係
以下は Node のパスが `/www/server/nodejs/v24.21.0`、実行ユーザーが `www` の例です。異なる場合は読み替えてください。

```bash
git clone https://github.com/chiyamahisayoshi/guts.git /www/wwwroot/rentalcar-app
mkdir -p /www/wwwroot/rentalcar-data/npm-cache
chown -R www:www /www/wwwroot/rentalcar-app /www/wwwroot/rentalcar-data
chmod 750 /www/wwwroot/rentalcar-data
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; cd /www/wwwroot/rentalcar-app && npm ci --omit=dev --cache /www/wwwroot/rentalcar-data/npm-cache'
```

`added ... packages` と表示され、`npm error` がなければ成功です。

### 3. 設定と管理者アカウント
次をまとめて実行すると、ランダムな秘密鍵つきの `.env` を作り、管理者作成の入力に進みます。`.env` や管理者パスワードは他人に渡さないでください。

```bash
cd /www/wwwroot/rentalcar-app
NODE=/www/server/nodejs/v24.21.0/bin/node
SECRET=$("$NODE" -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')
printf 'SESSION_SECRET=%s\nDATABASE_PATH=/www/wwwroot/rentalcar-data/rentalcar.db\nCOOKIE_SECURE=1\nERP_API_KEY=\n' "$SECRET" > .env
chown www:www .env
chmod 600 .env
su -s /bin/sh www -c 'cd /www/wwwroot/rentalcar-app && /www/server/nodejs/v24.21.0/bin/node app/create-admin.js'
```

パスワードは 12 文字以上です（入力中は表示されません）。追加の管理者は同じ最終コマンドで作れます。操作アカウントは次のコマンドで作成します。

```bash
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; cd /www/wwwroot/rentalcar-app && npm run create-operator'
```

### 4. PM2 で起動
```bash
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; export PM2_HOME=/www/wwwroot/rentalcar-data/.pm2; cd /www/wwwroot/rentalcar-app && pm2 start app/server.js --name rentalcar --interpreter /www/server/nodejs/v24.21.0/bin/node'
curl -I http://127.0.0.1:8000/
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; export PM2_HOME=/www/wwwroot/rentalcar-data/.pm2; pm2 save'
```

`HTTP/1.1 200 OK` が返れば起動成功です。VPS 再起動後に自動起動させるには、宝塔の「計画タスク」に、起動時に実行する Shell タスクとして次を登録します。

```bash
su -s /bin/sh www -c 'export PATH=/www/server/nodejs/v24.21.0/bin:$PATH; export PM2_HOME=/www/wwwroot/rentalcar-data/.pm2; pm2 resurrect'
```

プロセスは必ず 1 つにしてください（リアルタイム同期のため）。

### 5. HTTPS とリバースプロキシ
1. 宝塔の「サイト」でドメインのサイトを追加します（PHP なし、データベースなし、FTP なし）。
2. サイト設定の「SSL」で証明書を申請して有効にします。
3. 「リバースプロキシ」を追加します: 名前 `rentalcar`、ターゲット `http://127.0.0.1:8000`、送信ドメイン `$host`、キャッシュ オフ。
4. WebSocket の設定がなければ、設定ファイルの `location /` に次の 3 行があるか確認し、無ければ追加します。

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

`https://ドメイン/api/me` が `{"authenticated":false}` を返し、トップにログイン画面が出れば完了です。本番では `.env` の `COOKIE_SECURE=1` を維持してください。

### 更新（`rental update`）
初回のみ、root で次を実行してコマンドを登録します。

```bash
install -o root -g root -m 755 /www/wwwroot/rentalcar-app/scripts/rental-command /usr/local/bin/rental
```

以後の更新は宝塔のターミナルでこれだけです。

```bash
rental update
```

コードの状態確認、DB バックアップ、最新コードと依存関係の更新、再起動、動作確認までを自動で行います。失敗した場合は再起動を試み、バックアップは `/www/wwwroot/rentalcar-data/` に残ります。状態確認は `rental status` です。DB のスキーマ更新は起動時に自動で行われ、車両データは消えません。

### データベースとバックアップ
現在のアプリは SQLite 専用です。MariaDB 10.11.10 は Oracle MySQL とは別製品で、現状のコードでは利用できません。データアクセスが Node.js の同期 `node:sqlite` API に強く依存しており、セッションストア、起動時スキーマ作成・移行、トランザクションを含めて非同期 DB 層へ改修する必要があります。宝塔で MariaDB をインストールしてもアプリは接続せず、DB 設定だけ変えると起動しません。

**現在の最も簡単で安全な設定:** 宝塔のサイト追加画面では「データベースなし」を選び、MariaDB 10.11.10 を新たにインストールしたり、既存の DB や `.env` の `DATABASE_PATH` を変更したりせず、このまま SQLite を使ってください。既存の宝塔サイトも切替作業は不要です。DB ファイルは `/www/wwwroot/rentalcar-data/rentalcar.db` にあり、定期バックアップには `rental backup` を使って VPS 外にも保管してください。MariaDB 10.11.10 への切替は、対応版と SQLite からの移行処理を別環境で実装・検証してからにしてください。

DB は `/www/wwwroot/rentalcar-data/rentalcar.db` です。手動バックアップは宝塔のターミナルで `rental backup` を実行します（またはアプリディレクトリで `npm run backup-db`）。実行中の SQLite DB から整合性の取れたバックアップを作成し、整合性検査に合格したファイルだけを保存します。バックアップは元 DB と同じフォルダに `rentalcar.db.backup-日時.sqlite` として保存され、アクセス権は所有者のみ読み書き可能です。定期タスクではこのコマンドを実行し、バックアップを VPS の外にも保管してください。更新時の自動バックアップも引き続き行われます。

#### MariaDB へ切り替える場合に必要な作業
1. 実データに触れる前に `rental backup` を実行し、バックアップを VPS の外にも複製します。
2. Node.js の全 DB 呼び出しとセッションストアを MariaDB 対応の非同期実装へ置き換え、MariaDB 10.11.10 のスキーマ・マイグレーションを用意します。
3. SQLite から MariaDB への移行ツールを作り、ID、外部キー、JSON 文字列、日時、ユーザー認証、セッションを含めた件数・内容を照合します。
4. 別環境でテストと復元リハーサルを完了してから、メンテナンス時間を設けて本番切替します。移行完了までは SQLite を唯一の正本として維持します。

このリポジトリにはまだ MariaDB ドライバー、スキーマ、移行ツールはありません。MariaDB サーバーの新規作成や本番データのカットオーバーは実行していません。

管理者は「管理パネル」→「車両データをエクスポート」からテナント単位の JSON データパッケージをダウンロードできます。形式は `guts-parking-mariadb-export` version 1 で、車両、車検・法定点検日と完了記録、位置、状態、評価値、損傷マーク、オプション、ジョブ、タスク、クラス、店舗・距離設定とそれらの ID を含みます。ユーザー、パスワードハッシュ、ログインセッションは含みません。これは MariaDB 用の移行入力データであり、SQL ダンプではなく、そのまま MariaDB にインポートする機能はまだありません。将来の MariaDB 導入では、この形式を読み込む移行ツールを追加し、別環境で検証してください。

管理者は管理パネルから従業員アカウントを作成するときにユーザー名とパスワードを指定し、登録済み従業員の「パスワードを変更」から新しいパスワードを設定できます（12〜1024文字）。パスワードはハッシュ化して保存されるため、後から現在のパスワードを閲覧することはできません。パスワード変更時はその従業員の既存セッションを無効にします。従業員アカウントには管理パネルと設定管理の権限がありません。

### エラーログ
正常な操作は記録せず、エラーだけを `/www/wwwroot/rentalcar-data/errors.log` に残します（プログラム例外、ブラウザの JavaScript エラー、API の 5xx・通信失敗、損傷マーカーのドラッグ失敗など）。車両情報・ユーザー名・Cookie・IP は収集せず、機密値はマスクされます。5 MB を超えると自動でローテーションします（旧ファイル 3 つまで）。

```bash
tail -n 100 /www/wwwroot/rentalcar-data/errors.log
tail -f /www/wwwroot/rentalcar-data/errors.log
```

保存先は `.env` の `ERROR_LOG_PATH=/絶対パス/errors.log` で変更でき、変更後は再起動が必要です。

### よくあるトラブル
- **データベースの選択**: サイト作成時は「なし」を選びます（SQLite を使用）。
- **`node: command not found`**: フルパス `/www/server/nodejs/v24.21.0/bin/node` を使うか、PATH に追加します。
- **`sudo: command not found`**: `su -s /bin/sh www -c '...'` を使います。
- **`Cannot find module 'dotenv'`**: `npm ci --omit=dev` を成功させてから起動します。
- **npm キャッシュの `EACCES`**: root と `www` で npm を混用せず、上記のとおり `--cache` を指定します。
- **PM2 マネージャーとの競合**: Node バージョンマネージャー付属の `pm2` だけを使います。
- **`.env` の変数名に `\` が入る**: `SESSION_SECRET` のように書きます（`SESSION\_SECRET` は誤り）。上のコードをコピーすれば防げます。
- **`/api/me` は返るのにトップが真っ白**: 最新版に更新し、ブラウザのコンソールと `errors.log` を確認します。本番は HTTPS + `COOKIE_SECURE=1` が必須です（ローカル HTTP 開発のみ `0`）。

## ローカル開発・テスト

Node.js 24 以上が必要です。

```bash
npm ci
export SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')"
npm run create-admin
npm start
```

`http://127.0.0.1:8000` を開きます（開発時は `COOKIE_SECURE=0`）。テストは `npm test` です。Python は不要です。

## ERP 連携 API

詳細は [docs/ERP_INTEGRATION.md](docs/ERP_INTEGRATION.md) を参照してください（/api/v1/... でも呼べます）。

`.env` に `ERP_API_KEY` を設定すると、`POST /api/integration/vehicles:sync` が使えます。`X-ERP-API-Key` ヘッダーにキーを付け、JSON 配列（各要素に `external_id`、`plate`、`vehicle_type`、任意で `parking_lot_id`）を送ります。同じ `external_id` は基本情報だけを更新し、ボード上のステータスと位置は上書きしません。1 回最大 500 台で、キー未設定の場合は 503 を返します。現在は本店のみ対象です。キー変更後は PM2 で再起動してください。

## 構成と規模

単一プロセス + SQLite の構成は、1 台の VPS と約 250 台の車両に適しています。複数プロセスや複数サーバーに拡張する場合は、共有データベースとメッセージ基盤が必要です。

## ストアアプリ化の準備

PWA（ホーム画面に追加）に対応済みです。App Store / Google Play への公開手順と審査の注意点は [docs/MOBILE_APP.md](docs/MOBILE_APP.md) を参照してください。プライバシーポリシーのひな形は /static/privacy.html です（公開前に運営者情報を記入）。
