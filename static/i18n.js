(() => {
  const STORAGE_KEY = "guts-language";
  const LANGUAGES = ["ja", "zh", "en"];
  const INDEX = { zh: 1, en: 2 };

  // [日本語, 中文, English]. English section names follow the internal module names.
  const ENTRIES = [
    ["車両配置ボード", "车辆配置看板", "Fleet Board"],
    ["Guts 車両配置ボード", "Guts 车辆配置看板", "Guts Fleet Board"],
    ["ユーザー名", "用户名", "Username"],
    ["パスワード", "密码", "Password"],
    ["ログイン", "登录", "Log in"],
    ["ログアウト", "退出登录", "Log out"],
    ["接続中", "已连接", "Connected"],
    ["再接続中", "重新连接中", "Reconnecting"],
    ["車両配置", "车辆配置", "Fleet Overview"],
    ["＋ 位置を管理", "＋ 管理位置", "＋ Parking Locations"],
    ["＋ 車両を追加", "＋ 添加车辆", "＋ Add Vehicle"],
    ["＋ 加盟店管理", "＋ 加盟店管理", "＋ Franchise Accounts"],
    ["＋ ジョブ管理", "＋ 任务管理", "＋ Dispatch Settings"],
    ["登録車両", "登记车辆", "Vehicles"],
    ["配置エリア", "配置区域", "Areas"],
    ["要対応", "需处理", "Needs follow-up"],
    ["車両の概要", "车辆概要", "Fleet summary"],
    ["ステータス別の車両", "按状态查看车辆", "Follow-up"],
    ["ジョブ", "任务", "Dispatch"],
    ["点検", "点检", "Inspections"],
    ["タスク", "待办", "Tasks"],
    ["タスク管理", "待办管理", "Task Manager"],
    ["＋ タスク管理", "＋ 管理待办", "＋ Manage Tasks"],
    ["すべて", "全部", "All"],
    ["車両ステータスで絞り込み", "按车辆状态筛选", "Filter by status"],
    ["駐車場・貸出場所", "停车场・出租地点", "Parking locations"],
    ["車両一覧", "车辆一览", "Vehicle List"],
    ["車番で検索", "按车号搜索", "Search by plate"],
    ["車種で絞り込み", "按车型筛选", "Filter by class"],
    ["閉じる", "关闭", "Close"],
    ["車両を追加", "添加车辆", "Add Vehicle"],
    ["車両情報を編集", "编辑车辆信息", "Edit Vehicle"],
    ["ナンバー", "车牌号", "Plate"],
    ["例: 品川 500 あ 1234", "例：品川 500 あ 1234", "e.g. Shinagawa 500 A 1234"],
    ["クラス", "级别", "Class"],
    ["追加した車両は一番上の位置に登録されます。", "添加的车辆会登记在最上方的位置。", "New vehicles are placed in the top location."],
    ["オプション", "选项", "Options"],
    ["オプションを追加・削除", "添加/删除选项", "Add / remove options"],
    ["対応ステータス", "处理状态", "Follow-up Status"],
    ["ステータスを追加・削除", "添加/删除状态", "Add / remove statuses"],
    ["車両状態評価シート", "车辆状态评估表", "Vehicle Check"],
    ["車検", "车检", "Vehicle Inspection"],
    ["車検満了日", "车检到期日", "Inspection Expiry Date"],
    ["法定点検日", "法定检查日", "Statutory Inspection Date"],
    ["評価項目・損傷種類を管理", "管理评估项目・损伤种类", "Manage check items & damage types"],
    ["備考欄", "备注栏", "Notes"],
    ["車両について共有したいことを記録できます。", "可记录想共享的车辆信息。", "Record anything worth sharing about this vehicle."],
    ["車体の損傷位置", "车身损伤位置", "Damage Inspection"],
    ["ドラッグで360度回転できる3D車両モデル", "可拖动360°旋转的3D车辆模型", "3D vehicle model, drag to rotate 360°"],
    ["3D車両モデルを読み込み中…", "正在加载3D车辆模型…", "Loading 3D vehicle model…"],
    ["車体をドラッグして回転 · 傷・凹みのアイコンを車体へドラッグして記録", "拖动车身旋转 · 将划痕/凹陷图标拖到车身上记录", "Drag to rotate · drag a scratch/dent icon onto the body to record"],
    ["指またはマウスで回転できる3D車両モデル", "可用手指或鼠标旋转的3D车辆模型", "3D vehicle model, rotate with finger or mouse"],
    ["車両を削除", "删除车辆", "Delete Vehicle"],
    ["キャンセル", "取消", "Cancel"],
    ["保存", "保存", "Save"],
    ["評価シートを管理", "管理评估表", "Vehicle Check Settings"],
    ["日付は各車両の追加・編集画面にある「車検」欄から入力します。", "请在各车辆的添加/编辑页面中的“车检”栏目填写日期。", "Enter dates in the Vehicle Inspection section when adding or editing a vehicle."],
    ["評価項目", "评估项目", "Check Items"],
    ["項目名", "项目名称", "Item name"],
    ["例：ガラスの状態", "例：玻璃状态", "e.g. Glass condition"],
    ["入力形式", "输入形式", "Input type"],
    ["1〜5 評価", "1〜5 评分", "1–5 rating"],
    ["チェック", "勾选", "Checkbox"],
    ["テキスト", "文本", "Text"],
    ["数値", "数值", "Number"],
    ["単位（任意）", "单位（可选）", "Unit (optional)"],
    ["km など", "如 km", "e.g. km"],
    ["項目を追加", "添加项目", "Add item"],
    ["損傷・問題の種類", "损伤・问题种类", "Damage & Issue Types"],
    ["問題の名前", "问题名称", "Issue name"],
    ["例：ガラス割れ", "例：玻璃破裂", "e.g. Cracked glass"],
    ["アイコン", "图标", "Icon"],
    ["色", "颜色", "Color"],
    ["問題マーカーの色", "问题标记颜色", "Issue marker color"],
    ["問題種類を追加", "添加问题种类", "Add issue type"],
    ["対応ステータスを管理", "管理处理状态", "Follow-up Settings"],
    ["新しいステータス名", "新状态名称", "New status name"],
    ["例：書類確認待ち", "例：等待确认文件", "e.g. Awaiting documents"],
    ["アイコン（任意）", "图标（可选）", "Icon (optional)"],
    ["ジョブ管理", "任务管理", "Dispatch Settings"],
    ["日時", "日期时间", "Date & time"],
    ["貼り付け用可", "可粘贴", "paste OK"],
    ["カレンダーから選択", "从日历选择", "Pick from calendar"],
    ["車両ナンバー", "车辆车牌", "Vehicle plate"],
    ["現在位置", "当前位置", "Current location"],
    ["送り先", "送往", "Destination"],
    ["ジョブを追加", "添加任务", "Add job"],
    ["日付", "日期", "Date"],
    ["作業内容", "工作内容", "Task details"],
    ["例：第4駐車場の車両をすべて移動する", "例：移走第4停车场的所有车辆", "e.g. Move all vehicles from parking lot 4"],
    ["タスクを追加", "添加待办", "Add task"],
    ["オプションを管理", "管理选项", "Vehicle Options"],
    ["新しいオプション名", "新选项名称", "New option name"],
    ["例：ドラレコ", "例：行车记录仪", "e.g. Dashcam"],
    ["位置を管理", "管理位置", "Parking Locations"],
    ["新しい位置名", "新位置名称", "New location name"],
    ["位置名", "位置名称", "Location name"],
    ["ナビリンク（任意）", "导航链接（可选）", "Navigation link (optional)"],
    ["位置を追加", "添加位置", "Add location"],
    ["加盟店管理", "加盟店管理", "Franchise Accounts"],
    ["加盟店名", "加盟店名称", "Franchise name"],
    ["例：〇〇店", "例：〇〇店", "e.g. Store name"],
    ["管理者ユーザー名", "管理员用户名", "Admin username"],
    ["初期パスワード（12文字以上）", "初始密码（12位以上）", "Initial password (12+ chars)"],
    ["加盟店とアカウントを作成", "创建加盟店和账号", "Create franchise & account"],
    ["サーバーに接続できません。VPSのアプリ稼働状態、HTTPS、リバースプロキシの設定を確認してください。", "无法连接服务器。请检查VPS上的应用运行状态、HTTPS和反向代理设置。", "Cannot reach the server. Check the app status, HTTPS and reverse proxy on the VPS."],
    ["この加盟店アカウントは一時停止中です。総本店へお問い合わせください。", "该加盟店账号已被暂停，请联系总店。", "This franchise account is suspended. Please contact headquarters."],
    ["この加盟店アカウントは削除されました。総本店へお問い合わせください。", "该加盟店账号已被删除，请联系总店。", "This franchise account was deleted. Please contact headquarters."],
    ["エリアカードをドラッグして並べ替え", "拖动区域卡片以排序", "Drag the area card to reorder"],
    ["Googleマップでナビを開く", "用谷歌地图打开导航", "Open navigation in Google Maps"],
    ["サイズ調整", "调整大小", "Resize"],
    ["クリック後、右下のハンドルをドラッグしてサイズを調整", "点击后拖动右下角手柄调整大小", "Click, then drag the bottom-right handle to resize"],
    ["左へ移動", "左移", "Move left"],
    ["右へ移動", "右移", "Move right"],
    ["完了", "完成", "Done"],
    ["描画終了", "结束绘制", "Finish drawing"],
    ["直線を引く", "画直线", "Draw line"],
    ["線の色", "线条颜色", "Line color"],
    ["取り消し", "撤销", "Undo"],
    ["保存済みの最後の線を削除して保存します", "删除并保存最后一条已存线条", "Remove the last saved line"],
    ["位置内をドラッグして直線を引きます。線は指を離すと自動保存されます。", "在位置内拖动画直线，松手后自动保存。", "Drag inside the area to draw a line. It saves automatically on release."],
    ["線を描くと自動保存されます。取り消しで最後の線を削除できます。", "画线后自动保存，可用撤销删除最后一条。", "Lines save automatically. Use Undo to remove the last one."],
    ["ドラッグして幅と高さを調整", "拖动调整宽度和高度", "Drag to adjust width and height"],
    ["該当する車両はありません。", "没有符合条件的车辆。", "No matching vehicles."],
    ["登録車両はありません。「車両を追加」から登録してください。", "暂无登记车辆，请通过「添加车辆」登记。", "No vehicles yet. Add one with \"Add Vehicle\"."],
    ["対応ステータスはありません。", "没有处理状态。", "No statuses."],
    ["オプションはありません。", "没有选项。", "No options."],
    ["削除", "删除", "Delete"],
    ["このジョブを削除しますか？", "要删除这个任务吗？", "Delete this job?"],
    ["この車両を削除しますか？", "要删除这辆车吗？", "Delete this vehicle?"],
    ["ジョブはありません。", "没有任务。", "No jobs."],
    ["タスクはありません。", "没有待办事项。", "No tasks."],
    ["車検・点検予定はありません。", "没有车检・检查安排。", "No vehicle inspections due soon."],
    ["このタスクを削除しますか？", "要删除此待办事项吗？", "Delete this task?"],
    ["候補から車両を選択してください。", "请从候选中选择车辆。", "Please choose a vehicle from the suggestions."],
    ["外装・内装系", "外观・内饰", "Exterior & Interior"],
    ["車検証・電装系", "车检证・电装", "Inspection & Electrical"],
    ["基本情報", "基本信息", "Basic Info"],
    ["追加項目", "附加项目", "Additional Items"],
    ["評価項目はありません。「評価項目・損傷種類を管理」から追加できます。", "没有评估项目，可通过「管理评估项目・损伤种类」添加。", "No check items. Add them from \"Manage check items & damage types\"."],
    ["問題種類はありません。「評価項目・損傷種類を管理」から追加できます。", "没有问题种类，可通过「管理评估项目・损伤种类」添加。", "No issue types. Add them from \"Manage check items & damage types\"."],
    ["先に問題種類を追加してください。", "请先添加问题种类。", "Add an issue type first."],
    ["傷または凹みのアイコンを押したまま、3D車体の表面までドラッグしてください。", "按住划痕或凹陷图标，拖到3D车身表面。", "Press and hold a scratch or dent icon and drag it onto the 3D body."],
    ["3D車体の表面まで損傷アイコンをドラッグしてください。", "请将损伤图标拖到3D车身表面。", "Drag the damage icon onto the 3D body."],
    ["損傷位置を記録しました。車両の保存時に一緒に保存されます。", "已记录损伤位置，保存车辆时一并保存。", "Damage position recorded. It is saved with the vehicle."],
    ["損傷位置を記録するには車体表面までアイコンをドラッグしてください。", "要记录损伤位置，请将图标拖到车身表面。", "Drag the icon onto the vehicle body to record damage."],
    ["未登録", "未登记", "None"],
    ["利用中", "使用中", "Active"],
    ["利用停止中", "已停用", "Suspended"],
    ["利用停止", "停用", "Suspend"],
    ["利用再開", "恢复使用", "Restore"],
    ["加盟店を削除", "删除加盟店", "Delete franchise"],
    ["完全に削除", "永久删除", "Delete permanently"],
    ["削除する加盟店名", "要删除的加盟店名称", "Franchise name to delete"],
    ["加盟店名が一致しません。", "加盟店名称不一致。", "Franchise name does not match."],
    ["加盟店はまだ登録されていません。", "尚未登记加盟店。", "No franchises yet."],
    ["Googleマップのナビリンク（任意）", "谷歌地图导航链接（可选）", "Google Maps link (optional)"],
    ["車両が配置されている位置は削除できません", "有车辆的位置无法删除", "Locations holding vehicles cannot be deleted"],
    // Built-in data names
    ["本店貸出中", "本店出租中", "Rented (Main)"],
    ["駅前店貸出中", "站前店出租中", "Rented (Station)"],
    ["予備", "备用", "Spare"],
    ["立駐", "立体停车", "Tower"],
    ["その他", "其他", "Other"],
    ["B軽トラ", "B轻型卡车", "B Kei truck"],
    ["車載器", "车载器", "On-board unit"],
    ["禁煙", "禁烟", "Non-smoking"],
    ["喫煙", "吸烟", "Smoking"],
    ["ナビ", "导航", "Navigation"],
    ["スタッドレス", "雪地胎", "Studless tires"],
    ["洗車待ち", "待洗车", "Needs washing"],
    ["給油待ち", "待加油", "Needs fuel"],
    ["要修理", "需维修", "Needs repair"],
    ["外装（ボディ・塗装・鈑金）", "外观（车身・涂装・钣金）", "Exterior (body, paint, panels)"],
    ["内装（シート・天井・フロア）", "内饰（座椅・车顶・地板）", "Interior (seats, roof, floor)"],
    ["ホイール", "轮毂", "Wheels"],
    ["車検証", "车检证", "Registration"],
    ["確認済み", "已确认", "Verified"],
    ["ラジオ", "收音机", "Radio"],
    ["ナビ（５年以内）", "导航（5年内）", "Navigation (within 5 yrs)"],
    ["エアコン", "空调", "Air conditioning"],
    ["サイドミラー調整", "后视镜调整", "Side mirror adjusted"],
    ["走行距離", "行驶里程", "Mileage"],
    ["初年度登録（年）", "首次登记（年）", "First registration (year)"],
    ["初年度登録（月）", "首次登记（月）", "First registration (month)"],
    ["年", "年", "yr"],
    ["月", "月", "mo"],
    ["傷", "划痕", "Scratch"],
    ["凹み", "凹陷", "Dent"],
    // Server messages
    ["オプションが見つかりません。", "找不到该选项。", "Option not found."],
    ["オプション名は1〜40文字で入力してください。", "选项名称请输入1〜40个字符。", "Option name must be 1–40 characters."],
    ["ジョブが見つかりません。", "找不到该任务。", "Job not found."],
    ["ジョブの状態が正しくありません。", "任务状态不正确。", "Invalid job state."],
    ["タスクの日付と内容（1〜1000文字）を入力してください。", "请输入待办日期和内容（1〜1000个字符）。", "Enter a task date and details (1–1000 characters)."],
    ["タスクの状態が正しくありません。", "待办状态不正确。", "Invalid task state."],
    ["タスクが見つかりません。", "找不到待办事项。", "Task not found."],
    ["車検・点検日は有効な日付を指定してください。", "请指定有效的车检/点检日期。", "Enter a valid vehicle inspection date."],
    ["車検・点検の状態が正しくありません。", "车检/点检状态不正确。", "Invalid vehicle inspection state."],
    ["車検・点検日が変更されています。最新情報を再読み込みしてください。", "车检/点检日期已更改，请重新加载最新信息。", "The inspection date changed. Reload the latest data."],
    ["ステータスが見つかりません。", "找不到该状态。", "Status not found."],
    ["ステータス名は1〜40文字、アイコンは8文字以内で入力してください。", "状态名称请输入1〜40个字符，图标不超过8个字符。", "Status name must be 1–40 characters and the icon at most 8."],
    ["車両が配置されている位置は削除できません。先に車両を別の位置へ移動してください。", "有车辆的位置无法删除，请先把车辆移到其他位置。", "A location holding vehicles cannot be deleted. Move the vehicles first."],
    ["車両または送り先が見つかりません。", "找不到车辆或送达地点。", "Vehicle or destination not found."],
    ["車両評価の内容が正しくありません。", "车辆评估内容不正确。", "Invalid vehicle assessment."],
    ["車両評価または車体マークの内容が正しくありません。", "车辆评估或车身标记内容不正确。", "Invalid vehicle assessment or body marks."],
    ["車体マークの内容が正しくありません。", "车身标记内容不正确。", "Invalid body marks."],
    ["店舗名・アカウント名は1〜80文字、パスワードは12〜1024文字で入力してください。", "店铺名・账号名请输入1〜80个字符，密码12〜1024个字符。", "Store/account names must be 1–80 characters and the password 12–1024."],
    ["店舗名またはアカウント名は既に使用されています。", "店铺名或账号名已被使用。", "The store or account name is already in use."],
    ["加盟店が見つかりません。", "找不到该加盟店。", "Franchise not found."],
    ["評価項目が見つかりません。", "找不到该评估项目。", "Check item not found."],
    ["日時・車両・送り先を正しく入力してください。", "请正确填写日期时间・车辆・送达地点。", "Enter a valid date/time, vehicle and destination."],
    ["同じ名前のオプションは既に登録されています。", "已存在同名选项。", "An option with that name already exists."],
    ["同じ名前のステータスは既に登録されています。", "已存在同名状态。", "A status with that name already exists."],
    ["同じ名前の評価項目は既に登録されています。", "已存在同名评估项目。", "A check item with that name already exists."],
    ["同じ名前の問題種類は既に登録されています。", "已存在同名问题种类。", "An issue type with that name already exists."],
    ["問題の名前・アイコン・色を正しく指定してください。", "请正确指定问题名称・图标・颜色。", "Specify a valid issue name, icon and color."],
    ["問題種類が見つかりません。", "找不到该问题种类。", "Issue type not found."],
    ["線は最大100本までで、色と座標を正しく指定してください。", "线条最多100条，请正确指定颜色和坐标。", "Up to 100 lines; specify valid colors and coordinates."],
    ["項目名・入力形式・単位を正しく指定してください。", "请正确指定项目名称・输入形式・单位。", "Specify a valid item name, input type and unit."],
    ["削除するには加盟店名を正確に入力してください。", "删除前请准确输入加盟店名称。", "Enter the exact franchise name to delete it."],
    ["有効・停止の状態を指定してください。", "请指定启用/停用状态。", "Specify an active or suspended state."],
    ["最後の位置は削除できません。", "最后一个位置无法删除。", "The last location cannot be deleted."],
  ];

  // Patterns with user data. Templates are strings ($1…) or functions.
  const PATTERNS = [
    [/^Guts 車両配置ボード v(.+)$/, "Guts 车辆配置看板 v$1", "Guts Fleet Board v$1"],
    [/^(\d+) 台$/, "$1 台", "$1 vehicles"],
    [/^未完了 (\d+) \/ 全(\d+)件$/, "未完成 $1 / 共$2项", "Open $1 / $2 total"],
    [/^(\d)点$/, "$1分", "$1 pts"],
    [/^追加した車両は「(.+)」に登録されます。$/, "添加的车辆会登记在「$1」。", "New vehicles are placed in \"$1\"."],
    [/^(.+)のGoogleマップナビを開く$/, "打开$1的谷歌地图导航", "Open Google Maps navigation for $1"],
    [/^(.+)のGoogleマップナビリンク$/, "$1的谷歌地图导航链接", "Google Maps link for $1"],
    [/^(.+)の位置名$/, "$1的位置名称", "Name of $1"],
    [/^(.+)の線$/, "$1的线条", "Lines of $1"],
    [/^(.+)のサイズをドラッグして調整$/, "拖动调整$1的大小", "Drag to resize $1"],
    [/^(.+)の評価$/, "$1的评分", "Rating for $1"],
    [/^(.+)の損傷マークを削除$/, "删除$1的损伤标记", "Delete $1 damage mark"],
    [/^(.*) 線はサーバーに保存されていません。$/, (m, translate) => `${translate(m[1])} ${translate("__line-not-saved__")}`, null],
    [/^オプション「(.+)」を削除しますか？登録済み車両からも解除されます。$/, "要删除选项「$1」吗？已登记车辆上的该选项也会被解除。", "Delete option \"$1\"? It is also removed from registered vehicles."],
    [/^ステータス「(.+)」を削除しますか？登録済み車両からも解除されます。$/, "要删除状态「$1」吗？已登记车辆上的该状态也会被解除。", "Delete status \"$1\"? It is also removed from registered vehicles."],
    [/^位置「(.+)」を削除しますか？$/, "要删除位置「$1」吗？", "Delete location \"$1\"?"],
    [/^(.+)を削除しますか？保存済み評価からも削除されます。$/, "要删除$1吗？已保存的评估中也会删除。", "Delete $1? It is also removed from saved assessments."],
    [/^(.+)を削除しますか？記録済みの車体マークも削除されます。$/, "要删除$1吗？已记录的车身标记也会删除。", "Delete $1? Recorded body marks are also removed."],
    [/^管理者：(.+)$/, "管理员：$1", "Admin: $1"],
    [/^全アカウント・車両・位置を削除します。続行するには「(.+)」を入力してください。$/, "将删除所有账号・车辆・位置。要继续请输入「$1」。", "This deletes all accounts, vehicles and locations. Type \"$1\" to continue."],
    [/^(.+)を車体表面までドラッグして記録してください。$/, "请将$1拖到车身表面记录。", "Drag $1 onto the body surface to record it."],
    [/^(.+)：アイコンを車体図までドラッグして記録$/, "$1：将图标拖到车身图上记录", "$1: drag the icon onto the body to record"],
    [/^(.+)の位置を記録しました。車両の保存時に一緒に保存されます。$/, "已记录$1的位置，保存车辆时一并保存。", "Recorded the position of $1. It is saved with the vehicle."],
  ];
  const LINE_NOT_SAVED = ["线条未保存到服务器。", "The line was not saved to the server."];

  // Built-in names that also appear inside composed strings such as "駐車場 1 · H-2".
  const WORDS = [
    [/駐車場 (\d+)/g, "停车场 $1", "Lot $1"],
    [/駅前店貸出中/g, "站前店出租中", "Rented (Station)"],
    [/本店貸出中/g, "本店出租中", "Rented (Main)"],
    [/予備/g, "备用", "Spare"],
    [/立駐/g, "立体停车", "Tower"],
    [/未配置/g, "未配置", "Unassigned"],
  ];

  const exact = new Map(ENTRIES.map((entry) => [entry[0], entry]));
  const originals = new WeakMap();
  const applied = new WeakMap();
  const attributeState = new WeakMap();
  const ATTRIBUTES = ["placeholder", "title", "aria-label"];
  let language = "ja";

  function translateCore(core, lang) {
    const index = INDEX[lang];
    if (core === "__line-not-saved__") return LINE_NOT_SAVED[index - 1];
    const entry = exact.get(core);
    if (entry) return entry[index];
    for (const pattern of PATTERNS) {
      const match = core.match(pattern[0]);
      if (!match) continue;
      const template = pattern[index];
      return typeof pattern[1] === "function"
        ? pattern[1](match, (text) => translateCore(text, lang))
        : core.replace(pattern[0], template);
    }
    let output = core;
    for (const word of WORDS) output = output.replace(word[0], word[index]);
    return output;
  }

  function translate(text, lang = language) {
    if (lang === "ja" || typeof text !== "string") return text;
    const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!match[2]) return text;
    return match[1] + translateCore(match[2], lang) + match[3];
  }

  function processText(node) {
    const parent = node.parentElement;
    if (parent && (parent.tagName === "SCRIPT" || parent.tagName === "STYLE")) return;
    const base = applied.has(node) && applied.get(node) === node.data ? originals.get(node) : node.data;
    const output = translate(base);
    if (output === base) {
      applied.delete(node);
      originals.delete(node);
    } else {
      originals.set(node, base);
      applied.set(node, output);
    }
    if (output !== node.data) node.data = output;
  }

  function processAttributes(element) {
    let state = attributeState.get(element);
    for (const name of ATTRIBUTES) {
      const current = element.getAttribute(name);
      if (current === null) continue;
      if (!state) {
        state = {};
        attributeState.set(element, state);
      }
      const record = state[name];
      const base = record && record.applied === current ? record.original : current;
      const output = translate(base);
      if (output === base) {
        delete state[name];
      } else {
        state[name] = { original: base, applied: output };
      }
      if (output !== current) element.setAttribute(name, output);
    }
  }

  function processTree(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      processText(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) processAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) processText(node);
      else processAttributes(node);
      node = walker.nextNode();
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") processText(record.target);
      else if (record.type === "attributes") processAttributes(record.target);
      else record.addedNodes.forEach(processTree);
    }
  });

  function setLanguage(next) {
    language = LANGUAGES.includes(next) ? next : "ja";
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch (_error) {
      // Storage can be unavailable in private browsing; the choice then lasts for this page only.
    }
    document.documentElement.lang = language;
    document.querySelectorAll(".language-select").forEach((select) => {
      select.value = language;
    });
    processTree(document.documentElement);
  }

  function start() {
    let saved = "ja";
    try {
      saved = localStorage.getItem(STORAGE_KEY) || "ja";
    } catch (_error) {
      saved = "ja";
    }
    document.querySelectorAll(".language-select").forEach((select) => {
      select.addEventListener("change", () => setLanguage(select.value));
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRIBUTES,
    });
    setLanguage(saved);
  }

  const nativeConfirm = window.confirm.bind(window);
  window.confirm = (message) => nativeConfirm(translate(message));
  window.gutsI18n = { translate, setLanguage, get language() { return language; } };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
