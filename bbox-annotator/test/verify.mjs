/**
 * 浏览器验证 bbox-annotator/index.html。
 * 不随工具分发。运行示例：
 *   PUPPETEER_CORE=/path/to/puppeteer-core node bbox-annotator/test/verify.mjs
 *   PUPPETEER_CORE=/path/to/puppeteer-core node bbox-annotator/test/verify.mjs --diagnose /path/to/original.html
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || "puppeteer-core");

const diagnose = process.argv[2] === "--diagnose";
const htmlPath = path.resolve(diagnose ? process.argv[3] : path.join(import.meta.dirname, "../index.html"));
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function writePng(file, w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(file, png);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--force-device-scale-factor=1",
      "--window-size=1440,900",
    ],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const dialogs = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  page.on("pageerror", (err) => console.error("PAGEERROR", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("CONSOLE", msg.text());
  });
  await page.evaluateOnNewDocument(() => {
    window.__captures = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const rec = { name: this.download || "", href: this.href || "", text: null };
      window.__captures.push(rec);
      if (rec.href.startsWith("blob:")) {
        rec.pending = fetch(rec.href).then((r) => r.text()).then((t) => {
          rec.text = t;
        });
      }
      return orig.apply(this, arguments);
    };
  });
  await page.goto(pathToFileURL(htmlPath).href);
  return { browser, page, dialogs };
}

async function preview(page) {
  return page.evaluate(() => {
    const t = document.getElementById("preview").textContent;
    return t ? JSON.parse(t) : null;
  });
}

async function zoomText(page) {
  return page.$eval("#zoomLabel", (el) => el.textContent.trim());
}

async function boxCount(page) {
  const data = await preview(page);
  return data ? data.boxes.length : 0;
}

async function layout(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const wrap = document.getElementById("stageWrap");
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      aside: rect(document.querySelector("aside")),
      wrap: rect(wrap),
      side: rect(document.querySelector(".side")),
      stage: rect(document.getElementById("stage")),
      clientWidth: wrap.clientWidth,
      clientHeight: wrap.clientHeight,
      scrollW: wrap.scrollWidth,
      scrollH: wrap.scrollHeight,
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
      pixelated: document.getElementById("stage").classList.contains("pixelated"),
    };
  });
}

async function clickZoom(page, id, times) {
  for (let i = 0; i < times; i++) await page.click(id);
}

async function zoomTo(page, percent) {
  await page.click("#btnZoom100");
  const clicks = { 100: 0, 125: 1, 150: 2, 200: 3, 400: 6, 3200: 15 }[percent];
  if (clicks == null) throw new Error("unsupported zoom " + percent);
  await clickZoom(page, "#btnZoomIn", clicks);
  const label = await zoomText(page);
  if (label !== percent + "%") throw new Error("zoom label " + label + " wanted " + percent + "%");
}

async function openNamed(page, name) {
  await page.evaluate((name) => {
    const el = [...document.querySelectorAll(".file-item")].find((n) => n.querySelector(".name").textContent === name);
    if (!el) throw new Error("missing file " + name);
    el.click();
  }, name);
  await page.waitForFunction((name) => {
    try { return JSON.parse(document.getElementById("preview").textContent).image === name; }
    catch { return false; }
  }, {}, name);
}

async function imageGeom(page) {
  return page.evaluate(() => {
    const img = document.getElementById("img").getBoundingClientRect();
    const overlay = document.getElementById("overlay").getBoundingClientRect();
    const wrap = document.getElementById("stageWrap").getBoundingClientRect();
    const data = JSON.parse(document.getElementById("preview").textContent);
    return {
      img: { left: img.left, top: img.top, width: img.width, height: img.height, right: img.right, bottom: img.bottom },
      overlay: { left: overlay.left, top: overlay.top, width: overlay.width, height: overlay.height, right: overlay.right, bottom: overlay.bottom },
      wrap: { left: wrap.left, top: wrap.top, right: wrap.right, bottom: wrap.bottom },
      naturalW: data.width,
      naturalH: data.height,
    };
  });
}

function expectedBox(x0, y0, x1, y1, g) {
  const nx = (client) => Math.round(clamp((client - g.overlay.left) / g.overlay.width * g.naturalW, 0, g.naturalW));
  const ny = (client) => Math.round(clamp((client - g.overlay.top) / g.overlay.height * g.naturalH, 0, g.naturalH));
  const a = nx(x0);
  const b = ny(y0);
  const c = nx(x1);
  const d = ny(y1);
  return { x1: Math.min(a, c), y1: Math.min(b, d), x2: Math.max(a, c), y2: Math.max(b, d) };
}

async function drag(page, x0, y0, x1, y1) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
}

async function assertAligned(page) {
  const info = await page.evaluate(() => {
    const data = JSON.parse(document.getElementById("preview").textContent);
    const ir = document.getElementById("overlay").getBoundingClientRect();
    const boxes = [...document.querySelectorAll("#overlay .box")].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    return { data, ir: { left: ir.left, top: ir.top, width: ir.width, height: ir.height }, boxes };
  });
  if (info.boxes.length !== info.data.boxes.length) {
    throw new Error("dom boxes " + info.boxes.length + " preview " + info.data.boxes.length);
  }
  info.data.boxes.forEach((b, i) => {
    const x1 = b.x1 != null ? b.x1 : b.x;
    const y1 = b.y1 != null ? b.y1 : b.y;
    const x2 = b.x2 != null ? b.x2 : b.x + b.w;
    const y2 = b.y2 != null ? b.y2 : b.y + b.h;
    const predLeft = info.ir.left + x1 / info.data.width * info.ir.width;
    const predTop = info.ir.top + y1 / info.data.height * info.ir.height;
    const predRight = info.ir.left + x2 / info.data.width * info.ir.width;
    const predBottom = info.ir.top + y2 / info.data.height * info.ir.height;
    const got = info.boxes[i];
    for (const [name, delta] of [
      ["left", got.left - predLeft],
      ["top", got.top - predTop],
      ["right", got.right - predRight],
      ["bottom", got.bottom - predBottom],
    ]) {
      if (Math.abs(delta) > 1.5) throw new Error("box " + i + " " + name + " off by " + delta);
    }
  });
}

async function natAt(page, x, y) {
  return page.evaluate((x, y) => {
    const r = document.getElementById("img").getBoundingClientRect();
    const data = JSON.parse(document.getElementById("preview").textContent);
    return {
      x: (x - r.left) / r.width * data.width,
      y: (y - r.top) / r.height * data.height,
    };
  }, x, y);
}

async function captureExport(page, buttonId) {
  const before = await page.evaluate(() => window.__captures.length);
  await page.click(buttonId);
  await page.waitForFunction((n) => {
    const rec = window.__captures[n];
    return rec && typeof rec.text === "string";
  }, {}, before);
  return page.evaluate((n) => window.__captures[n], before);
}

function assertLayoutContained(info, label) {
  const problems = [];
  if (info.scrollWidth > info.innerWidth + 1) problems.push("doc scrollWidth " + info.scrollWidth);
  if (info.scrollHeight > info.innerHeight + 1) problems.push("doc scrollHeight " + info.scrollHeight);
  if (info.side.right > info.innerWidth + 1) problems.push("side.right " + info.side.right);
  if (info.aside.left < -1) problems.push("aside.left " + info.aside.left);
  if (info.wrap.left + 1 < info.aside.right) problems.push("wrap overlaps aside");
  if (info.side.left + 1 < info.wrap.right) problems.push("side overlaps wrap");
  if (info.side.width < 250) problems.push("side width " + info.side.width);
  if (problems.length) throw new Error(label + ": " + problems.join("; ") + " " + JSON.stringify(info));
}

async function diagnoseRun() {
  const dir = path.join(tmpdir(), "bbox-diagnose");
  mkdirSync(dir, { recursive: true });
  const a = path.join(dir, "a-320x240.png");
  const b = path.join(dir, "b-480x360.png");
  const c = path.join(dir, "c-200x100.png");
  writePng(a, 320, 240, [220, 60, 50]);
  writePng(b, 480, 360, [40, 90, 200]);
  writePng(c, 200, 100, [40, 160, 80]);
  const { browser, page, dialogs } = await launch();
  try {
    const input = await page.$("#fileInput");
    await input.uploadFile(a, b, c);
    await new Promise((r) => setTimeout(r, 1200));
    const listText = await page.$eval("#fileList", (el) => el.innerText);
    console.log("DIAG list:\n" + listText);
    const exp = await captureExport(page, "#btnExport");
    console.log("DIAG export " + exp.name + ":\n" + exp.text);
    await clickZoom(page, "#btnZoomIn", 15);
    const lay = await layout(page);
    console.log("DIAG layout", JSON.stringify({
      zoom: await zoomText(page),
      scrollWidth: lay.scrollWidth,
      innerWidth: lay.innerWidth,
      scrollHeight: lay.scrollHeight,
      innerHeight: lay.innerHeight,
      sideRight: lay.side.right,
      wrapClient: lay.clientWidth,
      stageWidth: lay.stage.width,
      scrollW: lay.scrollW,
    }));
    const g = await imageGeom(page);
    const x0 = Math.max(g.wrap.left, g.img.left) + 30;
    const y0 = Math.max(g.wrap.top, g.img.top) + 30;
    await drag(page, x0, y0, x0 + 80, y0 + 50);
    console.log("DIAG after draw", await boxCount(page));
    await page.keyboard.down("Space");
    await page.mouse.move(x0 + 20, y0 + 20);
    await page.mouse.down();
    await page.mouse.move(x0 - 40, y0 + 10, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    console.log("DIAG after space pan", await boxCount(page), "scroll", await page.evaluate(() => {
      const w = document.getElementById("stageWrap");
      return { l: w.scrollLeft, t: w.scrollTop };
    }));
    await page.mouse.move(x0 + 40, y0 + 40);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(x0 + 10, y0 + 70, { steps: 4 });
    await page.mouse.up({ button: "middle" });
    console.log("DIAG after middle pan", await boxCount(page));
    await page.mouse.move(x0 + 50, y0 + 40);
    await page.mouse.down();
    await page.keyboard.down("Space");
    await page.mouse.move(x0 + 130, y0 + 100, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    console.log("DIAG after down-then-space", await boxCount(page));
    console.log("DIAG dialogs", JSON.stringify(dialogs));
  } finally {
    await browser.close();
  }
}

async function verifyRun() {
  const started = Date.now();
  const notes = [];
  const dir = path.join(tmpdir(), "bbox-verify");
  mkdirSync(dir, { recursive: true });
  const files = {
    a: path.join(dir, "a-320x240.png"),
    b: path.join(dir, "b-480x360.png"),
    c: path.join(dir, "c-200x100.png"),
    d: path.join(dir, "d-1400x1000.png"),
  };
  writePng(files.a, 320, 240, [220, 60, 50]);
  writePng(files.b, 480, 360, [40, 90, 200]);
  writePng(files.c, 200, 100, [40, 160, 80]);
  writePng(files.d, 1400, 1000, [230, 180, 40]);

  const html = await import("node:fs").then((fs) => fs.readFileSync(htmlPath, "utf8"));
  if (/<script[^>]+src=/i.test(html) || /<link[^>]+href=/i.test(html) || /https?:\/\//i.test(html)) {
    throw new Error("index.html references an external resource");
  }
  console.log("PASS index.html has no external URL, stylesheet, or script");

  const readme = await import("node:fs").then((fs) => fs.readFileSync(path.join(import.meta.dirname, "../README.md"), "utf8"));
  const guide = await import("node:fs").then((fs) => fs.readFileSync(path.join(import.meta.dirname, "../使用说明.md"), "utf8"));
  for (const title of ["## 用途与适用场景", "## 功能", "## 环境要求", "## 下载与安装", "## 启动", "## 操作说明", "## 输入与输出", "## 隐私", "## 限制", "## 常见问题"]) {
    if (!readme.includes(title)) throw new Error("README missing " + title);
  }
  if (!guide.includes("README.md") || !guide.includes("index.html")) throw new Error("使用说明.md is not an entry pointer");
  if (/支持导入|可以导入已有|GitHub Pages|自动保存到浏览器/.test(readme)) {
    throw new Error("README claims unsupported persistence or features");
  }
  if (!/不使用 `localStorage`/.test(readme) || !/关闭前\*\*没有\*\*/.test(readme)) {
    throw new Error("README does not state the actual persistence limits");
  }
  console.log("PASS docs include required sections and do not claim persistence");

  const { browser, page, dialogs } = await launch();
  try {
    const input = await page.$("#fileInput");
    await input.uploadFile(files.a, files.b, files.c, files.d);
    await page.waitForFunction(() => {
      const t = document.getElementById("fileList").innerText;
      return t.includes("320×240") && t.includes("480×360") && t.includes("200×100") && t.includes("1400×1000");
    });
    const active = await page.$eval(".file-item.active .name", (el) => el.textContent);
    if (active !== "a-320x240.png") throw new Error("active image " + active);
    console.log("PASS unvisited images show decoded sizes in the list");
    await page.waitForFunction(() => {
      const r = document.getElementById("img").getBoundingClientRect();
      const t = document.getElementById("preview").textContent;
      return r.width > 100 && t.includes('"width": 320');
    });

    const empty = JSON.parse((await captureExport(page, "#btnExport")).text);
    if (empty.coord_system !== "original_image_pixels" || empty.format !== "xyxy") throw new Error("empty export header");
    const expectSizes = [
      ["a-320x240.png", 320, 240],
      ["b-480x360.png", 480, 360],
      ["c-200x100.png", 200, 100],
      ["d-1400x1000.png", 1400, 1000],
    ];
    if (empty.images.length !== 4) throw new Error("image count " + empty.images.length);
    empty.images.forEach((im, i) => {
      const [name, w, h] = expectSizes[i];
      if (im.image !== name || im.width !== w || im.height !== h || im.boxes.length !== 0) {
        throw new Error("empty image mismatch " + JSON.stringify(im));
      }
    });
    console.log("PASS export of four images with no boxes has real sizes, including unvisited c and d");

    const emptyCsv = (await captureExport(page, "#btnExportCsv")).text;
    if (!emptyCsv.startsWith("image,width,height,box_index,x1,y1,x2,y2\n")) throw new Error("csv header " + emptyCsv.split("\n")[0]);
    if (!emptyCsv.includes('"c-200x100.png",200,100,,,,,')) throw new Error("csv missing empty c row: " + emptyCsv);
    if (!emptyCsv.includes('"d-1400x1000.png",1400,1000,,,,,')) throw new Error("csv missing empty d row");
    console.log("PASS csv lists images without boxes and does not write width 0");

    if ((await zoomText(page)) !== "100%") throw new Error("initial zoom " + await zoomText(page));
    let g = await imageGeom(page);
    if (Math.abs(g.img.left - g.overlay.left) > 1 || Math.abs(g.img.width - g.overlay.width) > 1) {
      throw new Error("overlay/image mismatch " + JSON.stringify(g));
    }
    const baseA = { x: g.overlay.left + 40, y: g.overlay.top + 36 };
    const baseB = { x: g.overlay.left + 150, y: g.overlay.top + 40 };
    await drag(page, baseA.x, baseA.y, baseA.x + 90, baseA.y + 48);
    await drag(page, baseB.x, baseB.y, baseB.x + 70, baseB.y + 36);
    g = await imageGeom(page);
    const want = [
      expectedBox(baseA.x, baseA.y, baseA.x + 90, baseA.y + 48, g),
      expectedBox(baseB.x, baseB.y, baseB.x + 70, baseB.y + 36, g),
    ];
    let shot = await preview(page);
    if (JSON.stringify(shot.boxes) !== JSON.stringify(want)) {
      throw new Error("draw mismatch got " + JSON.stringify(shot.boxes) + " want " + JSON.stringify(want));
    }
    console.log("PASS two boxes at 100% match original-image geometry", JSON.stringify(want));
    const frozen = JSON.stringify(shot.boxes);

    await zoomTo(page, 400);
    shot = await preview(page);
    if (JSON.stringify(shot.boxes) !== frozen) throw new Error("boxes changed after zoom " + JSON.stringify(shot.boxes));
    if (!(await page.$eval("#stage", (el) => el.classList.contains("pixelated")))) throw new Error("400% should be pixelated");
    await assertAligned(page);
    let lay = await layout(page);
    assertLayoutContained(lay, "400%");
    if (!(lay.scrollW > lay.clientWidth + 20)) throw new Error("expected internal horizontal scroll at 400%");
    console.log("PASS 400% keeps stored boxes, aligns them, pixelates, and scrolls inside the grid", JSON.stringify({
      scrollW: lay.scrollW, clientWidth: lay.clientWidth, sideRight: Math.round(lay.side.right), docW: lay.scrollWidth,
    }));

    const scrollBefore = await page.evaluate(() => ({
      l: document.getElementById("stageWrap").scrollLeft,
      t: document.getElementById("stageWrap").scrollTop,
    }));
    g = await imageGeom(page);
    const panX = Math.min(g.wrap.right - 40, g.img.right - 20);
    const panY = Math.min(g.wrap.bottom - 40, g.img.bottom - 20);
    await page.keyboard.down("Space");
    await page.mouse.move(panX, panY);
    await page.mouse.down();
    await page.mouse.move(panX - 90, panY - 50, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    const scrollAfter = await page.evaluate(() => ({
      l: document.getElementById("stageWrap").scrollLeft,
      t: document.getElementById("stageWrap").scrollTop,
    }));
    if (await boxCount(page) !== 2) throw new Error("space pan created a box");
    if (scrollAfter.l < scrollBefore.l + 50) throw new Error("space pan did not scroll " + JSON.stringify({ scrollBefore, scrollAfter }));
    shot = await preview(page);
    if (JSON.stringify(shot.boxes) !== frozen) throw new Error("boxes changed after space pan");
    await assertAligned(page);
    console.log("PASS space pan scrolls and does not add or move stored boxes", JSON.stringify({ scrollBefore, scrollAfter }));

    const beforeWheel = await natAt(page, 720, 430);
    const zoomBeforeWheel = await zoomText(page);
    await page.mouse.move(720, 430);
    await page.keyboard.down("Control");
    await page.mouse.wheel({ deltaY: -120 });
    await page.keyboard.up("Control");
    const afterWheel = await natAt(page, 720, 430);
    const zoomAfterWheel = await zoomText(page);
    const anchorDx = Math.abs(afterWheel.x - beforeWheel.x);
    const anchorDy = Math.abs(afterWheel.y - beforeWheel.y);
    notes.push({ anchorDx, anchorDy, zoomBeforeWheel, zoomAfterWheel, beforeWheel, afterWheel });
    if (zoomAfterWheel === zoomBeforeWheel) throw new Error("ctrl+wheel did not zoom");
    if (anchorDx > 1.5 || anchorDy > 1.5) {
      throw new Error("anchor drift " + JSON.stringify({ anchorDx, anchorDy, beforeWheel, afterWheel, zoomAfterWheel }));
    }
    shot = await preview(page);
    if (JSON.stringify(shot.boxes) !== frozen) throw new Error("boxes changed after wheel zoom");
    console.log("PASS ctrl+wheel zooms around the pointer without changing stored boxes", JSON.stringify({
      zoomBeforeWheel, zoomAfterWheel, anchorDx, anchorDy,
    }));

    await zoomTo(page, 400);
    const countBeforeMiddle = await boxCount(page);
    g = await imageGeom(page);
    const mx = Math.min(g.wrap.right - 80, Math.max(g.wrap.left + 80, g.img.left + 80));
    const my = Math.min(g.wrap.bottom - 80, Math.max(g.wrap.top + 80, g.img.top + 80));
    await page.mouse.move(mx, my);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(mx - 40, my + 30, { steps: 4 });
    await page.mouse.up({ button: "middle" });
    if (await boxCount(page) !== countBeforeMiddle) throw new Error("middle pan drew a box");
    console.log("PASS middle-button pan does not draw");

    await page.keyboard.down("Alt");
    await page.mouse.move(mx + 20, my);
    await page.mouse.down();
    await page.mouse.move(mx - 30, my + 20, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    if (await boxCount(page) !== countBeforeMiddle) throw new Error("alt pan drew a box");
    console.log("PASS alt pan does not draw");

    await page.mouse.move(mx, my);
    await page.mouse.down();
    await page.keyboard.down("Space");
    await page.mouse.move(mx + 100, my + 70, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    if (await boxCount(page) !== countBeforeMiddle) throw new Error("space during draw still created a box");
    shot = await preview(page);
    if (JSON.stringify(shot.boxes) !== frozen) throw new Error("stored boxes changed while cancelling a draw");
    console.log("PASS pressing space during a drag cancels the box and does not commit it");

    await zoomTo(page, 400);
    g = await imageGeom(page);
    const visLeft = Math.max(g.img.left, g.wrap.left) + 24;
    const visTop = Math.max(g.img.top, g.wrap.top) + 24;
    const visRight = Math.min(g.img.right, g.wrap.right) - 24;
    const visBottom = Math.min(g.img.bottom, g.wrap.bottom) - 24;
    if (visRight - visLeft < 140 || visBottom - visTop < 80) throw new Error("visible area too small " + JSON.stringify(g));
    const nx0 = visLeft + 20;
    const ny0 = visTop + 16;
    const nx1 = nx0 + 120;
    const ny1 = ny0 + 64;
    await drag(page, nx0, ny0, nx1, ny1);
    g = await imageGeom(page);
    const neu = expectedBox(nx0, ny0, nx1, ny1, g);
    shot = await preview(page);
    const gotNew = shot.boxes[shot.boxes.length - 1];
    if (JSON.stringify(gotNew) !== JSON.stringify(neu)) {
      throw new Error("new box after zoom/pan got " + JSON.stringify(gotNew) + " want " + JSON.stringify(neu));
    }
    if (JSON.stringify(shot.boxes.slice(0, 2)) !== frozen) throw new Error("old boxes changed when adding a new one");
    await assertAligned(page);
    console.log("PASS new box after zoom and pan matches original pixels", JSON.stringify(neu));
    const three = JSON.stringify(shot.boxes);

    const plainBefore = await zoomText(page);
    const plainScroll = (await layout(page)).scrollTop;
    await page.mouse.move(720, 430);
    await page.mouse.wheel({ deltaY: 100 });
    if ((await zoomText(page)) !== plainBefore) throw new Error("plain wheel changed zoom");
    const plainScrollAfter = (await layout(page)).scrollTop;
    console.log("PASS plain wheel does not change zoom", JSON.stringify({ plainScroll, plainScrollAfter, plainBefore }));

    await clickZoom(page, "#btnZoomIn", 12);
    lay = await layout(page);
    assertLayoutContained(lay, "max zoom");
    if ((await zoomText(page)) !== "3200%") throw new Error("max zoom label " + await zoomText(page));
    if (!(lay.scrollW > lay.clientWidth + 100)) throw new Error("max zoom did not overflow inside wrap");
    shot = await preview(page);
    if (JSON.stringify(shot.boxes) !== three) throw new Error("boxes changed at max zoom");
    await assertAligned(page);
    console.log("PASS 3200% stays inside the middle grid", JSON.stringify({
      docW: lay.scrollWidth, innerW: lay.innerWidth, sideRight: Math.round(lay.side.right),
      wrapClient: lay.clientWidth, stage: Math.round(lay.stage.width), scrollW: lay.scrollW,
    }));
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    await page.screenshot({ path: "/opt/cursor/artifacts/bbox-max-zoom.png" });

    await page.click("#btnZoom100");
    if ((await zoomText(page)) !== "100%") throw new Error("1:1 label " + await zoomText(page));
    if (await page.$eval("#stage", (el) => el.classList.contains("pixelated"))) throw new Error("100% should not be pixelated");
    shot = await preview(page);
    if (JSON.stringify(shot.boxes) !== three) throw new Error("boxes changed at 1:1");

    await page.click("#btnZoomIn");
    await page.click("#btnZoomFit");
    if ((await zoomText(page)) !== "100%") throw new Error("fit of small image " + await zoomText(page));
    lay = await layout(page);
    if (lay.scrollLeft !== 0 || lay.scrollTop !== 0) throw new Error("fit did not reset scroll " + JSON.stringify(lay));
    console.log("PASS 1:1 and fit restore 100% for the small image and keep box values");

    const zoomKeyBefore = await zoomText(page);
    await page.keyboard.down("Control");
    await page.keyboard.press("Equal");
    await page.keyboard.up("Control");
    const zoomKeyAfter = await zoomText(page);
    notes.push({ ctrlEqualBefore: zoomKeyBefore, ctrlEqualAfter: zoomKeyAfter });
    console.log("INFO Ctrl+= zoom", zoomKeyBefore, "->", zoomKeyAfter);

    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => {
      try { return JSON.parse(document.getElementById("preview").textContent).image === "b-480x360.png"; }
      catch { return false; }
    });
    if ((await preview(page)).boxes.length !== 0) throw new Error("image b should start empty");
    g = await imageGeom(page);
    await drag(page, g.overlay.left + 30, g.overlay.top + 28, g.overlay.left + 120, g.overlay.top + 80);
    await drag(page, g.overlay.left + 140, g.overlay.top + 40, g.overlay.left + 210, g.overlay.top + 100);
    if ((await preview(page)).boxes.length !== 2) throw new Error("expected two boxes on b");
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
    let bShot = await preview(page);
    if (bShot.boxes.length !== 1) throw new Error("Ctrl+Z should remove the selected box, got " + bShot.boxes.length);
    await page.keyboard.press("Delete");
    bShot = await preview(page);
    if (bShot.boxes.length !== 0) throw new Error("Delete should remove the last box");
    g = await imageGeom(page);
    const b0 = g.overlay.left + 36;
    const b1y = g.overlay.top + 32;
    await drag(page, b0, b1y, b0 + 100, b1y + 60);
    g = await imageGeom(page);
    const bWant = expectedBox(b0, b1y, b0 + 100, b1y + 60, g);
    bShot = await preview(page);
    if (JSON.stringify(bShot.boxes) !== JSON.stringify([bWant])) {
      throw new Error("b box mismatch " + JSON.stringify(bShot.boxes) + " vs " + JSON.stringify(bWant));
    }
    console.log("PASS switch to b, Ctrl+Z and Delete remove boxes, redraw survives", JSON.stringify(bWant));

    await openNamed(page, "a-320x240.png");
    shot = await preview(page);
    if (JSON.stringify(shot.boxes) !== three) throw new Error("image a lost boxes after switching " + JSON.stringify(shot.boxes));
    console.log("PASS switching back to a keeps all three boxes");
    await page.screenshot({ path: "/opt/cursor/artifacts/bbox-boxes.png" });

    const full = JSON.parse((await captureExport(page, "#btnExport")).text);
    if (full.images.map((im) => im.image).join() !== expectSizes.map((x) => x[0]).join()) {
      throw new Error("export order " + full.images.map((im) => im.image).join());
    }
    full.images.forEach((im, i) => {
      if (im.width !== expectSizes[i][1] || im.height !== expectSizes[i][2]) {
        throw new Error("size drifted " + JSON.stringify(im));
      }
    });
    if (JSON.stringify(full.images[0].boxes) !== three) throw new Error("export a boxes differ");
    if (JSON.stringify(full.images[1].boxes) !== JSON.stringify([bWant])) throw new Error("export b boxes differ");
    if (full.images[2].boxes.length !== 0 || full.images[3].boxes.length !== 0) throw new Error("c/d should have no boxes");
    if (full.images[2].width !== 200 || full.images[3].width !== 1400) throw new Error("unvisited-at-first sizes lost");
    console.log("PASS xyxy export matches every image and box");

    await page.select("#coordMode", "xywh");
    const xywh = JSON.parse((await captureExport(page, "#btnExport")).text);
    if (xywh.format !== "xywh") throw new Error("format " + xywh.format);
    const xywhA = JSON.parse(three).map((b) => ({ x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 }));
    if (JSON.stringify(xywh.images[0].boxes) !== JSON.stringify(xywhA)) {
      throw new Error("xywh a " + JSON.stringify(xywh.images[0].boxes));
    }
    const xywhB = { x: bWant.x1, y: bWant.y1, w: bWant.x2 - bWant.x1, h: bWant.y2 - bWant.y1 };
    if (JSON.stringify(xywh.images[1].boxes) !== JSON.stringify([xywhB])) throw new Error("xywh b mismatch");
    const xywhCsv = (await captureExport(page, "#btnExportCsv")).text;
    if (!xywhCsv.startsWith("image,width,height,box_index,x,y,w,h\n")) throw new Error("xywh header");
    const bRow = `"b-480x360.png",480,360,1,${xywhB.x},${xywhB.y},${xywhB.w},${xywhB.h}`;
    if (!xywhCsv.includes(bRow)) throw new Error("csv row missing " + bRow + "\n" + xywhCsv);
    if (!xywhCsv.includes('"c-200x100.png",200,100,,,,,')) throw new Error("xywh csv dropped empty image");
    console.log("PASS xywh json and csv match xyxy edges");

    await openNamed(page, "d-1400x1000.png");
    const fitLabel = await zoomText(page);
    const fitPct = Number(fitLabel.replace("%", ""));
    lay = await layout(page);
    if (!(fitPct > 5 && fitPct < 100)) throw new Error("large image fit percent " + fitLabel);
    if (lay.stage.width > lay.clientWidth + 1 || lay.stage.height > lay.clientHeight + 1) {
      throw new Error("fit image escapes wrap " + JSON.stringify({ stage: lay.stage, client: [lay.clientWidth, lay.clientHeight] }));
    }
    assertLayoutContained(lay, "fit large");
    console.log("PASS fit on a 1400×1000 image stays below 100% and inside the grid", fitLabel);

    await page.reload({ waitUntil: "load" });
    const afterReload = await page.$eval("#fileList", (el) => el.innerText);
    if (afterReload.includes("a-320x240") || afterReload.includes("320×240")) {
      throw new Error("data survived reload: " + afterReload);
    }
    console.log("PASS reload drops in-memory images and boxes");
    if (dialogs.length) throw new Error("unexpected dialogs " + JSON.stringify(dialogs));
    console.log("NOTES", JSON.stringify(notes));
    console.log("DONE in " + (Date.now() - started) + "ms");
  } catch (err) {
    mkdirSync("/tmp/bbox-verify", { recursive: true });
    await page.screenshot({ path: "/tmp/bbox-verify/fail.png" }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

if (diagnose) {
  diagnoseRun().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  verifyRun().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
