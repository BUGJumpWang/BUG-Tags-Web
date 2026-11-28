(() => {
  "use strict";

  const SERVICE_UUID = "f000fff0-0451-4000-b000-000000000000";
  const DATA_UUID = "f000fff1-0451-4000-b000-000000000000";
  const DEVICE_INFO_UUID = 0x180a;
  const INFO_CHARS = [
    { uuid: 0x2a29, id: "manufacturer", label: "Manufacturer" },
    { uuid: 0x2a24, id: "model", label: "Model" },
    { uuid: 0x2a26, id: "firmware", label: "Firmware" },
    { uuid: 0x2a27, id: "hardware", label: "Hardware" }
  ];
  const STORAGE_KEY = "bug-tags-v04-landscape-pages";
  const WIDTH = 212;
  const HEIGHT = 104;
  const BUFFER_SIZE = 2756;
  const COLUMN_BYTES = HEIGHT / 8;
  const CHUNK_SIZE = 19; // Conservative 20-byte ATT payload works even before MTU exchange.

  const el = (id) => document.getElementById(id);
  const canvas = el("screen-preview");
  const ctx = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;

  let device = null;
  let server = null;
  let dataCharacteristic = null;
  let pendingNotify = null;
  let pages = loadPages();
  let activePageId = "clock";
  let selectedElementId = null;
  let connectedInfo = { name: "", manufacturer: "", model: "", firmware: "", hardware: "" };
  let sendBusy = false;
  let notifyListenerInstalled = false;

  function defaultPages() {
    return [
      { id: "clock", name: "Clock", kind: "clock", elements: [] },
      {
        id: "page-1", name: "Page 1", kind: "custom",
        elements: [
          { id: "title", type: "text", x: 8, y: 8, w: 112, h: 20, size: 2, content: "BUG-Tags" },
          { id: "qr", type: "qr", x: 160, y: 7, w: 44, h: 44, size: 1, content: "https://example.com" },
          { id: "table", type: "table", x: 8, y: 60, w: 124, h: 36, size: 1, content: "ITEM|VALUE\nMODEL|M3N\nFW|0.3" },
          { id: "info", type: "info", x: 140, y: 60, w: 64, h: 36, size: 1, content: "" }
        ]
      }
    ];
  }

  function loadPages() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultPages();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.some((page) => page && page.id === "clock")) return defaultPages();
      parsed.forEach((page) => {
        if (!Array.isArray(page.elements)) page.elements = [];
        page.kind = page.id === "clock" ? "clock" : "custom";
      });
      return parsed;
    } catch (_) {
      return defaultPages();
    }
  }

  function savePages() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pages));
    } catch (error) {
      log("页面保存失败：" + error.message);
    }
  }

  function currentPage() {
    return pages.find((page) => page.id === activePageId) || pages[0];
  }

  function selectedElement() {
    const page = currentPage();
    if (!page) return null;
    return page.elements.find((item) => item.id === selectedElementId) || null;
  }

  function log(message) {
    const target = el("log");
    if (!target) return;
    const time = new Date().toLocaleTimeString();
    target.textContent += (target.textContent ? "\n" : "") + "[" + time + "] " + message;
    target.scrollTop = target.scrollHeight;
  }

  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value || "—";
  }

  function isConnected() {
    return !!(device && device.gatt && device.gatt.connected && dataCharacteristic);
  }

  function setConnected(connected) {
    el("state-pill").textContent = connected ? "CONNECTED" : "未连接";
    el("connect").disabled = connected;
    el("disconnect").disabled = !connected || sendBusy;
    el("send-screen").disabled = !connected || sendBusy;
    el("show-clock").disabled = !connected || sendBusy;
    el("apply-led").disabled = !connected || sendBusy;
    setText("gatt-state", connected ? "Connected" : "Disconnected");
  }

  function setBusy(busy) {
    sendBusy = busy;
    setConnected(isConnected());
    el("send-screen").textContent = busy ? "正在发送…" : "发送到标签";
  }

  function renderPageSelect() {
    const select = el("page-select");
    select.textContent = "";
    pages.forEach((page) => {
      const option = document.createElement("option");
      option.value = page.id;
      option.textContent = page.name + (page.kind === "clock" ? " · 实时钟" : "");
      select.appendChild(option);
    });
    if (!pages.some((page) => page.id === activePageId)) activePageId = pages[0].id;
    select.value = activePageId;
    el("delete-page").disabled = currentPage().kind === "clock";
    el("page-name").value = currentPage().name;
    renderElementSelect();
  }

  function renderElementSelect() {
    const page = currentPage();
    const select = el("element-select");
    select.textContent = "";
    page.elements.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = (index + 1) + ". " + item.type.toUpperCase() + " — " + String(item.content || "").slice(0, 18);
      select.appendChild(option);
    });
    if (!selectedElementId || !page.elements.some((item) => item.id === selectedElementId)) {
      selectedElementId = page.elements.length ? page.elements[0].id : null;
    }
    if (selectedElementId) select.value = selectedElementId;
    loadSelectedElement();
  }

  function loadSelectedElement() {
    const page = currentPage();
    const item = selectedElement();
    const editable = page.kind === "custom" && !!item;
    ["element-content", "element-x", "element-y", "element-width", "element-height", "element-size", "save-element", "delete-element"]
      .forEach((id) => { el(id).disabled = !editable; });
    if (!editable) {
      el("element-content").value = "";
      el("delete-element").disabled = true;
      return;
    }
    el("element-content").value = item.content || "";
    el("element-x").value = item.x;
    el("element-y").value = item.y;
    el("element-width").value = item.w;
    el("element-height").value = item.h;
    el("element-size").value = String(item.size || 1);
    el("delete-element").disabled = false;
  }

  const firmwareFont = [
    [0x3E,0x51,0x49,0x45,0x3E], [0x00,0x42,0x7F,0x40,0x00],
    [0x42,0x61,0x51,0x49,0x46], [0x21,0x41,0x45,0x4B,0x31],
    [0x18,0x14,0x12,0x7F,0x10], [0x27,0x45,0x45,0x45,0x39],
    [0x3C,0x4A,0x49,0x49,0x30], [0x01,0x71,0x09,0x05,0x03],
    [0x36,0x49,0x49,0x49,0x36], [0x06,0x49,0x49,0x29,0x1E],
    [0x7E,0x11,0x11,0x11,0x7E], [0x7F,0x49,0x49,0x49,0x36],
    [0x3E,0x41,0x41,0x41,0x22], [0x7F,0x41,0x41,0x22,0x1C],
    [0x7F,0x49,0x49,0x49,0x41], [0x7F,0x09,0x09,0x09,0x01],
    [0x3E,0x41,0x49,0x49,0x7A], [0x7F,0x08,0x08,0x08,0x7F],
    [0x00,0x41,0x7F,0x41,0x00], [0x20,0x40,0x41,0x3F,0x01],
    [0x7F,0x08,0x14,0x22,0x41], [0x7F,0x40,0x40,0x40,0x40],
    [0x7F,0x02,0x0C,0x02,0x7F], [0x7F,0x04,0x08,0x10,0x7F],
    [0x3E,0x41,0x41,0x41,0x3E], [0x7F,0x09,0x09,0x09,0x06],
    [0x3E,0x41,0x51,0x21,0x5E], [0x7F,0x09,0x19,0x29,0x46],
    [0x46,0x49,0x49,0x49,0x31], [0x01,0x01,0x7F,0x01,0x01],
    [0x3F,0x40,0x40,0x40,0x3F], [0x1F,0x20,0x40,0x20,0x1F],
    [0x3F,0x40,0x38,0x40,0x3F], [0x63,0x14,0x08,0x14,0x63],
    [0x07,0x08,0x70,0x08,0x07], [0x61,0x51,0x49,0x45,0x43]
  ];

  function drawFirmwareText(text, x, y, scale) {
    let cursorX = x;
    for (const ch of text) {
      let glyph = [0, 0, 0, 0, 0];
      if (ch >= "0" && ch <= "9") glyph = firmwareFont[ch.charCodeAt(0) - 48];
      else if (ch >= "A" && ch <= "Z") glyph = firmwareFont[10 + ch.charCodeAt(0) - 65];
      else if (ch === ":") glyph = [0, 0, 0x36, 0, 0];
      else if (ch === "-") glyph = [0x08, 0x08, 0x08, 0x08, 0x08];
      else if (ch === ".") glyph = [0, 0, 0x60, 0, 0];
      for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 7; row++) {
          if (glyph[col] & (1 << row)) {
            ctx.fillRect(cursorX + col * scale, y + row * scale, scale, scale);
          }
        }
      }
      cursorX += 6 * scale;
    }
  }

  function formatTime(date) {
    return String(date.getHours()).padStart(2, "0") + ":" +
      String(date.getMinutes()).padStart(2, "0");
  }

  function drawClockPreview() {
    const time = formatTime(new Date());
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = "#000";
    drawFirmwareText("BUG-TAGS", 8, 7, 1);
    drawFirmwareText("LOCAL TIME", 145, 7, 1);
    ctx.fillRect(8, 21, 196, 1);
    const textWidth = (5 * 6 * 5) - 5;
    drawFirmwareText(time, Math.floor((WIDTH - textWidth) / 2), 30, 5);
    ctx.fillRect(8, 76, 196, 1);
    drawFirmwareText("STELLAR M3N", 8, 87, 1);
    drawFirmwareText("BLE E-PAPER", 139, 87, 1);
  }

  function drawTextElement(item) {
    const size = Math.max(1, Math.min(3, Number(item.size) || 1));
    const fontSize = size === 1 ? 7 : (size === 2 ? 10 : 14);
    ctx.fillStyle = "#000";
    ctx.textBaseline = "top";
    ctx.font = fontSize + "px monospace";
    const lines = String(item.content || "").split("\n");
    let y = Number(item.y) || 0;
    const maxY = Math.min(HEIGHT, y + Math.max(1, Number(item.h) || 24));
    lines.forEach((line) => {
      if (y + fontSize <= maxY) ctx.fillText(line, Number(item.x) || 0, y, Number(item.w) || WIDTH);
      y += fontSize + 2;
    });
  }

  function drawQrElement(item) {
    const value = String(item.content || "").trim();
    const x = Math.max(0, Number(item.x) || 0);
    const y = Math.max(0, Number(item.y) || 0);
    const w = Math.max(1, Math.min(WIDTH - x, Number(item.w) || 40));
    const h = Math.max(1, Math.min(HEIGHT - y, Number(item.h) || w));
    const side = Math.min(w, h);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x, y, side, side);
    if (!value) return;
    if (typeof window.qrcode !== "function") {
      ctx.fillStyle = "#000";
      ctx.font = "6px monospace";
      ctx.fillText("NO QR LIB", x, y);
      return;
    }
    try {
      const qr = window.qrcode(0, "L");
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      /* Keep a four-module quiet zone so the printed code remains scannable. */
      const margin = Math.max(4, Math.ceil(side * 0.09));
      const moduleArea = Math.max(1, side - 2 * margin);
      const cell = moduleArea / count;
      ctx.fillStyle = "#000";
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) {
            const left = Math.floor(x + margin + col * cell);
            const top = Math.floor(y + margin + row * cell);
            const right = Math.ceil(x + margin + (col + 1) * cell);
            const bottom = Math.ceil(y + margin + (row + 1) * cell);
            ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
          }
        }
      }
    } catch (error) {
      ctx.fillStyle = "#000";
      ctx.font = "6px monospace";
      ctx.fillText("QR ERROR", x, y);
      log("二维码生成失败：" + error.message);
    }
  }

  function drawTableElement(item) {
    const x = Math.max(0, Number(item.x) || 0);
    const y = Math.max(0, Number(item.y) || 0);
    const w = Math.max(1, Math.min(WIDTH - x, Number(item.w) || 94));
    const h = Math.max(1, Math.min(HEIGHT - y, Number(item.h) || 54));
    const rows = String(item.content || "").split("\n").map((line) => line.split("|"));
    const cols = Math.max(1, Math.min(4, ...rows.map((row) => row.length)));
    const rowHeight = h / Math.max(1, rows.length);
    const colWidth = w / cols;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 0.7;
    ctx.strokeRect(x + 0.3, y + 0.3, Math.max(0, w - 0.6), Math.max(0, h - 0.6));
    for (let r = 1; r < rows.length; r++) {
      ctx.beginPath();
      ctx.moveTo(x, y + r * rowHeight);
      ctx.lineTo(x + w, y + r * rowHeight);
      ctx.stroke();
    }
    for (let c = 1; c < cols; c++) {
      ctx.beginPath();
      ctx.moveTo(x + c * colWidth, y);
      ctx.lineTo(x + c * colWidth, y + h);
      ctx.stroke();
    }
    ctx.fillStyle = "#000";
    ctx.textBaseline = "middle";
    ctx.font = (item.size > 1 ? 7 : 6) + "px monospace";
    rows.forEach((row, ri) => {
      for (let ci = 0; ci < cols; ci++) {
        const value = String(row[ci] || "");
        ctx.fillText(value, x + ci * colWidth + 2, y + ri * rowHeight + rowHeight / 2, Math.max(1, colWidth - 3));
      }
    });
  }

  function drawInfoElement(item) {
    const x = Math.max(0, Number(item.x) || 0);
    const y = Math.max(0, Number(item.y) || 0);
    const lines = [
      "BUG-TAGS / M3N",
      "CC2640R2F  FW 0.3",
      connectedInfo.model || "STELLAR M3N"
    ];
    ctx.fillStyle = "#000";
    ctx.textBaseline = "top";
    ctx.font = "6px monospace";
    lines.forEach((line, index) => ctx.fillText(line, x, y + index * 8, Number(item.w) || 94));
  }

  function renderPreview() {
    const page = currentPage();
    if (!ctx || !page) return;
    if (page.kind === "clock") {
      drawClockPreview();
    } else {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      page.elements.forEach((item) => {
        if (item.type === "text") drawTextElement(item);
        else if (item.type === "qr") drawQrElement(item);
        else if (item.type === "table") drawTableElement(item);
        else if (item.type === "info") drawInfoElement(item);
      });
    }
    setText("preview-status", "预览：" + page.name);
    savePages();
  }

  function canvasToBitmap() {
    const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const bitmap = new Uint8Array(BUFFER_SIZE);
    bitmap.fill(0xff);
    /* Match ihope canvas2bytes(): scan logical x from right to left and
       pack each column's y=0..103 pixels into 13 MSB-first bytes. */
    for (let x = WIDTH - 1; x >= 0; x--) {
      for (let y = 0; y < HEIGHT; y++) {
        const index = (y * WIDTH + x) * 4;
        const luminance = (rgba[index] * 299 + rgba[index + 1] * 587 + rgba[index + 2] * 114) / 1000;
        if (rgba[index + 3] > 20 && luminance < 150) {
          const address = x * COLUMN_BYTES + (y >> 3);
          bitmap[address] &= ~(0x80 >> (y & 7));
        }
      }
    }
    return bitmap;
  }

  function onNotify(event) {
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
    log("Notify RX (" + bytes.length + "): " + hex);
    if (pendingNotify && bytes.length >= 2 && bytes[0] === pendingNotify.command) {
      const waiter = pendingNotify;
      pendingNotify = null;
      clearTimeout(waiter.timer);
      waiter.resolve({ command: bytes[0], status: bytes[1] });
    }
  }

  async function sendFrame(packet, timeoutMs) {
    if (!dataCharacteristic) throw new Error("FFF1 尚未连接");
    if (pendingNotify) throw new Error("上一条命令尚未收到 Notify 应答");
    const command = packet[0];
    let resolveResponse;
    let rejectResponse;
    const responsePromise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timer = setTimeout(() => {
      if (pendingNotify && pendingNotify.command === command) {
        pendingNotify = null;
        rejectResponse(new Error("命令 0x" + command.toString(16) + " 等待 Notify 超时"));
      }
    }, timeoutMs || 15000);
    pendingNotify = { command, timer, resolve: resolveResponse, reject: rejectResponse };
    try {
      const bytes = new Uint8Array(packet);
      if (dataCharacteristic.properties.writeWithoutResponse &&
          typeof dataCharacteristic.writeValueWithoutResponse === "function") {
        await dataCharacteristic.writeValueWithoutResponse(bytes);
      } else if (typeof dataCharacteristic.writeValueWithResponse === "function") {
        await dataCharacteristic.writeValueWithResponse(bytes);
      } else {
        await dataCharacteristic.writeValue(bytes);
      }
      const response = await responsePromise;
      if (response.status !== 0) {
        throw new Error("固件命令 0x" + command.toString(16) + " 返回状态 0x" + response.status.toString(16));
      }
      return response;
    } catch (error) {
      if (pendingNotify && pendingNotify.command === command) {
        clearTimeout(pendingNotify.timer);
        pendingNotify = null;
      }
      throw error;
    }
  }

  async function syncClock() {
    const now = new Date();
    await sendFrame([0xE0, now.getHours(), now.getMinutes()]);
    log("本地时间已同步：" + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0"));
  }

  async function setLed(mask) {
    await sendFrame([0xE1, Number(mask) & 0x07]);
    const names = ["OFF", "RED", "GREEN", "YELLOW", "BLUE", "MAGENTA", "CYAN", "WHITE"];
    setText("led-state", names[Number(mask) & 0x07]);
    log("RGB LED => " + names[Number(mask) & 0x07]);
  }

  async function readInfo(service) {
    for (const item of INFO_CHARS) {
      try {
        const characteristic = await service.getCharacteristic(item.uuid);
        const value = await characteristic.readValue();
        const decoded = new TextDecoder().decode(value).replace(/\0+$/g, "").trim();
        connectedInfo[item.id] = decoded;
        setText(item.id, decoded);
        log(item.label + ": " + (decoded || "(empty)"));
      } catch (error) {
        connectedInfo[item.id] = "";
        setText(item.id, "Unavailable");
        log(item.label + " not exposed (" + error.name + ").");
      }
    }
  }

  async function connect() {
    if (!("bluetooth" in navigator)) {
      el("browser-note").textContent = "Web Bluetooth 不可用。请使用支持 Web Bluetooth 的 Chromium 浏览器，并通过 HTTPS 或 localhost 打开。";
      return;
    }
    try {
      log("打开蓝牙设备选择器…");
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID, DEVICE_INFO_UUID]
      });
      device.addEventListener("gattserverdisconnected", disconnected);
      setText("device-name", device.name || "Unnamed BLE device");
      setText("device-id", device.id || "Unavailable");
      connectedInfo.name = device.name || "";
      log("已选择：" + (device.name || "Unnamed device"));

      server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      setText("service-state", SERVICE_UUID);
      dataCharacteristic = await service.getCharacteristic(DATA_UUID);
      setText("characteristic-state", DATA_UUID);
      const properties = Object.keys(dataCharacteristic.properties).filter((key) => dataCharacteristic.properties[key]);
      setText("properties-state", properties.join(", ") || "Unknown");

      if (dataCharacteristic.properties.notify || dataCharacteristic.properties.indicate) {
        dataCharacteristic.addEventListener("characteristicvaluechanged", onNotify);
        notifyListenerInstalled = true;
        await dataCharacteristic.startNotifications();
        setText("notify-state", "Enabled");
      } else {
        setText("notify-state", "Not supported");
        throw new Error("FFF1 不支持 Notify，无法安全等待每条 EPD 命令应答");
      }

      setConnected(true);
      setText("transport-state", "FFF0 / FFF1 ready");
      log("BLE 通道就绪。同步时间，并确保 RGB 默认关闭…");
      await syncClock();
      await sendFrame([0xE2, 0]); // WebUI opens on the firmware's default clock page.
      await setLed(0);

      try {
        const info = await server.getPrimaryService(DEVICE_INFO_UUID);
        await readInfo(info);
      } catch (error) {
        log("Device Information service unavailable (" + error.name + ").");
      }
      renderPreview();
    } catch (error) {
      log("连接失败：" + error.name + " — " + error.message);
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
      else {
        dataCharacteristic = null;
        server = null;
        setConnected(false);
      }
    }
  }

  function disconnected() {
    if (pendingNotify) {
      clearTimeout(pendingNotify.timer);
      pendingNotify.reject(new Error("BLE 已断开"));
      pendingNotify = null;
    }
    if (dataCharacteristic && notifyListenerInstalled) {
      dataCharacteristic.removeEventListener("characteristicvaluechanged", onNotify);
    }
    notifyListenerInstalled = false;
    dataCharacteristic = null;
    server = null;
    setConnected(false);
    setText("transport-state", "Disconnected");
    setText("notify-state", "—");
    setText("led-state", "设备断开");
    log("GATT disconnected.");
  }

  async function disconnect() {
    if (dataCharacteristic && device && device.gatt && device.gatt.connected) {
      try {
        await setLed(0);
      } catch (error) {
        log("断开前关闭 LED 失败：" + error.message);
      }
      device.gatt.disconnect();
    } else if (device && device.gatt && device.gatt.connected) {
      device.gatt.disconnect();
    } else {
      disconnected();
    }
  }

  async function showClock() {
    if (!dataCharacteristic) return;
    setBusy(true);
    try {
      await sendFrame([0xE2, 0]);
      log("已切回固件实时钟页面。");
    } catch (error) {
      log("切换时钟失败：" + error.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendCustomPage() {
    const bitmap = canvasToBitmap();
    const redPlane = new Uint8Array(BUFFER_SIZE);
    redPlane.fill(0x00);

    await sendFrame([0xE2, 1]);
    await sendFrame([0x00, 1]);
    await sendFrame([0x04]);

    for (let offset = 0; offset < bitmap.length; offset += CHUNK_SIZE) {
      const part = bitmap.subarray(offset, Math.min(bitmap.length, offset + CHUNK_SIZE));
      const packet = new Uint8Array(part.length + 1);
      packet[0] = 0x02;
      packet.set(part, 1);
      await sendFrame(packet);
      el("preview-status").textContent = "发送黑色层 " + Math.min(offset + part.length, bitmap.length) + "/" + bitmap.length;
    }

    await sendFrame([0x05]);
    for (let offset = 0; offset < redPlane.length; offset += CHUNK_SIZE) {
      const part = redPlane.subarray(offset, Math.min(redPlane.length, offset + CHUNK_SIZE));
      const packet = new Uint8Array(part.length + 1);
      packet[0] = 0x02;
      packet.set(part, 1);
      await sendFrame(packet);
      el("preview-status").textContent = "发送红色层 " + Math.min(offset + part.length, redPlane.length) + "/" + redPlane.length;
    }

    await sendFrame([0x03], 90000);
    log("自定义页面已发送并刷新。");
  }

  async function sendCurrentScreen() {
    if (!dataCharacteristic || sendBusy) return;
    setBusy(true);
    try {
      if (currentPage().kind === "clock") {
        await sendFrame([0xE2, 0]);
        log("已显示固件实时钟。");
      } else {
        await sendCustomPage();
      }
    } catch (error) {
      log("发送屏幕失败：" + error.message);
    } finally {
      setBusy(false);
      renderPreview();
    }
  }

  function addPage() {
    const index = pages.filter((page) => page.kind === "custom").length + 1;
    const id = "page-" + Date.now();
    pages.push({
      id: id, name: "Page " + index, kind: "custom",
      elements: [{ id: "text-" + Date.now(), type: "text", x: 8, y: 8, w: 130, h: 24, size: 2, content: "Hello BUG-Tags" }]
    });
    activePageId = id;
    selectedElementId = null;
    renderPageSelect();
    renderPreview();
  }

  function addElement() {
    const page = currentPage();
    if (page.kind !== "custom") {
      alert("Clock 是固件内置页面。请先新建一个自定义页面。");
      return;
    }
    const type = el("element-type").value;
    const id = type + "-" + Date.now();
    const defaults = {
      text: { x: 8, y: 8, w: 130, h: 24, size: 2, content: "自定义文字" },
      qr: { x: 160, y: 7, w: 44, h: 44, size: 1, content: "https://example.com" },
      table: { x: 8, y: 60, w: 124, h: 36, size: 1, content: "项目|内容\n型号|M3N\n版本|0.3" },
      info: { x: 140, y: 60, w: 64, h: 36, size: 1, content: "" }
    };
    page.elements.push(Object.assign({ id: id, type: type }, defaults[type]));
    selectedElementId = id;
    renderElementSelect();
    renderPreview();
  }

  function saveElement() {
    const item = selectedElement();
    const page = currentPage();
    if (!item || page.kind !== "custom") return;
    const number = (id, fallback, min, max) => {
      const value = Number.parseInt(el(id).value, 10);
      return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    };
    item.content = el("element-content").value;
    item.x = number("element-x", item.x, 0, WIDTH - 1);
    item.y = number("element-y", item.y, 0, HEIGHT - 1);
    item.w = number("element-width", item.w, 1, WIDTH);
    item.h = number("element-height", item.h, 1, HEIGHT);
    item.size = number("element-size", item.size || 1, 1, 3);
    page.name = el("page-name").value.trim() || page.name;
    renderPageSelect();
    renderPreview();
  }

  function deleteSelectedElement() {
    const page = currentPage();
    if (page.kind !== "custom" || !selectedElementId) return;
    page.elements = page.elements.filter((item) => item.id !== selectedElementId);
    selectedElementId = null;
    renderElementSelect();
    renderPreview();
  }

  function deletePage() {
    const page = currentPage();
    if (page.kind === "clock") return;
    pages = pages.filter((item) => item.id !== page.id);
    activePageId = "clock";
    selectedElementId = null;
    renderPageSelect();
    renderPreview();
  }

  function updateCurrentTime() {
    const now = new Date();
    el("current-time").textContent = formatTime(now);
    if (currentPage() && currentPage().kind === "clock") {
      drawClockPreview();
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    renderPageSelect();
    renderPreview();
    updateCurrentTime();
    window.setInterval(updateCurrentTime, 1000);

    el("connect").addEventListener("click", connect);
    el("disconnect").addEventListener("click", disconnect);
    el("clear-log").addEventListener("click", () => { el("log").textContent = ""; });
    el("page-select").addEventListener("change", (event) => {
      activePageId = event.target.value;
      selectedElementId = null;
      renderPageSelect();
      renderPreview();
    });
    el("page-name").addEventListener("change", () => {
      const page = currentPage();
      if (page.kind === "custom") {
        page.name = el("page-name").value.trim() || page.name;
        renderPageSelect();
        renderPreview();
      }
    });
    el("add-page").addEventListener("click", addPage);
    el("delete-page").addEventListener("click", deletePage);
    el("add-element").addEventListener("click", addElement);
    el("element-select").addEventListener("change", (event) => {
      selectedElementId = event.target.value || null;
      loadSelectedElement();
    });
    el("save-element").addEventListener("click", saveElement);
    el("delete-element").addEventListener("click", deleteSelectedElement);
    el("send-screen").addEventListener("click", sendCurrentScreen);
    el("show-clock").addEventListener("click", showClock);
    el("apply-led").addEventListener("click", async () => {
      if (!dataCharacteristic) return;
      try {
        await setLed(el("led-color").value);
      } catch (error) {
        log("LED 控制失败：" + error.message);
      }
    });

    if (!("bluetooth" in navigator)) {
      el("browser-note").textContent = "Web Bluetooth 需要支持的 Chromium 浏览器，并通过安全来源 HTTPS / localhost 打开。";
    } else {
      el("browser-note").textContent = "准备就绪。连接标签后会自动同步时间，RGB 灯保持关闭。";
    }
  });
})();
