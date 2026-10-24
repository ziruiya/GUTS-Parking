(() => {
  const loginScreen = document.querySelector("#login-screen");
  const appScreen = document.querySelector("#app-screen");
  const loginForm = document.querySelector("#login-form");
  const loginError = document.querySelector("#login-error");
  const parkingGrid = document.querySelector("#parking-grid");
  const dialog = document.querySelector("#vehicle-dialog");
  const vehicleForm = document.querySelector("#vehicle-form");
  const formError = document.querySelector("#form-error");
  const locationDialog = document.querySelector("#location-dialog");
  const locationError = document.querySelector("#location-error");
  const franchiseDialog = document.querySelector("#franchise-dialog");
  const franchiseError = document.querySelector("#franchise-error");
  const employeeDialog = document.querySelector("#employee-dialog");
  const employeeError = document.querySelector("#employee-error");
  const statusDialog = document.querySelector("#status-dialog");
  const statusError = document.querySelector("#status-error");
  const assessmentManagerDialog = document.querySelector("#assessment-manager-dialog");
  const assessmentManagerError = document.querySelector("#assessment-manager-error");
  const classDialog = document.querySelector("#class-dialog");
  const classError = document.querySelector("#class-error");
  const logisticsDialog = document.querySelector("#logistics-dialog");
  const logisticsError = document.querySelector("#logistics-error");
  let lots = [];
  let vehicles = [];
  let vehicleTypes = [];
  let vehicleClasses = [];
  let stores = [];
  let lotDistances = [];
  let storeLotDistances = [];
  let vehicleOptions = [];
  let statuses = [];
  let jobs = [];
  let jobVehicleId = null;
  let assessmentFields = [];
  let damageTypes = [];
  let inspectionMarks = [];
  let selectedDamageTypeId = null;
  let inspectionIssueDrag = null;
  let suppressDamageClick = false;
  let inspectionReminders = [];
  let tasks = [];
  let canManage = false;
  let canManageLocations = false;
  let canManageFranchises = false;
  let activeVehicleType = "all";
  let activeStatus = "all";
  let socket;
  let dragged = null;
  let resizing = null;
  let editingLotId = null;
  let drawingLotId = null;
  let markingError = "";
  const markingColors = new Map();
  const markingSaveChains = new Map();
  const markingSaveRevisions = new Map();
  let suppressClick = false;

  function reportClientError(type, error, details = {}) {
    const message = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error ?? "Unknown error");
    const report = {
      type,
      message: message.slice(0, 2000),
      path: location.pathname,
      ...(error instanceof Error && error.stack ? { stack: error.stack.slice(0, 8000) } : {}),
      ...(details.source ? { source: String(details.source).slice(0, 1000) } : {}),
      ...(details.status ? { status: details.status } : {}),
      ...(details.line ? { line: details.line } : {}),
      ...(details.column ? { column: details.column } : {}),
    };
    fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    }).then((response) => {
      if (!response.ok) console.error("Could not submit browser error report:", response.status);
    }).catch((reportingError) => {
      console.error("Could not submit browser error report:", reportingError);
    });
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      });
    } catch (error) {
      reportClientError("network-error", error, { source: path });
      const failure = new Error(
        "サーバーに接続できません。VPSのアプリ稼働状態、HTTPS、リバースプロキシの設定を確認してください。",
        { cause: error },
      );
      failure.clientErrorReported = true;
      throw failure;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status >= 500) {
        reportClientError("server-response", body.detail || `HTTP ${response.status}`, {
          source: path,
          status: response.status,
        });
      }
      if (response.status === 401 && path !== "/api/login") showLogin();
      if (response.status === 403 &&
          body.detail === "この加盟店アカウントは一時停止中です。総本店へお問い合わせください。") {
        loginError.textContent = body.detail;
        showLogin();
      }
      const failure = new Error(body.detail || `Request failed (${response.status})`);
      failure.httpStatus = response.status;
      throw failure;
    }
    return response.status === 204 ? null : response.json();
  }

  function showLogin() {
    appScreen.hidden = true;
    loginScreen.hidden = false;
    if (socket) socket.close();
  }

  function showBoard(username, userCanManage, userCanManageFranchises, tenantName) {
    loginScreen.hidden = true;
    appScreen.hidden = false;
    canManage = userCanManage;
    canManageLocations = true;
    canManageFranchises = userCanManageFranchises;
    document.querySelector("#current-user").textContent = `${tenantName} · ${username}`;
    document.querySelector("#manage-locations-button").hidden = !canManageLocations;
    document.querySelector("#admin-panel-button").hidden = !canManage;
    document.querySelector("#add-vehicle-button").hidden = false;
    document.querySelector("#manage-franchises-button").hidden = !canManageFranchises;
    connectSocket();
    loadBoard().catch(showError);
  }

  function setAppVersion(version) {
    if (!/^\d+\.\d+\.\d+$/.test(version || "")) return;
    document.querySelectorAll("[data-app-version]").forEach((element) => {
      element.textContent = `v${version}`;
    });
    document.title = `Guts 車両配置ボード v${version}`;
  }

  function showError(error) {
    if (!error?.clientErrorReported && !error?.httpStatus) {
      reportClientError("browser-error", error);
    }
    console.error(error);
    formError.textContent = error.message;
  }

  async function loadBoard() {
    if (dragged || resizing || draftMarking) return;
    const data = await api("/api/bootstrap");
    lots = data.parking_lots;
    vehicles = data.vehicles;
    vehicleTypes = data.vehicle_types;
    vehicleClasses = data.vehicle_classes || [];
    stores = data.stores || [];
    lotDistances = data.lot_distances || [];
    storeLotDistances = data.store_lot_distances || [];
    vehicleOptions = data.vehicle_options || [];
    statuses = data.statuses || [];
    jobs = data.jobs || [];
    tasks = data.tasks || [];
    inspectionReminders = data.inspection_reminders || [];
    assessmentFields = data.assessment_fields || [];
    damageTypes = data.damage_types || [];
    const availableDamageTypeIds = new Set(damageTypes.map((type) => type.id));
    inspectionMarks = inspectionMarks.filter((mark) => availableDamageTypeIds.has(mark.damage_type_id));
    if (!availableDamageTypeIds.has(selectedDamageTypeId)) selectedDamageTypeId = null;
    if (activeStatus !== "all" && !statuses.some((status) => String(status.id) === activeStatus)) {
      activeStatus = "all";
    }
    populateVehicleTypeChoices();
    render();
    if (statusDialog.open) renderStatusManager();
    if (classDialog.open) renderClassManager();
  }

  function classColor(type) {
    return vehicleClasses.find((item) => item.name === type)?.color || "#9aa5b1";
  }

  function typeClass() {
    return "class-colored";
  }

  function colorizeByClass(element, type) {
    element.style.setProperty("--class-color", classColor(type));
  }

  function render() {
    parkingGrid.replaceChildren();
    for (const lot of lots) {
      const inLot = vehicles.filter((vehicle) => vehicle.parking_lot_id === lot.id);
      parkingGrid.append(makeParkingCard(lot, inLot));
    }
    document.querySelector("#vehicle-count").textContent = vehicles.length;
    document.querySelector("#lot-count").textContent = lots.length;
    document.querySelector("#attention-count").textContent = vehicles.filter((vehicle) =>
      vehicle.status_ids?.length,
    ).length;
    renderVehicleCatalog(vehicles);
    renderStatusFilters();
    renderStatusList(vehicles);
    renderJobs();
    renderInspectionReminders();
    renderTasks();
    if (!dialog.open) renderInspectionDiagram();
  }

  function makeParkingCard(lot, inLot) {
    const card = document.createElement("article");
    card.className = "lot-card";
    card.dataset.lotId = lot.id;
    const heading = document.createElement("div");
    heading.className = "lot-heading";
    heading.draggable = canManageLocations;
    heading.title = canManageLocations ? "エリアカードをドラッグして並べ替え" : "";
    heading.addEventListener("dragstart", (event) => {
      if (!canManageLocations) {
        event.preventDefault();
        return;
      }
      if (event.target.closest("button, a, input")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData("text/plain", String(lot.id));
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("reordering");
    });
    heading.addEventListener("dragend", () => card.classList.remove("reordering"));
    card.addEventListener("dragover", (event) => {
      if (canManageLocations && event.dataTransfer.types.includes("text/plain")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }
    });
    card.addEventListener("drop", (event) => {
      if (!canManageLocations) return;
      event.preventDefault();
      const sourceId = Number(event.dataTransfer.getData("text/plain"));
      if (sourceId && sourceId !== lot.id) reorderLots(sourceId, lot.id).catch(showError);
    });
    const headingTitle = lot.navigation_url
      ? document.createElement("a")
      : document.createElement("div");
    headingTitle.className = "lot-heading-title";
    if (lot.navigation_url) {
      headingTitle.href = lot.navigation_url;
      headingTitle.target = "_blank";
      headingTitle.rel = "noopener noreferrer";
      headingTitle.setAttribute("aria-label", `${lot.name}のGoogleマップナビを開く`);
      headingTitle.title = "Googleマップでナビを開く";
    }
    const title = document.createElement("h3");
    title.textContent = lot.name;
    const count = document.createElement("span");
    count.className = "lot-count";
    count.textContent = lot.capacity != null ? `${inLot.length}/${lot.capacity} 台` : `${inLot.length} 台`;
    if (lot.capacity != null && inLot.length > lot.capacity) count.classList.add("over-capacity");
    if (lot.is_active === false) card.classList.add("inactive-lot");
    if (lot.class_priority?.length) card.title = `優先クラス: ${lot.class_priority.join(" > ")}`;
    headingTitle.append(title, count);
    if (lot.navigation_url) {
      const navigationIcon = document.createElement("span");
      navigationIcon.className = "lot-navigation-icon";
      navigationIcon.textContent = "↗";
      navigationIcon.setAttribute("aria-hidden", "true");
      headingTitle.append(navigationIcon);
    }
    heading.append(headingTitle);
    if (canManageLocations) {
      const controls = document.createElement("div");
      controls.className = "lot-controls";
      const resize = document.createElement("button");
      resize.type = "button";
      resize.className = "lot-control";
      resize.textContent = "サイズ調整";
      resize.title = "クリック後、右下のハンドルをドラッグしてサイズを調整";
      resize.addEventListener("click", () => {
        const nextEditingLotId = editingLotId === lot.id ? null : lot.id;
        if (nextEditingLotId !== editingLotId) drawingLotId = null;
        editingLotId = nextEditingLotId;
        markingError = "";
        render();
      });
      const earlier = makeLotControl("←", "左へ移動", () => moveLot(lot.id, -1));
      const later = makeLotControl("→", "右へ移動", () => moveLot(lot.id, 1));
      resize.textContent = editingLotId === lot.id ? "完了" : "サイズ調整";
      controls.append(resize, earlier, later);
      heading.append(controls);
    }
    if (canManageLocations && editingLotId === lot.id) card.classList.add("size-editing");
    const area = document.createElement("div");
    area.className = "lot-area";
    area.dataset.lotId = lot.id;
    area.style.height = `${Math.max(lot.area_height, Math.ceil(inLot.length / 4) * 52 + 24)}px`;
    card.style.setProperty("--lot-width", `${lot.area_width}%`);
    if (!inLot.length) area.classList.add("empty");
    const markings = Array.isArray(lot.markings) ? lot.markings : [];
    if (markings.length || editingLotId === lot.id) area.classList.remove("empty");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("lot-markings");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-label", `${lot.name}の線`);
    svg.dataset.lotId = lot.id;
    if (editingLotId === lot.id) {
      svg.classList.add("editable");
      svg.classList.toggle("drawing", drawingLotId === lot.id);
      if (drawingLotId === lot.id) {
        const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        hitArea.classList.add("marking-canvas");
        hitArea.setAttribute("width", "1000");
        hitArea.setAttribute("height", "1000");
        hitArea.setAttribute("fill", "transparent");
        hitArea.setAttribute("pointer-events", "all");
        svg.append(hitArea);
      }
      svg.addEventListener("pointerdown", (event) => startMarking(event, lot, svg));
      svg.addEventListener("pointermove", moveMarking);
      svg.addEventListener("pointerup", (event) => endMarking(event, lot, svg));
      svg.addEventListener("pointercancel", cancelMarking);
    }
    for (const marking of markings) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.dataset.markingId = marking.id;
      line.setAttribute("x1", marking.x1 * 1000);
      line.setAttribute("y1", marking.y1 * 1000);
      line.setAttribute("x2", marking.x2 * 1000);
      line.setAttribute("y2", marking.y2 * 1000);
      line.setAttribute("stroke", marking.color);
      line.setAttribute("stroke-width", "7");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("pointer-events", "none");
      svg.append(line);
    }
    if (editingLotId === lot.id && drawingLotId === lot.id) {
      const preview = document.createElementNS("http://www.w3.org/2000/svg", "line");
      preview.classList.add("marking-preview");
      preview.setAttribute("stroke", markingColors.get(lot.id) || "#e34b4b");
      preview.setAttribute("stroke-width", "7");
      preview.setAttribute("stroke-linecap", "round");
      svg.append(preview);
    }
    area.append(svg);
    for (const vehicle of inLot) area.append(makeToken(vehicle));
    let tools;
    if (canManageLocations && editingLotId === lot.id) {
      tools = document.createElement("div");
      tools.className = "lot-drawing-tools";
      const draw = document.createElement("button");
      draw.type = "button";
      draw.className = "lot-control";
      draw.textContent = drawingLotId === lot.id ? "描画終了" : "直線を引く";
      draw.addEventListener("click", () => {
        if (drawingLotId === lot.id) cancelDraftMarking(lot.id);
        drawingLotId = drawingLotId === lot.id ? null : lot.id;
        render();
      });
      const color = document.createElement("input");
      color.type = "color";
      color.id = `marking-color-${lot.id}`;
      color.value = markingColors.get(lot.id) || "#e34b4b";
      color.setAttribute("aria-label", "線の色");
      color.addEventListener("input", () => {
        markingColors.set(lot.id, color.value);
        const preview = card.querySelector(".marking-preview");
        if (preview) preview.setAttribute("stroke", color.value);
      });
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "lot-control";
      undo.textContent = "取り消し";
      undo.title = "保存済みの最後の線を削除して保存します";
      undo.disabled = markings.length === 0 || markingSaveChains.has(lot.id);
      undo.addEventListener("click", () => {
        if (!markings.length) return;
        updateMarkings(lot, markings.slice(0, -1));
      });
      tools.append(draw, color, undo);
      const guidance = document.createElement("span");
      guidance.className = "lot-marking-guidance";
      guidance.textContent = drawingLotId === lot.id
        ? "位置内をドラッグして直線を引きます。線は指を離すと自動保存されます。"
        : "線を描くと自動保存されます。取り消しで最後の線を削除できます。";
      tools.append(guidance);
      if (markingError) {
        const error = document.createElement("span");
        error.className = "lot-marking-error";
        error.textContent = markingError;
        tools.append(error);
      }
    }
    if (canManageLocations) {
      const resizeHandle = document.createElement("button");
      resizeHandle.type = "button";
      resizeHandle.className = "lot-resize-handle";
      resizeHandle.textContent = "◢";
      resizeHandle.setAttribute("aria-label", `${lot.name}のサイズをドラッグして調整`);
      resizeHandle.title = "ドラッグして幅と高さを調整";
      resizeHandle.addEventListener("pointerdown", (event) => startResize(event, lot, card, area));
      area.append(resizeHandle);
    }
    card.append(heading);
    if (tools) card.append(tools);
    card.append(area);
    return card;
  }

  let draftMarking = null;

  function markingPosition(event, svg) {
    const bounds = svg.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  function startMarking(event, lot, svg) {
    if (drawingLotId !== lot.id || (event.button !== 0 && event.pointerType === "mouse")) return;
    event.preventDefault();
    const point = markingPosition(event, svg);
    draftMarking = { lotId: lot.id, pointerId: event.pointerId, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
    const preview = svg.querySelector(".marking-preview");
    preview?.setAttribute("x1", point.x * 1000);
    preview?.setAttribute("y1", point.y * 1000);
    preview?.setAttribute("x2", point.x * 1000);
    preview?.setAttribute("y2", point.y * 1000);
    document.addEventListener("pointermove", moveMarking, true);
    document.addEventListener("pointerup", finishMarking, true);
    document.addEventListener("pointercancel", cancelMarking, true);
  }

  function moveMarking(event) {
    if (!draftMarking || event.pointerId !== draftMarking.pointerId) return;
    const svg = document.querySelector(`.lot-markings[data-lot-id="${draftMarking.lotId}"]`);
    if (!svg) return;
    const point = markingPosition(event, svg);
    draftMarking.x2 = point.x;
    draftMarking.y2 = point.y;
    const preview = svg.querySelector(".marking-preview");
    if (preview) {
      preview.setAttribute("x2", point.x * 1000);
      preview.setAttribute("y2", point.y * 1000);
    }
  }

  async function endMarking(event, lot, svg) {
    if (!draftMarking || event.pointerId !== draftMarking.pointerId) return;
    moveMarking(event);
    const draft = draftMarking;
    draftMarking = null;
    removeMarkingPointerListeners();
    const markings = Array.isArray(lot.markings) ? lot.markings : [];
    if (Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) < 0.01) {
      render();
      return;
    }
    const color = document.querySelector(`#marking-color-${lot.id}`).value;
    await updateMarkings(lot, [...markings, {
      id: createClientId(),
      color,
      x1: draft.x1,
      y1: draft.y1,
      x2: draft.x2,
      y2: draft.y2,
    }]);
  }

  function cancelMarking(event) {
    if (draftMarking?.pointerId === event.pointerId) {
      cancelDraftMarking(draftMarking.lotId);
    }
  }

  function finishMarking(event) {
    if (!draftMarking || event.pointerId !== draftMarking.pointerId) return;
    const lot = lots.find((entry) => entry.id === draftMarking.lotId);
    const svg = document.querySelector(`.lot-markings[data-lot-id="${draftMarking.lotId}"]`);
    if (lot && svg) endMarking(event, lot, svg);
  }

  function removeMarkingPointerListeners() {
    document.removeEventListener("pointermove", moveMarking, true);
    document.removeEventListener("pointerup", finishMarking, true);
    document.removeEventListener("pointercancel", cancelMarking, true);
  }

  function cancelDraftMarking(lotId) {
    if (draftMarking?.lotId !== lotId) return;
    draftMarking = null;
    removeMarkingPointerListeners();
    document.querySelector(`.lot-markings[data-lot-id="${lotId}"] .marking-preview`)?.removeAttribute("x1");
  }

  async function updateMarkings(lot, markings) {
    const previousMarkings = lot.markings;
    const revision = (markingSaveRevisions.get(lot.id) || 0) + 1;
    markingSaveRevisions.set(lot.id, revision);
    lot.markings = markings;
    markingError = "";
    render();
    const previousSave = markingSaveChains.get(lot.id) || Promise.resolve();
    const save = previousSave.catch(() => {}).then(async () => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await api(`/api/parking-lots/${lot.id}/markings`, {
            method: "POST",
            body: JSON.stringify({ markings }),
          });
        } catch (error) {
          lastError = error;
          if (!(error.cause instanceof TypeError) || attempt === 2) throw error;
          await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      throw lastError;
    });
    markingSaveChains.set(lot.id, save);
    try {
      const updated = await save;
      if (markingSaveRevisions.get(lot.id) === revision) {
        Object.assign(lot, updated);
        markingError = "";
      }
    } catch (error) {
      if (markingSaveRevisions.get(lot.id) === revision) {
        lot.markings = previousMarkings;
        markingError = `${error.message} 線はサーバーに保存されていません。`;
      }
    } finally {
      if (markingSaveChains.get(lot.id) === save) markingSaveChains.delete(lot.id);
      if (markingSaveRevisions.get(lot.id) === revision) render();
    }
  }

  function startResize(event, lot, card, area) {
    if (event.button !== 0 || resizing) return;
    event.preventDefault();
    event.stopPropagation();
    const gridWidth = parkingGrid.getBoundingClientRect().width;
    if (!gridWidth) return;
    resizing = {
      lot,
      card,
      area,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: lot.area_width,
      height: area.getBoundingClientRect().height,
      gridWidth,
      nextWidth: lot.area_width,
      nextHeight: area.getBoundingClientRect().height,
    };
    card.classList.add("resizing");
  }

  function moveResize(event) {
    if (!resizing || event.pointerId !== resizing.pointerId) return;
    const nextWidth = Math.max(30, Math.min(100,
      Math.round(resizing.width + (event.clientX - resizing.startX) / resizing.gridWidth * 100)));
    const nextHeight = Math.max(160, Math.min(600,
      resizing.height + event.clientY - resizing.startY));
    resizing.nextWidth = nextWidth;
    resizing.nextHeight = nextHeight;
    resizing.card.style.setProperty("--lot-width", `${nextWidth}%`);
    resizing.area.style.height = `${nextHeight}px`;
  }

  async function endResize(event, cancelled = false) {
    if (!resizing || event.pointerId !== resizing.pointerId) return;
    const current = resizing;
    resizing = null;
    current.card.classList.remove("resizing");
    if (cancelled) {
      current.card.style.setProperty("--lot-width", `${current.width}%`);
      current.area.style.height = `${current.height}px`;
      return;
    }
    if (current.nextWidth === current.width && current.nextHeight === current.height) return;
    try {
      await updateLotLayout(current.lot, {
        area_width: current.nextWidth,
        area_height: Math.round(current.nextHeight),
      });
    } catch (error) {
      showError(error);
      current.card.style.setProperty("--lot-width", `${current.width}%`);
      current.area.style.height = `${current.height}px`;
    }
  }

  function makeLotControl(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lot-control layout-control";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick().catch(showError);
    });
    return button;
  }

  async function updateLotLayout(lot, changes) {
    await api(`/api/parking-lots/${lot.id}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    await loadBoard();
  }

  async function reorderLots(sourceId, targetId) {
    const ordered = lots.map((lot) => lot.id);
    const sourceIndex = ordered.indexOf(sourceId);
    if (sourceIndex < 0 || !ordered.includes(targetId)) return;
    ordered.splice(sourceIndex, 1);
    ordered.splice(ordered.indexOf(targetId), 0, sourceId);
    await saveLotOrder(ordered);
  }

  async function moveLot(lotId, direction) {
    const ordered = lots.map((lot) => lot.id);
    const index = ordered.indexOf(lotId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ordered.length) return;
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    await saveLotOrder(ordered);
  }

  async function saveLotOrder(ordered) {
    await api("/api/parking-lots/order", {
      method: "PUT",
      body: JSON.stringify({ ids: ordered }),
    });
    await loadBoard();
  }

  function makeToken(vehicle) {
    const token = document.createElement("button");
    token.type = "button";
    token.className = `vehicle-token ${typeClass(vehicle.vehicle_type)}`;
    colorizeByClass(token, vehicle.vehicle_type);
    token.dataset.id = vehicle.id;
    token.style.left = `${8 + vehicle.position_x * 84}%`;
    token.style.top = `${10 + vehicle.position_y * 80}%`;
    token.setAttribute("aria-label", `${vehicle.plate}、${vehicle.vehicle_type}`);
    const statusIcons = statuses
      .filter((status) => vehicle.status_ids?.includes(status.id))
      .map((status) => status.icon);
    if (statusIcons.length) {
      const statusNode = document.createElement("span");
      statusNode.className = "token-statuses";
      statusNode.textContent = statusIcons.join(" · ");
      token.append(statusNode);
    }
    const plate = document.createElement("span");
    plate.className = "token-plate";
    plate.textContent = vehicle.plate;
    token.append(plate);
    if (vehicle.options?.length) {
      const optionsNode = document.createElement("span");
      optionsNode.className = "token-options";
      optionsNode.textContent = vehicle.options.join(" · ");
      token.append(optionsNode);
    }
    token.addEventListener("pointerdown", startDrag);
    token.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      openVehicle(vehicle);
    });
    return token;
  }

  function startDrag(event) {
    if (event.button !== 0 || dragged) return;
    event.preventDefault();
    const token = event.currentTarget;
    const ghost = token.cloneNode(true);
    ghost.classList.add("dragging", "drag-ghost");
    ghost.style.position = "fixed";
    ghost.style.pointerEvents = "none";
    ghost.style.width = `${token.getBoundingClientRect().width}px`;
    ghost.style.left = `${event.clientX}px`;
    ghost.style.top = `${event.clientY}px`;
    document.body.append(ghost);
    dragged = {
      id: Number(token.dataset.id),
      token,
      ghost,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
    };
    token.setPointerCapture(event.pointerId);
    dragged.scrollFrame = requestAnimationFrame(autoScrollWhileDragging);
  }

  function moveDrag(event) {
    if (!dragged || event.pointerId !== dragged.pointerId) return;
    dragged.clientX = event.clientX;
    dragged.clientY = event.clientY;
    if (Math.abs(event.clientX - dragged.startX) + Math.abs(event.clientY - dragged.startY) > 5) {
      dragged.moved = true;
    }
    if (!dragged.moved) return;
    dragged.ghost.style.left = `${event.clientX}px`;
    dragged.ghost.style.top = `${event.clientY}px`;
    updateDropTarget(event.clientX, event.clientY);
  }

  function updateDropTarget(x, y) {
    document.querySelectorAll(".lot-area.drop-target").forEach((area) => area.classList.remove("drop-target"));
    document.elementFromPoint(x, y)
      ?.closest(".lot-area")?.classList.add("drop-target");
  }

  function autoScrollWhileDragging() {
    if (!dragged) return;
    dragged.scrollFrame = requestAnimationFrame(autoScrollWhileDragging);
    if (!dragged.moved) return;
    const edgeSize = Math.min(100, window.innerHeight * 0.16);
    const y = dragged.clientY;
    let scrollDelta = 0;
    if (y < edgeSize) {
      scrollDelta = -Math.ceil(20 * (1 - y / edgeSize));
    } else if (y > window.innerHeight - edgeSize) {
      scrollDelta = Math.ceil(20 * (1 - (window.innerHeight - y) / edgeSize));
    }
    if (!scrollDelta) return;
    const previousScrollY = window.scrollY;
    window.scrollBy(0, scrollDelta);
    if (window.scrollY !== previousScrollY) {
      updateDropTarget(dragged.clientX, dragged.clientY);
    }
  }

  async function endDrag(event, cancelled = false) {
    if (!dragged || event.pointerId !== dragged.pointerId) return;
    const current = dragged;
    cancelAnimationFrame(current.scrollFrame);
    current.clientX = event.clientX;
    current.clientY = event.clientY;
    if (!cancelled && current.moved) updateDropTarget(event.clientX, event.clientY);
    const dropTarget = !cancelled && current.moved
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;
    const dropArea = dropTarget?.closest(".lot-area");
    dragged = null;
    current.ghost.remove();
    document.querySelectorAll(".lot-area.drop-target").forEach((area) => area.classList.remove("drop-target"));
    if (!current.moved) return;
    suppressClick = true;
    if (!dropArea) {
      window.setTimeout(() => { suppressClick = false; }, 0);
      return;
    }
    const rect = dropArea.getBoundingClientRect();
    const position = {
      position_x: Math.max(0, Math.min(1, (event.clientX - rect.left - rect.width * 0.08) / (rect.width * 0.84))),
      position_y: Math.max(0, Math.min(1, (event.clientY - rect.top - rect.height * 0.1) / (rect.height * 0.8))),
      parking_lot_id: Number(dropArea.dataset.lotId),
    };
    try {
      await api(`/api/vehicles/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify(position),
      });
    } catch (error) {
      showError(error);
    }
    await loadBoard();
    window.setTimeout(() => { suppressClick = false; }, 0);
  }

  document.addEventListener("pointermove", moveDrag);
  document.addEventListener("pointermove", moveResize);
  document.addEventListener("pointermove", moveInspectionIssueDrag, true);
  document.addEventListener("pointerup", (event) => endDrag(event));
  document.addEventListener("pointerup", (event) => endResize(event));
  document.addEventListener("pointerup", endInspectionIssueDrag, true);
  document.addEventListener("pointercancel", (event) => endDrag(event, true));
  document.addEventListener("pointercancel", (event) => endResize(event, true));
  document.addEventListener("pointercancel", cancelInspectionIssueDrag, true);

  function populateVehicleTypeChoices() {
    const select = vehicleForm.elements.vehicle_type;
    const current = select.value;
    select.replaceChildren(...vehicleTypes.map((type) => {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      return option;
    }));
    if (vehicleTypes.includes(current)) select.value = current;
    const filters = document.querySelector("#vehicle-type-filters");
    const active = activeVehicleType;
    filters.replaceChildren();
    for (const [value, label] of [["all", "All"], ...vehicleTypes.map((type) => [type, type])]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `type-filter${value === "all" ? "" : ` ${typeClass(value)}`}${value === active ? " active" : ""}`;
      button.dataset.vehicleType = value;
      if (value !== "all") colorizeByClass(button, value);
      button.textContent = label;
      button.addEventListener("click", () => {
        activeVehicleType = value;
        renderVehicleCatalog(vehicles);
      });
      filters.append(button);
    }
  }

  function renderVehicleCatalog(boardVehicles) {
    const catalogInput = document.querySelector("#catalog-search");
    const query = normalizePlateQuery(catalogInput?.value || "");
    const filtered = boardVehicles.filter((vehicle) =>
      (activeVehicleType === "all" || vehicle.vehicle_type === activeVehicleType) &&
      (!query || normalizePlateQuery(vehicle.plate).includes(query)),
    );
    const list = document.querySelector("#vehicle-catalog-list");
    list.replaceChildren();
    document.querySelector("#catalog-total").textContent = `${filtered.length} 台`;
    document.querySelectorAll(".type-filter").forEach((button) => {
      button.classList.toggle("active", button.dataset.vehicleType === activeVehicleType);
    });
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "該当する車両はありません。";
      list.append(empty);
      return;
    }
    for (const vehicle of filtered) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "catalog-item";
      const plate = document.createElement("strong");
      plate.textContent = vehicle.plate;
      const details = document.createElement("span");
      const lot = lots.find((entry) => entry.id === vehicle.parking_lot_id);
      details.textContent = `${vehicle.vehicle_type} · ${lot?.name || "未配置"}${vehicle.options?.length ? ` · ${vehicle.options.join("・")}` : ""}`;
      item.append(plate, details);
      item.addEventListener("click", () => {
        const location = document.querySelector(`[data-lot-id="${vehicle.parking_lot_id}"]`);
        location?.scrollIntoView({ behavior: "smooth", block: "center" });
        const token = document.querySelector(`[data-id="${vehicle.id}"]`);
        if (token) {
          token.focus({ preventScroll: true });
          token.classList.remove("token-blink");
          void token.offsetWidth;
          token.classList.add("token-blink");
          setTimeout(() => token.classList.remove("token-blink"), 1700);
        }
      });
      list.append(item);
    }
  }

  function renderStatusFilters() {
    const filters = document.querySelector("#status-filters");
    filters.replaceChildren();
    const options = [{ id: "all", label: "すべて" }, ...statuses.map((status) => ({
      id: String(status.id),
      label: `${status.icon} ${status.name}`,
    }))];
    for (const status of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `filter-button${String(activeStatus) === status.id ? " active" : ""}`;
      button.dataset.filter = status.id;
      button.textContent = status.label;
      button.addEventListener("click", () => {
        activeStatus = status.id;
        renderStatusFilters();
        renderStatusList(vehicles);
      });
      filters.append(button);
    }
  }

  function renderStatusList(boardVehicles) {
    const list = document.querySelector("#status-list");
    list.replaceChildren();
    const selectedStatusId = activeStatus === "all" ? null : Number(activeStatus);
    const filtered = boardVehicles.filter((vehicle) =>
      selectedStatusId === null || vehicle.status_ids?.includes(selectedStatusId));
    document.querySelector("#status-total").textContent = `${filtered.length} 台`;
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = activeStatus === "all" ? "登録車両はありません。「車両を追加」から登録してください。" : "該当する車両はありません。";
      list.append(empty);
      return;
    }
    for (const vehicle of filtered) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "status-item";
      const plate = document.createElement("strong");
      plate.textContent = vehicle.plate;
      const description = document.createElement("span");
      const active = statuses.filter((status) => vehicle.status_ids?.includes(status.id))
        .map((status) => `${status.icon} ${status.name}`);
      const lot = lots.find((entry) => entry.id === vehicle.parking_lot_id);
      description.textContent = `${lot?.name || "未配置"} · ${active.join(" / ") || vehicle.vehicle_type}`;
      item.append(plate, description);
      item.addEventListener("click", () => {
        document.querySelector(`[data-lot-id="${vehicle.parking_lot_id}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
        document.querySelector(`[data-id="${vehicle.id}"]`)?.focus({ preventScroll: true });
      });
      list.append(item);
    }
  }

  function renderVehicleStatusOptions(vehicle) {
    const options = document.querySelector("#vehicle-status-options");
    options.replaceChildren();
    for (const status of statuses) {
      const label = document.createElement("label");
      label.className = "check-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "status_ids";
      input.value = status.id;
      input.checked = vehicle?.status_ids?.includes(status.id) || false;
      label.append(input, document.createTextNode(`${status.icon} ${status.name}`));
      options.append(label);
    }
    if (!statuses.length) {
      const empty = document.createElement("span");
      empty.className = "status-empty";
      empty.textContent = "対応ステータスはありません。";
      options.append(empty);
    }
  }

  function renderVehicleOptions(vehicle) {
    const container = document.querySelector("#vehicle-option-choices");
    container.replaceChildren();
    for (const option of vehicleOptions) {
      const label = document.createElement("label");
      label.className = "check-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "options";
      input.value = option.name;
      input.checked = vehicle?.options?.includes(option.name) || false;
      label.append(input, document.createTextNode(option.name));
      container.append(label);
    }
    if (!vehicleOptions.length) {
      const empty = document.createElement("span");
      empty.className = "status-empty";
      empty.textContent = "オプションはありません。";
      container.append(empty);
    }
  }

  function renderOptionManager() {
    const list = document.querySelector("#option-manager-list");
    list.replaceChildren();
    for (const option of vehicleOptions) {
      const row = document.createElement("div");
      row.className = "status-manager-row";
      const label = document.createElement("span");
      label.textContent = option.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        const error = document.querySelector("#option-error");
        error.textContent = "";
        if (!window.confirm(`オプション「${option.name}」を削除しますか？登録済み車両からも解除されます。`)) return;
        remove.disabled = true;
        try {
          await api(`/api/vehicle-options/${option.id}`, { method: "DELETE" });
          const selected = new Set([...document.querySelectorAll('input[name="options"]:checked')].map((input) => input.value));
          selected.delete(option.name);
          await loadBoard();
          renderVehicleOptions({ options: [...selected] });
          renderOptionManager();
        } catch (failure) {
          error.textContent = failure.message;
          remove.disabled = false;
        }
      });
      row.append(label, remove);
      list.append(row);
    }
  }

  function jobVehicleInfo(vehicleId) {
    const vehicle = vehicles.find((entry) => entry.id === vehicleId);
    if (!vehicle) return null;
    const lot = lots.find((entry) => entry.id === vehicle.parking_lot_id);
    return { vehicle, className: vehicle.vehicle_type, location: lot ? lot.name : "未配置" };
  }

  function formatJobTime(value) {
    return String(value).replace(/-/g, "/");
  }

  function makeJobRow(job, manager) {
    const info = jobVehicleInfo(job.vehicle_id);
    const destination = lots.find((lot) => lot.id === job.destination_lot_id);
    const row = document.createElement("div");
    row.className = `job-row${job.completed ? " completed" : ""}`;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = Boolean(job.completed);
    check.setAttribute("aria-label", "完了");
    check.addEventListener("change", async () => {
      check.disabled = true;
      try {
        await api(`/api/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ completed: check.checked }) });
        await loadBoard();
        if (document.querySelector("#job-dialog").open) renderJobManager();
      } catch (error) {
        showError(error);
        check.checked = !check.checked;
        check.disabled = false;
      }
    });
    const text = document.createElement("span");
    text.className = "job-text";
    const parts = [formatJobTime(job.scheduled_at), info ? info.vehicle.plate : "—",
      info ? info.className : "—", info ? info.location : "—", "を→", destination ? destination.name : "—"];
    parts.forEach((part, index) => {
      const cell = document.createElement("span");
      cell.className = `job-cell job-cell-${index}`;
      cell.textContent = part;
      text.append(cell);
    });
    row.append(check, text);
    if (manager) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        if (!window.confirm("このジョブを削除しますか？")) return;
        remove.disabled = true;
        try {
          await api(`/api/jobs/${job.id}`, { method: "DELETE" });
          await loadBoard();
          renderJobManager();
        } catch (error) {
          document.querySelector("#job-error").textContent = error.message;
          remove.disabled = false;
        }
      });
      row.append(remove);
    }
    return row;
  }

  function formatBoardDate(value) {
    return String(value || "").replace(/-/g, "/");
  }

  function makeInspectionReminderRow(reminder) {
    const row = document.createElement("div");
    row.className = `inspection-row${reminder.completed ? " completed" : ""}`;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = Boolean(reminder.completed);
    check.setAttribute("aria-label", `${reminder.plate} ${reminder.label} 完了`);
    check.addEventListener("change", async () => {
      check.disabled = true;
      try {
        await api(`/api/vehicle-inspections/${reminder.vehicle_id}`, {
          method: "PATCH",
          body: JSON.stringify({
            inspection_type: reminder.inspection_type,
            due_date: reminder.due_date,
            completed: check.checked,
          }),
        });
        await loadBoard();
      } catch (error) {
        document.querySelector("#inspection-error").textContent = error.message;
        check.checked = !check.checked;
        check.disabled = false;
      }
    });
    const text = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = `${reminder.plate} · ${reminder.label}`;
    const due = document.createElement("time");
    due.dateTime = reminder.due_date;
    due.textContent = formatBoardDate(reminder.due_date);
    text.append(label, due);
    row.append(check, text);
    return row;
  }

  function renderInspectionReminders() {
    const list = document.querySelector("#inspection-list");
    list.replaceChildren();
    document.querySelector("#inspection-total").textContent =
      `未完了 ${inspectionReminders.filter((item) => !item.completed).length} / 全${inspectionReminders.length}件`;
    document.querySelector("#inspection-error").textContent = "";
    if (!inspectionReminders.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "車検・点検予定はありません。";
      list.append(empty);
    }
    for (const reminder of inspectionReminders) list.append(makeInspectionReminderRow(reminder));
  }

  function makeTaskRow(task, manager = false) {
    const row = document.createElement("div");
    row.className = `task-row${task.completed ? " completed" : ""}`;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = Boolean(task.completed);
    check.setAttribute("aria-label", `${formatBoardDate(task.scheduled_date)} ${task.content} 完了`);
    check.addEventListener("change", async () => {
      check.disabled = true;
      try {
        await api(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({ completed: check.checked }),
        });
        await loadBoard();
      } catch (error) {
        const target = manager ? document.querySelector("#task-error") : document.querySelector("#task-board-error");
        target.textContent = error.message;
        check.checked = !check.checked;
        check.disabled = false;
      }
    });
    const text = document.createElement("span");
    text.className = "task-text";
    const date = document.createElement("time");
    date.dateTime = task.scheduled_date;
    date.textContent = formatBoardDate(task.scheduled_date);
    const content = document.createElement("strong");
    content.textContent = task.content;
    text.append(date, content);
    row.append(check, text);
    if (manager) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        if (!window.confirm("このタスクを削除しますか？")) return;
        remove.disabled = true;
        try {
          await api(`/api/tasks/${task.id}`, { method: "DELETE" });
          await loadBoard();
        } catch (error) {
          document.querySelector("#task-error").textContent = error.message;
          remove.disabled = false;
        }
      });
      row.append(remove);
    }
    return row;
  }

  function renderTaskManager() {
    const list = document.querySelector("#task-manager-list");
    list.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "タスクはありません。";
      list.append(empty);
    }
    for (const task of tasks) list.append(makeTaskRow(task, true));
  }

  function renderTasks() {
    const list = document.querySelector("#task-list");
    list.replaceChildren();
    document.querySelector("#task-total").textContent =
      `未完了 ${tasks.filter((task) => !task.completed).length} / 全${tasks.length}件`;
    document.querySelector("#task-board-error").textContent = "";
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "タスクはありません。";
      list.append(empty);
    }
    for (const task of tasks) list.append(makeTaskRow(task));
    if (document.querySelector("#task-dialog").open) renderTaskManager();
  }

  function renderJobs() {
    const list = document.querySelector("#job-list");
    list.replaceChildren();
    const open = jobs.filter((job) => !job.completed).length;
    document.querySelector("#job-total").textContent = `未完了 ${open} / 全${jobs.length}件`;
    if (!jobs.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "ジョブはありません。";
      list.append(empty);
    }
    for (const job of jobs) list.append(makeJobRow(job, false));
    if (document.querySelector("#job-dialog").open) renderJobManager();
  }

  function renderJobManager() {
    const list = document.querySelector("#job-manager-list");
    list.replaceChildren();
    if (!jobs.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "ジョブはありません。";
      list.append(empty);
    }
    for (const job of jobs) list.append(makeJobRow(job, true));
    const destination = document.querySelector("#job-destination");
    const previous = destination.value;
    destination.replaceChildren(...lots.map((lot) => new Option(lot.name, lot.id)));
    if (previous && lots.some((lot) => String(lot.id) === previous)) destination.value = previous;
  }

  function normalizePlateQuery(value) {
    return String(value).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  function selectJobVehicle(vehicleId) {
    jobVehicleId = vehicleId;
    const info = vehicleId === null ? null : jobVehicleInfo(vehicleId);
    document.querySelector("#job-class").textContent = info ? info.className : "—";
    document.querySelector("#job-location").textContent = info ? info.location : "—";
    if (info) document.querySelector("#job-plate").value = info.vehicle.plate;
    document.querySelector("#job-suggestions").hidden = true;
  }

  function updateJobSuggestions() {
    const box = document.querySelector("#job-suggestions");
    const query = normalizePlateQuery(document.querySelector("#job-plate").value);
    selectJobVehicle(null);
    document.querySelector("#job-suggestions").hidden = true;
    box.replaceChildren();
    if (!query) return;
    const matches = vehicles.filter((vehicle) => normalizePlateQuery(vehicle.plate).includes(query)).slice(0, 8);
    if (!matches.length) return;
    for (const vehicle of matches) {
      const info = jobVehicleInfo(vehicle.id);
      const option = document.createElement("button");
      option.type = "button";
      option.textContent = `${vehicle.plate}　${info.className}　${info.location}`;
      option.addEventListener("click", () => selectJobVehicle(vehicle.id));
      box.append(option);
    }
    box.hidden = false;
  }

  function pad2(number) {
    return String(number).padStart(2, "0");
  }

  function currentJobTimeText() {
    const now = new Date();
    return `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }

  function currentLocalDate() {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }

  function jobPickerValueFromText(value) {
    const normalized = String(value).trim().replace(/：/g, ":").replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
    const match = normalized.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[T\s]+(\d{1,2}):(\d{2})$/);
    if (!match) return "";
    const [year, month, day, hour, minute] = match.slice(1).map(Number);
    const date = new Date(year, month - 1, day, hour, minute);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 ||
        date.getDate() !== day || hour > 23 || minute > 59) return "";
    return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
  }

  function prepareJobPicker(picker) {
    picker.value = jobPickerValueFromText(document.querySelector("#job-time-text").value) ||
      currentJobTimeText().replace(/\//g, "-").replace(" ", "T");
  }

  function openJobManager() {
    document.querySelector("#job-error").textContent = "";
    document.querySelector("#add-job-form").reset();
    document.querySelector("#job-time-text").value = currentJobTimeText();
    selectJobVehicle(null);
    renderJobManager();
    document.querySelector("#job-dialog").showModal();
  }

  document.querySelector("#manage-jobs-button").addEventListener("click", openJobManager);
  document.querySelector("#close-job-dialog").addEventListener("click", () =>
    document.querySelector("#job-dialog").close());
  function syncCatalogSearch() {
    renderVehicleCatalog(vehicles);
  }

  document.querySelector("#catalog-search")?.addEventListener("input", syncCatalogSearch);
  document.querySelector("#job-plate").addEventListener("input", updateJobSuggestions);
  document.querySelector("#job-time-picker").addEventListener("pointerdown", (event) => {
    prepareJobPicker(event.currentTarget);
  });
  document.querySelector("#job-time-button").addEventListener("click", () => {
    const picker = document.querySelector("#job-time-picker");
    prepareJobPicker(picker);
    if (typeof picker.showPicker === "function") {
      try {
        picker.showPicker();
        return;
      } catch (error) {
        reportClientError("interaction-error", error, { source: "job-time-picker-show" });
      }
    }
    picker.focus({ preventScroll: true });
    picker.click();
  });
  document.querySelector("#job-time-picker").addEventListener("change", (event) => {
    if (event.target.value) {
      document.querySelector("#job-time-text").value = event.target.value.replace(/-/g, "/").replace("T", " ");
    }
  });
  document.querySelector("#add-job-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.querySelector("#job-error");
    error.textContent = "";
    if (!event.currentTarget.reportValidity()) return;
    if (jobVehicleId === null) {
      error.textContent = "候補から車両を選択してください。";
      return;
    }
    try {
      await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          scheduled_at: document.querySelector("#job-time-text").value,
          vehicle_id: jobVehicleId,
          destination_lot_id: Number(document.querySelector("#job-destination").value),
        }),
      });
      document.querySelector("#job-plate").value = "";
      selectJobVehicle(null);
      await loadBoard();
      renderJobManager();
    } catch (failure) {
      error.textContent = failure.message;
    }
  });

  document.querySelector("#manage-tasks-button").addEventListener("click", () => {
    document.querySelector("#task-error").textContent = "";
    const form = document.querySelector("#add-task-form");
    form.reset();
    form.elements.scheduled_date.value = currentLocalDate();
    renderTaskManager();
    document.querySelector("#task-dialog").showModal();
  });
  document.querySelector("#close-task-dialog").addEventListener("click", () =>
    document.querySelector("#task-dialog").close());
  document.querySelector("#add-task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = document.querySelector("#task-error");
    error.textContent = "";
    if (!form.reportValidity()) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          scheduled_date: form.elements.scheduled_date.value,
          content: form.elements.content.value,
        }),
      });
      form.elements.content.value = "";
      await loadBoard();
      form.elements.scheduled_date.value = currentLocalDate();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      submit.disabled = false;
    }
  });

  function renderStatusManager() {
    const list = document.querySelector("#status-manager-list");
    list.replaceChildren();
    if (!statuses.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "対応ステータスはありません。";
      list.append(empty);
      return;
    }
    for (const status of statuses) {
      const row = document.createElement("div");
      row.className = "status-manager-row";
      const label = document.createElement("span");
      label.textContent = `${status.icon} ${status.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        statusError.textContent = "";
        if (!window.confirm(`ステータス「${status.name}」を削除しますか？登録済み車両からも解除されます。`)) return;
        remove.disabled = true;
        const selectedStatusIds = [...document.querySelectorAll('input[name="status_ids"]:checked')]
          .map((input) => Number(input.value));
        try {
          await api(`/api/statuses/${status.id}`, { method: "DELETE" });
          await loadBoard();
          renderVehicleStatusOptions({
            status_ids: selectedStatusIds.filter((id) => statuses.some((entry) => entry.id === id)),
          });
          renderStatusManager();
        } catch (error) {
          statusError.textContent = error.message;
          remove.disabled = false;
        }
      });
      row.append(label, remove);
      list.append(row);
    }
  }

  const assessmentGroupLabels = {
    body: "外装・内装系",
    electrical: "車検証・電装系",
    basic: "基本情報",
    custom: "追加項目",
  };

  function renderAssessmentFields(values = {}) {
    const container = document.querySelector("#assessment-fields");
    container.replaceChildren();
    const groups = ["body", "electrical", "basic", "custom"];
    for (const groupKey of groups) {
      const groupFields = assessmentFields.filter((field) => field.group_key === groupKey);
      if (!groupFields.length) continue;
      const section = document.createElement("section");
      section.className = "assessment-group";
      const heading = document.createElement("h4");
      heading.textContent = assessmentGroupLabels[groupKey];
      const grid = document.createElement("div");
      grid.className = "assessment-field-grid";
      for (const field of groupFields) {
        const row = document.createElement("div");
        row.className = "assessment-field";
        const label = document.createElement("span");
        label.textContent = field.name;
        const control = document.createElement("div");
        control.className = "assessment-field-control";
        const value = values[field.id] ?? "";
        if (field.field_type === "rating") {
          const input = document.createElement("input");
          input.type = "hidden";
          input.dataset.assessmentFieldId = field.id;
          control.append(input);
          const ratings = document.createElement("div");
          ratings.className = "rating-control";
          ratings.setAttribute("role", "group");
          ratings.setAttribute("aria-label", `${field.name}の評価`);
          for (let score = 1; score <= 5; score += 1) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = String(score);
            button.setAttribute("aria-label", `${score}点`);
            button.setAttribute("aria-pressed", String(String(value) === String(score)));
            button.classList.toggle("active", String(value) === String(score));
            button.addEventListener("click", () => {
              input.value = String(score);
              ratings.querySelectorAll("button").forEach((item) => {
                const active = item === button;
                item.classList.toggle("active", active);
                item.setAttribute("aria-pressed", String(active));
              });
            });
            ratings.append(button);
          }
          control.append(ratings);
        } else if (field.field_type === "checkbox") {
          const input = document.createElement("input");
          input.type = "checkbox";
          input.dataset.assessmentFieldId = field.id;
          input.checked = value === true || value === "true" || value === "1";
          input.setAttribute("aria-label", `${field.name}${field.suffix ? ` ${field.suffix}` : ""}`);
          control.append(input);
          if (field.suffix) {
            const suffix = document.createElement("span");
            suffix.className = "assessment-field-suffix";
            suffix.textContent = field.suffix;
            control.insertBefore(suffix, input);
          }
        } else {
          const input = document.createElement("input");
          input.type = field.field_type === "number" ? "number" : "text";
          input.dataset.assessmentFieldId = field.id;
          input.value = value;
          input.maxLength = field.field_type === "text" ? 500 : 12;
          input.setAttribute("aria-label", field.name);
          if (field.field_type === "number") {
            input.min = "0";
            input.step = "1";
            input.inputMode = "numeric";
            if (field.built_in_key === "registration_month") {
              input.min = "1";
              input.max = "12";
              input.placeholder = "1〜12";
            } else if (field.built_in_key === "registration_year") {
              input.min = "1900";
              input.max = String(new Date().getFullYear());
            }
          }
          control.append(input);
          if (field.suffix) {
            const suffix = document.createElement("span");
            suffix.className = "assessment-field-suffix";
            suffix.textContent = field.suffix;
            control.append(suffix);
          }
        }
        row.append(label, control);
        grid.append(row);
      }
      section.append(heading, grid);
      container.append(section);
    }
    if (!assessmentFields.length) {
      const empty = document.createElement("p");
      empty.className = "assessment-empty";
      empty.textContent = "評価項目はありません。「評価項目・損傷種類を管理」から追加できます。";
      container.append(empty);
    }
  }

  function collectAssessmentValues() {
    const values = {};
    for (const input of document.querySelectorAll("[data-assessment-field-id]")) {
      const field = assessmentFields.find((entry) => entry.id === Number(input.dataset.assessmentFieldId));
      if (!field) continue;
      if (field.field_type === "checkbox") {
        values[field.id] = input.checked;
      } else if (input.value !== "") {
        values[field.id] = input.value;
      }
    }
    return values;
  }

  function renderInspectionDiagram() {
    const palette = document.querySelector("#damage-type-palette");
    const markList = document.querySelector("#inspection-mark-list");
    const hint = document.querySelector("#inspection-hint");
    document.querySelector("#manage-damage-types-button").hidden = !canManage;
    palette.replaceChildren();
    markList.replaceChildren();
    window.__rentalcarInspectionState = { marks: inspectionMarks, damageTypes, selectedTypeId: selectedDamageTypeId };
    document.querySelector("#inspection-car-view")
      .dispatchEvent(new CustomEvent("inspection:state", { detail: window.__rentalcarInspectionState }));
    for (const type of damageTypes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `damage-type-button${selectedDamageTypeId === type.id ? " active" : ""}`;
      button.textContent = `${type.icon} ${type.name}`;
      button.dataset.damageTypeId = type.id;
      button.addEventListener("pointerdown", startInspectionIssueDrag);
      button.addEventListener("click", () => {
        if (suppressDamageClick) {
          suppressDamageClick = false;
          return;
        }
        selectedDamageTypeId = type.id;
        renderInspectionDiagram();
        hint.textContent = `${type.icon} ${type.name}を車体表面までドラッグして記録してください。`;
      });
      palette.append(button);
    }
    if (!damageTypes.length) {
      const empty = document.createElement("span");
      empty.className = "assessment-empty";
      empty.textContent = "問題種類はありません。「評価項目・損傷種類を管理」から追加できます。";
      palette.append(empty);
    }
    inspectionMarks.forEach((mark) => {
      const type = damageTypes.find((entry) => entry.id === mark.damage_type_id);
      if (!type) return;
      const entry = document.createElement("div");
      entry.className = "inspection-mark-entry";
      const label = document.createElement("span");
      label.textContent = `${type.icon} ${type.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `${type.name}の損傷マークを削除`);
      remove.addEventListener("click", () => {
        inspectionMarks = inspectionMarks.filter((entryMark) => entryMark.id !== mark.id);
        renderInspectionDiagram();
      });
      entry.append(label, remove);
      markList.append(entry);
    });
    hint.textContent = selectedDamageTypeId
    ? `${damageTypes.find((type) => type.id === selectedDamageTypeId)?.name || ""}：アイコンを車体図までドラッグして記録`
      : damageTypes.length
      ? "傷または凹みのアイコンを押したまま、3D車体の表面までドラッグしてください。"
        : "先に問題種類を追加してください。";
  }

  function addInspectionMark(typeId, clientX, clientY) {
    const type = damageTypes.find((entry) => entry.id === typeId);
    if (!type || !window.RentalCarInspection3D?.placeAt(type.id, clientX, clientY)) return false;
    return true;
  }

  function startInspectionIssueDrag(event) {
    if ((event.button !== 0 && event.pointerType === "mouse") || inspectionIssueDrag) return;
    event.preventDefault();
    const button = event.currentTarget;
    const type = damageTypes.find((entry) => entry.id === Number(button.dataset.damageTypeId));
    if (!type) return;
    inspectionIssueDrag = {
      type,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      button,
    };
  }

  function moveInspectionIssueDrag(event) {
    if (!inspectionIssueDrag || event.pointerId !== inspectionIssueDrag.pointerId) return;
    const drag = inspectionIssueDrag;
    if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 7) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    if (!drag.ghost) {
      drag.ghost = document.createElement("div");
      drag.ghost.className = "inspection-drag-ghost";
      drag.ghost.style.backgroundColor = drag.type.color;
      drag.ghost.textContent = `${drag.type.icon} ${drag.type.name}`;
      document.body.append(drag.ghost);
      drag.button.classList.add("dragging");
    }
    drag.ghost.style.left = `${event.clientX}px`;
    drag.ghost.style.top = `${event.clientY}px`;
  }

  function endInspectionIssueDrag(event) {
    if (!inspectionIssueDrag || event.pointerId !== inspectionIssueDrag.pointerId) return;
    const drag = inspectionIssueDrag;
    inspectionIssueDrag = null;
    drag.ghost?.remove();
    drag.button.classList.remove("dragging");
    if (drag.moved) {
      suppressDamageClick = true;
      const placed = addInspectionMark(drag.type.id, event.clientX, event.clientY);
      const hint = document.querySelector("#inspection-hint");
      if (placed) {
        hint.textContent = `${drag.type.name}の位置を記録しました。車両の保存時に一緒に保存されます。`;
      } else {
        reportClientError("interaction-error", "Damage marker drag did not hit a vehicle surface", {
          source: "vehicle-inspection-3d-drag",
        });
        selectedDamageTypeId = drag.type.id;
        renderInspectionDiagram();
        hint.textContent = "3D車体の表面まで損傷アイコンをドラッグしてください。";
      }
      window.setTimeout(() => { suppressDamageClick = false; }, 0);
    }
  }

  function cancelInspectionIssueDrag(event) {
    if (!inspectionIssueDrag || event.pointerId !== inspectionIssueDrag.pointerId) return;
    inspectionIssueDrag.ghost?.remove();
    inspectionIssueDrag.button.classList.remove("dragging");
    inspectionIssueDrag = null;
  }

  function renderAssessmentManager() {
    const fields = document.querySelector("#assessment-field-manager-list");
    const types = document.querySelector("#damage-type-manager-list");
    fields.replaceChildren();
    types.replaceChildren();
    for (const field of assessmentFields) {
      const row = document.createElement("div");
      row.className = "assessment-manager-row";
      const label = document.createElement("span");
      label.textContent = `${field.name} · ${
        { rating: "1〜5 評価", checkbox: "チェック", text: "テキスト", number: "数値" }[field.field_type]
      }${field.suffix ? `（${field.suffix}）` : ""}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", () => removeAssessmentItem(
        `/api/assessment-fields/${field.id}`, remove, `${field.name}を削除しますか？保存済み評価からも削除されます。`,
      ));
      row.append(label, remove);
      fields.append(row);
    }
    for (const type of damageTypes) {
      const row = document.createElement("div");
      row.className = "assessment-manager-row";
      const label = document.createElement("span");
      label.textContent = `${type.icon} ${type.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", () => removeAssessmentItem(
        `/api/damage-types/${type.id}`, remove, `${type.name}を削除しますか？記録済みの車体マークも削除されます。`,
      ));
      row.append(label, remove);
      types.append(row);
    }
  }

  async function removeAssessmentItem(path, button, confirmationMessage) {
    assessmentManagerError.textContent = "";
    if (!window.confirm(confirmationMessage)) return;
    button.disabled = true;
    try {
      await api(path, { method: "DELETE" });
      await loadBoard();
      renderAssessmentManager();
      renderInspectionDiagram();
    } catch (error) {
      assessmentManagerError.textContent = error.message;
      button.disabled = false;
    }
  }

  function renderLocationManager() {
    const list = document.querySelector("#location-list");
    list.replaceChildren();
    for (const lot of lots) {
      const row = document.createElement("div");
      row.className = "location-row";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 40;
      input.required = true;
      input.value = lot.name;
      input.setAttribute("aria-label", `${lot.name}の位置名`);
      const navigationInput = document.createElement("input");
      navigationInput.type = "url";
      navigationInput.maxLength = 2000;
      navigationInput.value = lot.navigation_url || "";
      navigationInput.placeholder = "Googleマップのナビリンク（任意）";
      navigationInput.setAttribute("aria-label", `${lot.name}のGoogleマップナビリンク`);
      const save = document.createElement("button");
      save.type = "button";
      save.className = "primary-button";
      save.textContent = "保存";
      save.addEventListener("click", async () => {
        locationError.textContent = "";
        if (!input.reportValidity() || !navigationInput.reportValidity() || !capacityInput.reportValidity()) return;
        try {
          await api(`/api/parking-lots/${lot.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: input.value,
              navigation_url: navigationInput.value,
              capacity: capacityInput.value === "" ? null : Number(capacityInput.value),
              is_active: activeInput.checked,
              class_priority: priority,
            }),
          });
          await loadBoard();
          renderLocationManager();
        } catch (error) {
          locationError.textContent = error.message;
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.title = "車両が配置されている位置は削除できません";
      remove.addEventListener("click", async () => {
        locationError.textContent = "";
        if (!window.confirm(`位置「${lot.name}」を削除しますか？`)) return;
        try {
          await api(`/api/parking-lots/${lot.id}`, { method: "DELETE" });
          lots = lots.filter((entry) => entry.id !== lot.id);
          render();
          renderLocationManager();
        } catch (error) {
          locationError.textContent = error.message;
        }
      });
      const extra = document.createElement("div");
      extra.className = "location-extra";
      const capacityLabel = document.createElement("label");
      capacityLabel.textContent = "収容台数";
      const capacityInput = document.createElement("input");
      capacityInput.type = "number";
      capacityInput.min = "0";
      capacityInput.max = "1000";
      capacityInput.step = "1";
      capacityInput.placeholder = "無制限";
      capacityInput.value = lot.capacity ?? "";
      capacityLabel.append(capacityInput);
      const activeLabel = document.createElement("label");
      activeLabel.className = "location-active";
      const activeInput = document.createElement("input");
      activeInput.type = "checkbox";
      activeInput.checked = lot.is_active !== false;
      activeLabel.append(activeInput, document.createTextNode(" 使用中"));
      let priority = [...(lot.class_priority || [])];
      const priorityBox = document.createElement("div");
      priorityBox.className = "priority-editor";
      const renderPriority = () => {
        priorityBox.replaceChildren();
        const heading = document.createElement("span");
        heading.className = "priority-title";
        heading.textContent = "優先クラス（左ほど優先）";
        priorityBox.append(heading);
        priority.forEach((name, index) => {
          const chip = document.createElement("span");
          chip.className = "priority-chip class-colored";
          colorizeByClass(chip, name);
          const label = document.createElement("b");
          label.textContent = `${index + 1}. ${name}`;
          const actions = [
            ["◀", "前へ", () => { if (index > 0) [priority[index - 1], priority[index]] = [priority[index], priority[index - 1]]; }],
            ["▶", "後ろへ", () => { if (index < priority.length - 1) [priority[index + 1], priority[index]] = [priority[index], priority[index + 1]]; }],
            ["×", "削除", () => { priority.splice(index, 1); }],
          ].map(([text, title, action]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = text;
            button.title = title;
            button.setAttribute("aria-label", `${name}を${title}`);
            button.addEventListener("click", () => { action(); renderPriority(); });
            return button;
          });
          chip.append(label, ...actions);
          priorityBox.append(chip);
        });
        const available = vehicleTypes.filter((name) => !priority.includes(name));
        if (available.length) {
          const select = document.createElement("select");
          select.setAttribute("aria-label", "優先クラスを追加");
          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "＋ クラスを追加";
          select.append(placeholder, ...available.map((name) => {
            const option = document.createElement("option");
            option.value = name;
            option.textContent = name;
            return option;
          }));
          select.addEventListener("change", () => {
            if (select.value) priority.push(select.value);
            renderPriority();
          });
          priorityBox.append(select);
        }
      };
      renderPriority();
      extra.append(capacityLabel, activeLabel, priorityBox);
      row.append(input, navigationInput, save, remove);
      const item = document.createElement("div");
      item.className = "location-item";
      item.append(row, extra);
      list.append(item);
    }
  }

  function openLocationManager() {
    if (!canManageLocations) return;
    locationError.textContent = "";
    renderLocationManager();
    locationDialog.showModal();
  }

  async function loadFranchises() {
    const result = await api("/api/franchises");
    const list = document.querySelector("#franchise-list");
    list.replaceChildren();
    if (!result.franchises.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "加盟店はまだ登録されていません。";
      list.append(empty);
      return;
    }
    for (const franchise of result.franchises) {
      const row = document.createElement("div");
      row.className = "franchise-row";
      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = franchise.name;
      const account = document.createElement("span");
      account.textContent = `管理者：${franchise.admin_usernames || "未登録"}`;
      const state = document.createElement("span");
      state.className = franchise.is_active ? "franchise-active" : "franchise-suspended";
      state.textContent = franchise.is_active ? "利用中" : "利用停止中";
      details.append(name, account, state);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = franchise.is_active ? "danger-button" : "primary-button";
      toggle.textContent = franchise.is_active ? "利用停止" : "利用再開";
      toggle.addEventListener("click", async () => {
        franchiseError.textContent = "";
        toggle.disabled = true;
        try {
          await api(`/api/franchises/${franchise.id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ is_active: !franchise.is_active }),
          });
          await loadFranchises();
        } catch (error) {
          franchiseError.textContent = error.message;
        } finally {
          toggle.disabled = false;
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button franchise-delete-button";
      remove.textContent = "加盟店を削除";
      remove.addEventListener("click", () => {
        row.querySelector(".franchise-delete-confirm")?.remove();
        const confirmation = document.createElement("div");
        confirmation.className = "franchise-delete-confirm";
        const warning = document.createElement("span");
        warning.textContent = `全アカウント・車両・位置を削除します。続行するには「${franchise.name}」を入力してください。`;
        const input = document.createElement("input");
        input.type = "text";
        input.autocomplete = "off";
        input.placeholder = franchise.name;
        input.setAttribute("aria-label", "削除する加盟店名");
        const actions = document.createElement("div");
        actions.className = "franchise-delete-actions";
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "danger-button";
        confirm.textContent = "完全に削除";
        confirm.addEventListener("click", async () => {
          franchiseError.textContent = "";
          if (input.value.trim() !== franchise.name) {
            franchiseError.textContent = "加盟店名が一致しません。";
            return;
          }
          confirm.disabled = true;
          try {
            await api(`/api/franchises/${franchise.id}`, {
              method: "DELETE",
              body: JSON.stringify({ confirmation_name: input.value }),
            });
            await loadFranchises();
          } catch (error) {
            franchiseError.textContent = error.message;
            confirm.disabled = false;
          }
        });
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "quiet-button";
        cancel.textContent = "キャンセル";
        cancel.addEventListener("click", () => confirmation.remove());
        actions.append(confirm, cancel);
        confirmation.append(warning, input, actions);
        row.append(confirmation);
        input.focus();
      });
      const buttons = document.createElement("div");
      buttons.className = "franchise-row-actions";
      buttons.append(toggle, remove);
      row.append(details, buttons);
      list.append(row);
    }
  }

  function openFranchiseManager() {
    if (!canManageFranchises) return;
    franchiseError.textContent = "";
    loadFranchises().catch((error) => {
      franchiseError.textContent = error.message;
    });
    franchiseDialog.showModal();
  }

  async function loadEmployees() {
    const { employees } = await api("/api/employees");
    const list = document.querySelector("#employee-list");
    list.replaceChildren();
    if (!employees.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "従業員アカウントはまだありません。";
      list.append(empty);
      return;
    }
    for (const employee of employees) {
      const row = document.createElement("div");
      row.className = "employee-row";
      const details = document.createElement("div");
      const username = document.createElement("strong");
      username.textContent = employee.username;
      const created = document.createElement("span");
      created.textContent = `作成日: ${employee.created_at}`;
      details.append(username, created);
      const actions = document.createElement("div");
      actions.className = "employee-row-actions";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "quiet-button";
      reset.textContent = "パスワードを変更";
      reset.addEventListener("click", async () => {
        employeeError.textContent = "";
        const existingForm = row.querySelector(".employee-password-form");
        if (existingForm) {
          existingForm.remove();
          reset.textContent = "パスワードを変更";
          return;
        }
        const form = document.createElement("form");
        form.className = "employee-password-form";
        const passwordLabel = document.createElement("label");
        passwordLabel.textContent = "新しいパスワード";
        const password = document.createElement("input");
        password.type = "password";
        password.name = "password";
        password.required = true;
        password.minLength = 12;
        password.maxLength = 1024;
        password.autocomplete = "new-password";
        passwordLabel.append(password);
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "primary-button";
        save.textContent = "パスワードを保存";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "quiet-button";
        cancel.textContent = "キャンセル";
        cancel.addEventListener("click", () => {
          form.remove();
          reset.textContent = "パスワードを変更";
        });
        form.append(passwordLabel, save, cancel);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          employeeError.textContent = "";
          if (!form.reportValidity()) return;
          save.disabled = true;
          try {
            await api(`/api/employees/${employee.id}/password`, {
              method: "PATCH",
              body: JSON.stringify({ password: password.value }),
            });
            form.remove();
            reset.textContent = "パスワードを変更";
            employeeError.textContent = `${employee.username} のパスワードを変更しました。`;
          } catch (error) {
            employeeError.textContent = error.message;
            save.disabled = false;
          }
        });
        row.append(form);
        reset.textContent = "入力を閉じる";
        password.focus();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        employeeError.textContent = "";
        if (!window.confirm(`${employee.username} のアカウントを削除しますか？この操作は元に戻せません。`)) return;
        remove.disabled = true;
        try {
          await api(`/api/employees/${employee.id}`, { method: "DELETE" });
          await loadEmployees();
        } catch (error) {
          employeeError.textContent = error.message;
          remove.disabled = false;
        }
      });
      actions.append(reset, remove);
      row.append(details, actions);
      list.append(row);
    }
  }

  function openEmployeeManager() {
    if (!canManage) return;
    employeeError.textContent = "";
    document.querySelector("#add-employee-form").reset();
    employeeDialog.showModal();
    loadEmployees().catch((error) => { employeeError.textContent = error.message; });
  }

  async function downloadMariaDbExport() {
    if (!canManage) return;
    const button = document.querySelector("#export-vehicles-button");
    const error = document.querySelector("#admin-error");
    error.textContent = "";
    button.disabled = true;
    button.querySelector("b").textContent = "エクスポートを準備中…";
    try {
      const response = await fetch("/api/export/mariadb");
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (response.status === 401) showLogin();
        throw new Error(body.detail || `エクスポートに失敗しました (HTTP ${response.status})`);
      }
      const blob = await response.blob();
      const filename = response.headers.get("content-disposition")
        ?.match(/filename="([^"]+)"/)?.[1] || "guts-parking-mariadb-export.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      button.disabled = false;
      button.querySelector("b").textContent = "車両データをエクスポート";
    }
  }

  function renderClassManager() {
    const list = document.querySelector("#class-manager-list");
    list.replaceChildren();
    for (const item of vehicleClasses) {
      const row = document.createElement("div");
      row.className = "status-manager-row class-manager-row";
      const color = document.createElement("input");
      color.type = "color";
      color.value = item.color;
      color.setAttribute("aria-label", `${item.name}の色`);
      const name = document.createElement("input");
      name.type = "text";
      name.maxLength = 40;
      name.value = item.name;
      name.setAttribute("aria-label", `${item.name}のクラス名`);
      const save = document.createElement("button");
      save.type = "button";
      save.className = "primary-button";
      save.textContent = "保存";
      save.addEventListener("click", async () => {
        classError.textContent = "";
        try {
          await api(`/api/vehicle-classes/${item.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: name.value, color: color.value }),
          });
          await loadBoard();
        } catch (error) {
          classError.textContent = error.message;
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        classError.textContent = "";
        if (!window.confirm(`クラス「${item.name}」を削除しますか？`)) return;
        try {
          await api(`/api/vehicle-classes/${item.id}`, { method: "DELETE" });
          await loadBoard();
        } catch (error) {
          classError.textContent = error.message;
        }
      });
      row.append(color, name, save, remove);
      list.append(row);
    }
  }

  function minutesInput(value, label) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "1440";
    input.step = "1";
    input.value = value ?? "";
    input.setAttribute("aria-label", label);
    return input;
  }

  function renderLogistics() {
    const storeList = document.querySelector("#store-list");
    storeList.replaceChildren();
    for (const store of stores) {
      const row = document.createElement("div");
      row.className = "status-manager-row";
      const name = document.createElement("span");
      name.textContent = store.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        logisticsError.textContent = "";
        if (!window.confirm(`店舗「${store.name}」を削除しますか？`)) return;
        try {
          await api(`/api/stores/${store.id}`, { method: "DELETE" });
          await loadBoard();
        } catch (error) {
          logisticsError.textContent = error.message;
        }
      });
      row.append(name, remove);
      storeList.append(row);
    }
    const storeTable = document.querySelector("#store-distance-table");
    storeTable.replaceChildren();
    const storeGrid = document.createElement("table");
    storeGrid.className = "distance-table";
    const head = storeGrid.createTHead().insertRow();
    head.append(document.createElement("th"));
    for (const store of stores) {
      const th = document.createElement("th");
      th.textContent = store.name;
      head.append(th);
    }
    const body = storeGrid.createTBody();
    for (const lot of lots) {
      const tr = body.insertRow();
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = lot.name;
      tr.append(th);
      for (const store of stores) {
        const entry = storeLotDistances.find((d) => d.store_id === store.id && d.lot_id === lot.id);
        const input = minutesInput(entry?.minutes, `${store.name}から${lot.name}`);
        input.dataset.storeId = store.id;
        input.dataset.lotId = lot.id;
        tr.insertCell().append(input);
      }
    }
    storeTable.append(storeGrid);
    const lotTable = document.querySelector("#lot-distance-table");
    lotTable.replaceChildren();
    const lotGrid = document.createElement("table");
    lotGrid.className = "distance-table";
    const lotHead = lotGrid.createTHead().insertRow();
    lotHead.append(document.createElement("th"));
    for (const lot of lots) {
      const th = document.createElement("th");
      th.textContent = lot.name;
      lotHead.append(th);
    }
    const lotBody = lotGrid.createTBody();
    lots.forEach((from, i) => {
      const tr = lotBody.insertRow();
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = from.name;
      tr.append(th);
      lots.forEach((to, j) => {
        const cell = tr.insertCell();
        if (j <= i) {
          cell.className = "distance-blank";
          cell.textContent = j === i ? "—" : "";
          return;
        }
        const entry = lotDistances.find((d) =>
          (d.from_lot_id === from.id && d.to_lot_id === to.id)
          || (d.from_lot_id === to.id && d.to_lot_id === from.id));
        const input = minutesInput(entry?.minutes, `${from.name}から${to.name}`);
        input.dataset.fromLotId = from.id;
        input.dataset.toLotId = to.id;
        cell.append(input);
      });
    });
    lotTable.append(lotGrid);
  }

  async function saveDistances(path, inputs, build) {
    logisticsError.textContent = "";
    try {
      const entries = inputs.map((input) => build(input, input.value === "" ? null : Number(input.value)));
      await api(path, { method: "PUT", body: JSON.stringify({ entries }) });
      await loadBoard();
    } catch (error) {
      logisticsError.textContent = error.message;
    }
  }

  function openLogisticsManager() {
    logisticsError.textContent = "";
    logisticsDialog.querySelector('.tab-button[data-tab="stores"]').click();
    renderLogistics();
    logisticsDialog.showModal();
  }

  function openClassManager() {
    if (!canManage) return;
    classError.textContent = "";
    renderClassManager();
    classDialog.showModal();
  }

  function openVehicle(vehicle = null) {
    vehicleForm.reset();
    formError.textContent = "";
    document.querySelector("#dialog-title").textContent = vehicle ? "車両情報を編集" : "車両を追加";
    document.querySelector("#manage-assessment-button").hidden = !canManage;
    document.querySelector("#manage-classes-button").hidden = !canManage;
    document.querySelector("#manage-options-button").hidden = !canManage;
    document.querySelector("#manage-vehicle-statuses-button").hidden = !canManage;
    document.querySelector("#manage-damage-types-button").hidden = !canManage;
    document.querySelector("#delete-vehicle").hidden = !vehicle || !canManage;
    const defaultLot = lots[0];
    document.querySelector(".default-location-note").textContent =
      `追加した車両は「${defaultLot?.name || "最初の位置"}」に登録されます。`;
    vehicleForm.elements.id.value = vehicle?.id || "";
    vehicleForm.elements.plate.value = vehicle?.plate || "";
    vehicleForm.elements.vehicle_type.value = vehicle?.vehicle_type || vehicleTypes[0] || "";
    renderVehicleOptions(vehicle);
    renderVehicleStatusOptions(vehicle);
    inspectionMarks = vehicle?.inspection_marks?.map((mark) => ({ ...mark })) || [];
    selectedDamageTypeId = null;
    renderAssessmentFields(vehicle?.assessment_values || {});
    vehicleForm.elements.inspection_expiry_date.value = vehicle?.inspection_expiry_date || "";
    vehicleForm.elements.statutory_inspection_date.value = vehicle?.statutory_inspection_date || "";
    vehicleForm.elements.notes.value = vehicle?.notes || "";
    renderInspectionDiagram();
    dialog.showModal();
  }

  function openAssessmentManager() {
    if (!canManage) return;
    assessmentManagerError.textContent = "";
    renderAssessmentManager();
    assessmentManagerDialog.showModal();
  }

  function openStatusManager() {
    if (!canManage) return;
    statusError.textContent = "";
    renderStatusManager();
    statusDialog.showModal();
  }

  function connectSocket() {
    if (socket) socket.close();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.addEventListener("open", () => setConnection(true));
    socket.addEventListener("message", () => loadBoard().catch(showError));
    socket.addEventListener("close", (event) => {
      setConnection(false);
      if ([4003, 4004, 4005, 4006].includes(event.code)) {
        loginError.textContent = event.code === 4003
          ? "この加盟店アカウントは一時停止中です。総本店へお問い合わせください。"
          : event.code === 4004
          ? "この加盟店アカウントは削除されました。総本店へお問い合わせください。"
          : "アカウントの認証情報が変更されました。新しい情報で再ログインしてください。";
        showLogin();
        return;
      }
      if (!appScreen.hidden) window.setTimeout(connectSocket, 2000);
    });
    socket.addEventListener("error", () => socket.close());
  }

  function setConnection(connected) {
    const state = document.querySelector("#connection-state");
    state.classList.toggle("offline", !connected);
    state.lastChild.textContent = connected ? "接続中" : "再接続中";
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.textContent = "";
    const form = new FormData(loginForm);
    try {
      const result = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      loginForm.reset();
      showBoard(
        result.username,
        result.can_manage,
        result.can_manage_franchises,
        result.tenant_name,
      );
    } catch (error) {
      loginError.textContent = error.message;
    }
  });

  document.querySelector("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
      showLogin();
    } catch (error) {
      showError(error);
    }
  });
  document.querySelector("#add-vehicle-button").addEventListener("click", () => openVehicle());
  document.querySelector("#manage-locations-button").addEventListener("click", openLocationManager);
  document.querySelector("#admin-panel-button").addEventListener("click", () =>
    canManage && document.querySelector("#admin-dialog").showModal());
  document.querySelector("#close-admin-dialog").addEventListener("click", () =>
    document.querySelector("#admin-dialog").close());
  document.querySelector("#manage-logistics-button").addEventListener("click", openLogisticsManager);
  document.querySelector("#close-class-dialog").addEventListener("click", () => classDialog.close());
  document.querySelector("#close-logistics-dialog").addEventListener("click", () => logisticsDialog.close());
  logisticsDialog.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => {
    logisticsDialog.querySelectorAll(".tab-button").forEach((item) => item.classList.toggle("active", item === button));
    logisticsDialog.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== button.dataset.tab;
    });
  }));
  document.querySelector("#add-class-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    classError.textContent = "";
    const form = event.currentTarget;
    try {
      await api("/api/vehicle-classes", {
        method: "POST",
        body: JSON.stringify({ name: form.elements.name.value, color: form.elements.color.value }),
      });
      form.elements.name.value = "";
      await loadBoard();
    } catch (error) {
      classError.textContent = error.message;
    }
  });
  document.querySelector("#add-store-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    logisticsError.textContent = "";
    const form = event.currentTarget;
    try {
      await api("/api/stores", { method: "POST", body: JSON.stringify({ name: form.elements.name.value }) });
      form.elements.name.value = "";
      await loadBoard();
    } catch (error) {
      logisticsError.textContent = error.message;
    }
  });
  document.querySelector("#save-store-distances").addEventListener("click", () =>
    saveDistances("/api/store-distances", [...document.querySelectorAll("#store-distance-table input")],
      (input, minutes) => ({ store_id: Number(input.dataset.storeId), lot_id: Number(input.dataset.lotId), minutes })));
  document.querySelector("#save-lot-distances").addEventListener("click", () =>
    saveDistances("/api/lot-distances", [...document.querySelectorAll("#lot-distance-table input")],
      (input, minutes) => ({ from_lot_id: Number(input.dataset.fromLotId), to_lot_id: Number(input.dataset.toLotId), minutes })));
  document.querySelector("#manage-franchises-button").addEventListener("click", openFranchiseManager);
  document.querySelector("#manage-employees-button").addEventListener("click", openEmployeeManager);
  document.querySelector("#export-vehicles-button").addEventListener("click", downloadMariaDbExport);
  document.querySelector("#close-employee-dialog").addEventListener("click", () => employeeDialog.close());
  document.querySelector("#manage-classes-button").addEventListener("click", openClassManager);
  document.querySelector("#manage-vehicle-statuses-button").addEventListener("click", openStatusManager);
  document.querySelector("#manage-options-button").addEventListener("click", () => {
    document.querySelector("#option-error").textContent = "";
    renderOptionManager();
    document.querySelector("#option-dialog").showModal();
  });
  document.querySelector("#manage-assessment-button").addEventListener("click", openAssessmentManager);
  document.querySelector("#manage-damage-types-button").addEventListener("click", openAssessmentManager);
  document.querySelector("#close-location-dialog").addEventListener("click", () => locationDialog.close());
  document.querySelector("#close-franchise-dialog").addEventListener("click", () => franchiseDialog.close());
  document.querySelector("#close-status-dialog").addEventListener("click", () => statusDialog.close());
  document.querySelector("#close-option-dialog").addEventListener("click", () =>
    document.querySelector("#option-dialog").close());
  document.querySelector("#close-assessment-manager").addEventListener("click", () => assessmentManagerDialog.close());
  document.querySelector("#add-employee-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    employeeError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const result = await api("/api/employees", {
        method: "POST",
        body: JSON.stringify({
          username: form.elements.username.value,
          password: form.elements.password.value,
        }),
      });
      form.reset();
      await loadEmployees();
      employeeError.textContent = `${result.employee.username} の従業員アカウントを作成しました。`;
    } catch (error) {
      employeeError.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  document.querySelector("#add-status-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    statusError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    try {
      await api("/api/statuses", {
        method: "POST",
        body: JSON.stringify({ name: data.get("name"), icon: data.get("icon") }),
      });
      form.reset();
      await loadBoard();
      renderStatusManager();
      renderVehicleStatusOptions({
        status_ids: [...document.querySelectorAll('input[name="status_ids"]:checked')].map((input) => Number(input.value)),
      });
    } catch (error) {
      statusError.textContent = error.message;
    }
  });
  document.querySelector("#add-option-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = document.querySelector("#option-error");
    error.textContent = "";
    if (!form.reportValidity()) return;
    try {
      await api("/api/vehicle-options", {
        method: "POST",
        body: JSON.stringify({ name: new FormData(form).get("name") }),
      });
      const selected = [...document.querySelectorAll('input[name="options"]:checked')].map((input) => input.value);
      form.reset();
      await loadBoard();
      renderVehicleOptions({ options: selected });
      renderOptionManager();
    } catch (failure) {
      error.textContent = failure.message;
    }
  });
  document.querySelector("#add-assessment-field-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    assessmentManagerError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    try {
      await api("/api/assessment-fields", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          field_type: data.get("field_type"),
          suffix: data.get("suffix"),
        }),
      });
      form.reset();
      const currentValues = collectAssessmentValues();
      await loadBoard();
      renderAssessmentFields(currentValues);
      renderAssessmentManager();
      renderInspectionDiagram();
    } catch (error) {
      assessmentManagerError.textContent = error.message;
    }
  });
  document.querySelector("#add-damage-type-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    assessmentManagerError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    try {
      await api("/api/damage-types", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          icon: data.get("icon"),
          color: data.get("color"),
        }),
      });
      form.reset();
      const currentValues = collectAssessmentValues();
      await loadBoard();
      renderAssessmentFields(currentValues);
      renderAssessmentManager();
      renderInspectionDiagram();
    } catch (error) {
      assessmentManagerError.textContent = error.message;
    }
  });
  document.querySelector("#add-franchise-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    franchiseError.textContent = "";
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    try {
      await api("/api/franchises", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          username: data.get("username"),
          password: data.get("password"),
        }),
      });
      form.reset();
      await loadFranchises();
    } catch (error) {
      franchiseError.textContent = error.message;
    }
  });
  document.querySelector("#add-location-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    locationError.textContent = "";
    const form = event.currentTarget;
    const nameInput = form.elements.name;
    const navigationInput = form.elements.navigation_url;
    if (!nameInput.reportValidity() || !navigationInput.reportValidity()) return;
    try {
      await api("/api/parking-lots", {
        method: "POST",
        body: JSON.stringify({ name: nameInput.value, navigation_url: navigationInput.value }),
      });
      form.reset();
      await loadBoard();
      renderLocationManager();
    } catch (error) {
      locationError.textContent = error.message;
    }
  });
  document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
  document.querySelector("#cancel-dialog").addEventListener("click", () => dialog.close());
  document.querySelector("#inspection-car-view").addEventListener("inspection:mark", (event) => {
    inspectionMarks.push(event.detail);
    selectedDamageTypeId = null;
    renderInspectionDiagram();
    document.querySelector("#inspection-hint").textContent = "損傷位置を記録しました。車両の保存時に一緒に保存されます。";
  });
  document.querySelector("#inspection-car-view").addEventListener("inspection:delete-mark", (event) => {
    inspectionMarks = inspectionMarks.filter((mark) => mark.id !== event.detail.id);
    renderInspectionDiagram();
  });
  document.querySelector("#delete-vehicle").addEventListener("click", async () => {
    if (!canManage) return;
    const id = vehicleForm.elements.id.value;
    if (!id || !window.confirm("この車両を削除しますか？")) return;
    try {
      await api(`/api/vehicles/${id}`, { method: "DELETE" });
      dialog.close();
      await loadBoard();
    } catch (error) {
      formError.textContent = error.message;
    }
  });
  vehicleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    const form = new FormData(vehicleForm);
    const id = form.get("id");
    const payload = {
      plate: form.get("plate"),
      vehicle_type: form.get("vehicle_type"),
      options: form.getAll("options"),
      notes: form.get("notes"),
      inspection_expiry_date: form.get("inspection_expiry_date"),
      statutory_inspection_date: form.get("statutory_inspection_date"),
    };
    payload.status_ids = form.getAll("status_ids").map(Number);
    payload.assessment_values = collectAssessmentValues();
    payload.inspection_marks = inspectionMarks;
    try {
      await api(id ? `/api/vehicles/${id}` : "/api/vehicles", {
        method: id ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      activeVehicleType = "all";
      dialog.close();
      await loadBoard();
    } catch (error) {
      formError.textContent = error.message;
    }
  });
  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      activeStatus = button.dataset.filter;
      document.querySelectorAll(".filter-button").forEach((item) => item.classList.toggle("active", item === button));
      renderStatusList(vehicles);
    });
  });
  window.addEventListener("error", (event) => {
    if (event.target && event.target !== window) {
      const target = event.target;
      if (target instanceof HTMLScriptElement || target instanceof HTMLLinkElement) {
        reportClientError("resource-load-error", `${target.tagName} failed to load`, {
          source: target.src || target.href || "",
        });
      }
      return;
    }
    reportClientError("browser-error", event.error || event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    reportClientError("unhandled-rejection", event.reason);
  });
  api("/api/me").then((result) => {
    setAppVersion(result.version);
    if (result.authenticated) {
      showBoard(result.username, result.can_manage, result.can_manage_franchises, result.tenant_name);
    } else {
      showLogin();
      if (result.suspended) {
        loginError.textContent = "この加盟店アカウントは一時停止中です。総本店へお問い合わせください。";
      }
    }
  }).catch(showLogin);
})();
