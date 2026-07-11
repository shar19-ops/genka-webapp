pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.js';

const STORAGE_INDEX_KEY = 'genka:index';
const STORAGE_PROJECT_PREFIX = 'genka:project:';

let currentProject = null;
let pendingParseResult = null; // インポートプレビュー中のデータ
let reimportTargetKoban = null; // 既存工番への再取込の場合にセット

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function yen(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return Number(n).toLocaleString('ja-JP');
}

// 粗利率表示: 小数点第2位以下は切り捨て、小数点第1位までを%で表示する
function formatRate(rate) {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '-';
  const truncated = Math.floor(rate * 10) / 10;
  return truncated.toFixed(1) + '%';
}

function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------- 検印欄（デート印） ----------------
const STAMP_SLOT_COUNT = 6;
const STAMP_TITLES = ['', '副長', '課長', '工事長', '支店長', '部長', '本部長', '取締役', '常務', '本店長'];
const STAMP_TITLE_COLOR = {
  '': 'black', '副長': 'black', '課長': 'black',
  '工事長': 'red', '支店長': 'red', '部長': 'red', '本部長': 'red', '取締役': 'red', '常務': 'red', '本店長': 'red',
};
// 入力欄の表示専用ラベル（出力側の判子欄は従来通りラベルなし）
// 上段(欄1〜3)=担当者/確認1/確認2、下段(欄4〜6)=確認3/確認4/承認
const STAMP_SLOT_LABELS = ['担当者', '確認1', '確認2', '確認3', '確認4', '承認'];

function newStampSlot() { return { name: '', title: '', date: '' }; }

function ensureStampSlots() {
  const prev = Array.isArray(currentProject.stampSlots) ? currentProject.stampSlots : [];
  currentProject.stampSlots = Array.from({ length: STAMP_SLOT_COUNT }, (_, i) => prev[i] || newStampSlot());
}

// ---- 検印フロー（押印の順番ロック） ----
// stage: 次に入力できる欄のインデックス(0=担当者, 1〜4=確認, 5=承認, 6=すべて完了)。
// stage未満の欄は「押印済み・編集不可」、stageより大きい欄は「未解放・編集不可」。
// skipped: 承認へ早めに進んだ際、使わなかった確認欄のインデックス一覧（空欄のまま固定）。
// ログイン機構がないため「本人以外は物理的に押せない」までは強制できないが、通常の画面操作では
// 直前の欄を保存しない限り次の欄が入力できないようにする（うっかり順番間違い防止が目的）。
function ensureStampFlow() {
  if (currentProject.stampFlow && typeof currentProject.stampFlow.stage === 'number') return;
  // 旧データ（フロー導入前に自由入力されていたもの）からの簡易移行:
  // 先頭から連続して入力済みの欄までを「押印済み」とみなす。
  const slots = currentProject.stampSlots;
  let stage = 0;
  while (stage < STAMP_SLOT_COUNT && (slots[stage]?.name || '').trim()) stage++;
  currentProject.stampFlow = { stage, skipped: [] };
}

function stampSlotState(i) {
  const flow = currentProject.stampFlow;
  if (flow.skipped.includes(i)) return 'skipped';
  if (i < flow.stage) return 'done';
  if (i === flow.stage) return 'active';
  return 'locked';
}

// 指定した段より前で、直近の「実際に使われた（スキップされていない）」段のインデックスを返す。無ければ-1。
function prevRealStage(stage) {
  const flow = currentProject.stampFlow;
  for (let i = stage - 1; i >= 0; i--) {
    if (!flow.skipped.includes(i)) return i;
  }
  return -1;
}

function advanceStampFlow(action) {
  const flow = currentProject.stampFlow;
  if (action === 'toConfirm') {
    flow.stage = 1;
  } else if (action === 'addConfirm') {
    flow.stage = Math.min(flow.stage + 1, 4);
  } else if (action === 'toApproval') {
    for (let i = flow.stage + 1; i <= 4; i++) if (!flow.skipped.includes(i)) flow.skipped.push(i);
    flow.stage = 5;
  } else if (action === 'finish') {
    flow.stage = 6;
  } else if (action === 'reject') {
    const p = prevRealStage(flow.stage);
    if (p < 0) return; // 担当者より前には戻せない
    // 差し戻し先・差し戻し元とも押印データはクリアして再入力を求める
    if (flow.stage < STAMP_SLOT_COUNT) currentProject.stampSlots[flow.stage] = newStampSlot();
    currentProject.stampSlots[p] = newStampSlot();
    flow.skipped = flow.skipped.filter((i) => i < p);
    flow.stage = p;
  }
  saveProject(currentProject);
  $('#saveStatus').textContent = '保存しました（' + new Date().toLocaleTimeString('ja-JP') + '）';
  renderStampInputs();
  renderStampBoxes();
}

function refreshStampAdvanceButtons() {
  const flow = currentProject.stampFlow;
  const activeName = (currentProject.stampSlots[flow.stage]?.name || '').trim();
  $$('#stampFlowActions button').forEach((btn) => {
    if (btn.id === 'stampRejectBtn') return; // 差し戻しは自分の欄が未入力でも常に押せる
    if (btn.id === 'stampAddConfirmBtn') btn.disabled = !activeName || flow.stage >= 4;
    else btn.disabled = !activeName;
  });
}

function rejectButtonHtml(stage) {
  const p = prevRealStage(stage);
  if (p < 0) return '';
  return `<button type="button" class="btn danger" id="stampRejectBtn">差し戻す（${STAMP_SLOT_LABELS[p]}へ）</button>`;
}

function renderStampFlowActions() {
  const area = $('#stampFlowActions');
  if (!area) return;
  const flow = currentProject.stampFlow;
  const stage = flow.stage;
  const activeName = (currentProject.stampSlots[stage]?.name || '').trim();

  if (stage >= STAMP_SLOT_COUNT) {
    area.innerHTML = `${rejectButtonHtml(STAMP_SLOT_COUNT)}<p class="stamp-flow-done">✓ すべての検印が完了しました</p>`;
    $('#stampRejectBtn')?.addEventListener('click', () => advanceStampFlow('reject'));
    return;
  }
  if (stage === 0) {
    area.innerHTML = `<button type="button" class="btn" id="stampAdvanceBtn" ${activeName ? '' : 'disabled'}>確認者へ提出</button>`;
    $('#stampAdvanceBtn').addEventListener('click', () => advanceStampFlow('toConfirm'));
    return;
  }
  if (stage >= 1 && stage <= 4) {
    const canAddMore = stage < 4;
    area.innerHTML = `
      ${rejectButtonHtml(stage)}
      <button type="button" class="btn" id="stampAddConfirmBtn" ${activeName && canAddMore ? '' : 'disabled'}>確認者へ提出</button>
      <button type="button" class="btn primary" id="stampToApprovalBtn" ${activeName ? '' : 'disabled'}>承認者へ提出</button>`;
    $('#stampAddConfirmBtn').addEventListener('click', () => advanceStampFlow('addConfirm'));
    $('#stampToApprovalBtn').addEventListener('click', () => advanceStampFlow('toApproval'));
    $('#stampRejectBtn')?.addEventListener('click', () => advanceStampFlow('reject'));
    return;
  }
  if (stage === 5) {
    area.innerHTML = `
      ${rejectButtonHtml(stage)}
      <button type="button" class="btn primary" id="stampFinishBtn" ${activeName ? '' : 'disabled'}>承認欄を保存して完了</button>`;
    $('#stampFinishBtn').addEventListener('click', () => advanceStampFlow('finish'));
    $('#stampRejectBtn')?.addEventListener('click', () => advanceStampFlow('reject'));
  }
}

// 役職なし: 苗字を1文字ずつ上下に自動分割。役職あり: 上段に苗字、下段に役職。
function stampNameOptions(sei, title) {
  return title ? { nameTop: sei, nameBottom: title } : { name: sei };
}

function buildStampDataUrl(slot) {
  const sei = (slot.name || '').trim();
  if (!sei) return null;
  const title = slot.title || '';
  const color = STAMP_TITLE_COLOR[title] || 'black';
  const radius = 120;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = radius * 2 + 8;
  const ctx = canvas.getContext('2d');
  DateStamp.draw(ctx, canvas.width / 2, canvas.height / 2, {
    ...stampNameOptions(sei, title),
    date: slot.date || todayIso(),
    dateFormat: 'yy-slash',
    color,
    radius,
  });
  return canvas.toDataURL('image/png');
}

// 判子欄は左から右に並ぶが、欄1が一番右・欄6が一番左になるよう対応させる
function renderStampBoxes() {
  const cells = $$('.stamp-boxes .stamp-cell');
  cells.forEach((cell, i) => {
    const slot = currentProject.stampSlots[STAMP_SLOT_COUNT - 1 - i] || newStampSlot();
    const dataUrl = buildStampDataUrl(slot);
    cell.innerHTML = dataUrl ? `<img class="stamp-img" src="${dataUrl}" alt="">` : '';
  });
}

const STAMP_STATE_BADGE = {
  done: '<span class="stamp-state-badge done">押印済み</span>',
  locked: '<span class="stamp-state-badge locked">🔒未解放</span>',
  skipped: '<span class="stamp-state-badge skipped">未使用</span>',
  active: '',
};

function renderStampInputs() {
  ensureStampSlots();
  ensureStampFlow();
  const grid = $('#stampInputGrid');
  grid.innerHTML = currentProject.stampSlots.map((slot, i) => {
    const state = stampSlotState(i);
    const disabled = state !== 'active';
    return `
    <div class="stamp-input-row state-${state}">
      <span class="stamp-input-idx">${STAMP_SLOT_LABELS[i]}${STAMP_STATE_BADGE[state]}</span>
      <input type="text" class="stamp-name-input" data-idx="${i}" maxlength="10" placeholder="苗字" value="${escapeHtml(slot.name || '')}" ${disabled ? 'disabled' : ''}>
      <select class="stamp-title-select" data-idx="${i}" ${disabled ? 'disabled' : ''}>
        ${STAMP_TITLES.map((t) => `<option value="${t}" ${slot.title === t ? 'selected' : ''}>${t || '（なし）'}</option>`).join('')}
      </select>
      <input type="date" class="stamp-date-input" data-idx="${i}" value="${slot.date || ''}" ${disabled ? 'disabled' : ''}>
    </div>`;
  }).join('');

  $$('.stamp-name-input', grid).forEach((input) => {
    input.addEventListener('input', () => {
      currentProject.stampSlots[Number(input.dataset.idx)].name = input.value;
      renderStampBoxes();
      refreshStampAdvanceButtons();
      scheduleAutosave();
    });
  });
  $$('.stamp-title-select', grid).forEach((sel) => {
    sel.addEventListener('change', () => {
      currentProject.stampSlots[Number(sel.dataset.idx)].title = sel.value;
      renderStampBoxes();
      scheduleAutosave();
    });
  });
  $$('.stamp-date-input', grid).forEach((input) => {
    input.addEventListener('input', () => {
      currentProject.stampSlots[Number(input.dataset.idx)].date = input.value;
      renderStampBoxes();
      scheduleAutosave();
    });
  });

  renderStampFlowActions();
}

// ---------------- localStorage 永続化 ----------------
function loadIndex() {
  try { return JSON.parse(localStorage.getItem(STORAGE_INDEX_KEY)) || []; }
  catch { return []; }
}
function saveIndex(list) {
  localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(list));
}
function loadProject(koban) {
  try { return JSON.parse(localStorage.getItem(STORAGE_PROJECT_PREFIX + koban)); }
  catch { return null; }
}
function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_PROJECT_PREFIX + project.koban, JSON.stringify(project));
  const idx = loadIndex();
  const existing = idx.findIndex((p) => p.koban === project.koban);
  const entry = { koban: project.koban, kenmei: project.kenmei, tokuisaki: project.tokuisaki, updatedAt: project.updatedAt };
  if (existing >= 0) idx[existing] = entry; else idx.push(entry);
  saveIndex(idx);
  renderProjectSelect();
}

function renderProjectSelect() {
  const sel = $('#projectSelect');
  const idx = loadIndex().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  sel.innerHTML = '<option value="">-- 保存済みの工番を選択 --</option>' +
    idx.map((p) => `<option value="${p.koban}">${p.koban} ${p.kenmei || ''}</option>`).join('');
}

// ---------------- タブ切り替え ----------------
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.tab-content').forEach((c) => { c.hidden = c.dataset.tabContent !== btn.dataset.tab; });
  });
});

// GitHub Pages等、サーバー(server.js)を伴わない静的ホスティングでは
// /api/fetch-pdf が存在しない（404）ため、その場合は「URLから読み込む」タブを隠す。
// ローカルで npm start した場合は 400（urlパラメータ必須のエラー）が返るため区別できる。
(async () => {
  let available = false;
  try {
    const res = await fetch('api/fetch-pdf');
    available = res.status !== 404;
  } catch {
    available = false;
  }
  if (!available) {
    $('.tab-btn[data-tab="url"]').hidden = true;
    $('.tab-content[data-tab-content="url"]').remove();
    const fileTabBtn = $('.tab-btn[data-tab="file"]');
    fileTabBtn.classList.add('active');
    $('.tab-content[data-tab-content="file"]').hidden = false;
  }
})();

// ---------------- インポート: ファイル ----------------
$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus(`読み込み中: ${file.name} ...`);
  try {
    const buf = await file.arrayBuffer();
    await runParse(buf, { type: 'file', name: file.name });
  } catch (err) {
    setStatus('PDFの解析に失敗しました: ' + err.message, true);
  }
});

// ---------------- インポート: URL ----------------
$('#urlFetchBtn').addEventListener('click', async () => {
  const url = $('#urlInput').value.trim();
  if (!url) { setStatus('URLを入力してください', true); return; }
  setStatus('URLから取得中...');
  try {
    const res = await fetch('api/fetch-pdf?url=' + encodeURIComponent(url));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    await runParse(buf, { type: 'url', name: url });
  } catch (err) {
    setStatus('取得に失敗しました: ' + err.message, true);
  }
});

function setStatus(msg, isError = false) {
  const el = $('#importStatus');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
}

async function runParse(arrayBuffer, sourceInfo) {
  const result = await GenkaPdfParser.parsePdf(arrayBuffer);
  const itemCount = result.sections.reduce((s, sec) => s + sec.items.length, 0);
  if (itemCount === 0) {
    setStatus('項目データを検出できませんでした。PDFの形式をご確認ください。', true);
    return;
  }
  pendingParseResult = { ...result, sourceInfo };
  setStatus(`解析完了: ${itemCount}件の項目を検出しました。内容を確認してください。`, false);
  renderPreview(pendingParseResult);
}

function renderPreview(result) {
  const area = $('#previewArea');
  area.hidden = false;

  const metaFields = [
    ['koban', '工番'], ['tokuisaki', '得意先名'], ['kenmei', '件名'],
    ['koki', '工期'], ['kanseiKeijougetsu', '完成計上月'], ['tantou', '工事担当'], ['han', '工事班'],
  ];
  $('#metaEditGrid').innerHTML = metaFields.map(([key, label]) => `
    <label>${label}
      <input type="text" data-meta="${key}" value="${escapeHtml(result.meta[key] || '')}">
    </label>`).join('') + `
    <label>契約金額
      <input type="number" data-meta="keiyakuKingaku" value="${result.footer.keiyakuKingaku ?? ''}">
    </label>
    <label>入金額
      <input type="number" data-meta="nyukinGaku" value="${result.footer.nyukinGaku ?? ''}">
    </label>`;

  const itemCount = result.sections.reduce((s, sec) => s + sec.items.length, 0);
  const hasPdfYotei = result.sections.some((sec) => sec.items.some((it) => it.yoteiShishutsuFromPdf));
  $('#previewSummary').textContent =
    `区分数: ${result.sections.length} / 項目数: ${itemCount} 件` +
    (hasPdfYotei ? '（このPDFには「今後の支出予定」列が含まれています。初期値として取り込みます）' : '') +
    (reimportTargetKoban ? `（工番「${reimportTargetKoban}」への再取込：既存の支出予定・メモは項目コードが一致すれば引き継がれます）` : '');

  $('#rawLinesView').textContent = result.rawLines.join('\n');
}

$('#cancelImportBtn').addEventListener('click', () => {
  pendingParseResult = null;
  reimportTargetKoban = null;
  $('#previewArea').hidden = true;
  setStatus('');
});

$('#commitImportBtn').addEventListener('click', () => {
  if (!pendingParseResult) return;
  const metaOverrides = {};
  $$('#metaEditGrid [data-meta]').forEach((input) => {
    metaOverrides[input.dataset.meta] = input.type === 'number'
      ? (input.value === '' ? null : Number(input.value))
      : input.value;
  });

  const koban = metaOverrides.koban || pendingParseResult.meta.koban || `未設定-${Date.now()}`;

  if (reimportTargetKoban && koban !== reimportTargetKoban) {
    setStatus(`工番が一致しないため取込を中断しました（再取込先: 「${reimportTargetKoban}」／PDFの工番: 「${koban}」）。別の工番のPDFを読み込んでいないか確認してください。`, true);
    return;
  }

  let previousItemState = {};
  let previousProject = null;
  if (reimportTargetKoban) {
    const prev = loadProject(reimportTargetKoban);
    if (prev) {
      previousProject = prev;
      prev.sections.forEach((sec) => sec.items.forEach((it) => {
        previousItemState[it.code] = { yoteiShishutsu: it.yoteiShishutsu, tsuikaKoji: it.tsuikaKoji, memo: it.memo };
      }));
    }
  }

  const project = {
    koban,
    tokuisaki: metaOverrides.tokuisaki,
    kenmei: metaOverrides.kenmei,
    koki: metaOverrides.koki,
    kanseiKeijougetsu: metaOverrides.kanseiKeijougetsu,
    tantou: metaOverrides.tantou,
    han: metaOverrides.han,
    keiyakuKingaku: metaOverrides.keiyakuKingaku,
    nyukinGaku: metaOverrides.nyukinGaku,
    tsuikaKoujiKeiyaku: previousProject?.tsuikaKoujiKeiyaku ?? null,
    stampSlots: previousProject?.stampSlots ?? null,
    stampFlow: previousProject?.stampFlow ?? null,
    sections: pendingParseResult.sections.map((sec) => ({
      label: sec.label,
      items: sec.items.map((it) => ({
        ...it,
        // 優先順位: 同工番への再取込時の既存入力 > PDFに既に記録されている支出予定値 > 0
        yoteiShishutsu: previousItemState[it.code]?.yoteiShishutsu ?? it.yoteiShishutsuFromPdf ?? 0,
        tsuikaKoji: previousItemState[it.code]?.tsuikaKoji ?? 0,
        memo: previousItemState[it.code]?.memo ?? '',
      })),
    })),
    sourceInfo: pendingParseResult.sourceInfo,
  };

  saveProject(project);
  currentProject = project;
  pendingParseResult = null;
  reimportTargetKoban = null;
  $('#previewArea').hidden = true;
  $('#fileInput').value = '';
  $('#urlInput').value = '';
  setStatus('取り込みました。');
  showMainView();
});

// ---------------- 工番の選択・新規読込 ----------------
$('#projectSelect').addEventListener('change', (e) => {
  const koban = e.target.value;
  if (!koban) return;
  const project = loadProject(koban);
  if (project) {
    currentProject = project;
    showMainView();
  }
});

$('#newImportBtn').addEventListener('click', () => {
  reimportTargetKoban = null;
  $('#mainView').hidden = true;
  $('#importPanel').hidden = false;
  $('#importPanel').scrollIntoView({ behavior: 'smooth' });
});

$('#reimportBtn').addEventListener('click', () => {
  reimportTargetKoban = currentProject.koban;
  $('#importPanel').hidden = false;
  $('#importPanel').scrollIntoView({ behavior: 'smooth' });
  setStatus(`工番「${reimportTargetKoban}」に新しいPDFを取り込みます。`);
});

// ---------------- メイン表示 ----------------
function showMainView() {
  $('#importPanel').hidden = true;
  $('#mainView').hidden = false;
  renderMainView();
}

function calcItem(it) {
  const yotei = Number(it.yoteiShishutsu) || 0;
  const tsuika = Number(it.tsuikaKoji) || 0;
  const yosanZangaku = Number(it.yosanZangaku) || 0;
  // 差引後残額 = (予算残額＋追加工事予算) － 今後の支出予定
  return { ...it, sabikigo: (yosanZangaku + tsuika) - yotei };
}

function sumSection(items) {
  const keys = ['jikkou', 'genka', 'shiharai', 'miharai', 'yosanZangaku', 'tsuikaKoji', 'yoteiShishutsu', 'sabikigo'];
  const totals = {};
  keys.forEach((k) => { totals[k] = 0; });
  items.forEach((it) => keys.forEach((k) => { totals[k] += Number(it[k]) || 0; }));
  return totals;
}

function renderMainView() {
  const p = currentProject;

  $('#projectMetaForm').innerHTML = [
    ['koban', '工番'], ['kenmei', '件名'], ['tokuisaki', '得意先名'],
    ['koki', '工期'], ['tantou', '工事担当'], ['han', '工事班'],
  ].map(([key, label]) => `
    <label>${label}
      <input type="text" data-proj="${key}" value="${escapeHtml(p[key] || '')}">
    </label>`).join('') + `
    <label><span class="label-text">契約金額</span>
      <input type="text" inputmode="numeric" class="money-input" data-proj="keiyakuKingaku" value="${p.keiyakuKingaku != null ? yen(p.keiyakuKingaku) : ''}">
    </label>
    <label><span class="label-text">予定追加工事契約金額 <span class="hint-inline">(任意入力)</span></span>
      <input type="text" inputmode="numeric" class="money-input" data-proj="tsuikaKoujiKeiyaku" value="${p.tsuikaKoujiKeiyaku != null ? yen(p.tsuikaKoujiKeiyaku) : ''}">
    </label>`;

  $$('#projectMetaForm input[data-proj]:not(.money-input)').forEach((input) => {
    input.addEventListener('input', () => {
      currentProject[input.dataset.proj] = input.value;
      scheduleAutosave();
    });
  });
  $$('#projectMetaForm input.money-input').forEach((input) => {
    const key = input.dataset.proj;
    input.addEventListener('input', () => {
      const numeric = input.value.replace(/[^0-9-]/g, '');
      currentProject[key] = numeric === '' ? null : Number(numeric);
      renderTotalsAndSummary();
      scheduleAutosave();
    });
    input.addEventListener('blur', () => {
      input.value = currentProject[key] != null ? yen(currentProject[key]) : '';
    });
    input.addEventListener('focus', () => {
      input.select();
    });
  });

  const metaLine = [
    `工番: ${escapeHtml(p.koban || '')}`,
    `件名: ${escapeHtml(p.kenmei || '')}`,
    `得意先名: ${escapeHtml(p.tokuisaki || '')}`,
    `工期: ${escapeHtml(p.koki || '')}`,
    `工事担当: ${escapeHtml(p.tantou || '')}`,
    `工事班: ${escapeHtml(p.han || '')}`,
  ].join('　　');

  // 全区分をひとつの表にまとめ、theadに「タイトル＋工番等＋列見出し」を入れる。
  // theadはページをまたぐたびにブラウザが自動的に繰り返し表示するため、
  // ひとつの表である限りページ単位で1回だけヘッダーが再現される
  // （区分ごとに表を分けると、1ページに複数区分が乗った場合にヘッダーが
  // 区分の数だけ重複表示されてしまうため、単一の表に統合している）。
  const container = $('#sectionsContainer');
  container.innerHTML = `
    <table class="item-table" id="mainItemTable">
      <colgroup>
        <col style="width:14%"><col style="width:9%"><col style="width:9%">
        <col style="width:7%"><col style="width:7%"><col style="width:9%">
        <col style="width:9%"><col style="width:10%"><col style="width:9%"><col style="width:17%">
      </colgroup>
      <thead>
        <tr class="doc-title-row"><th colspan="10">＊＊ 原　価　計　算　表 ＊＊</th></tr>
        <tr class="doc-meta-row"><th colspan="10">${metaLine}</th></tr>
        <tr class="col-header-row">
          <th class="name-col">項目名</th>
          <th>実行合計</th><th>原価合計</th><th>支払額</th><th>未払額</th>
          <th>予算残額</th><th class="col-tsuika">追加工事予算</th><th class="col-yotei">今後の支出予定</th><th>差引後残額</th><th>備考</th>
        </tr>
      </thead>
    </table>`;

  renderSections();
  renderTotalsAndSummary();
  renderStampInputs();
  renderStampBoxes();
}

function renderSections() {
  const table = $('#mainItemTable');
  $$('tbody', table).forEach((tb) => tb.remove());
  currentProject.sections.forEach((sec, secIdx) => {
    const tbody = document.createElement('tbody');
    tbody.dataset.section = String(secIdx);
    tbody.innerHTML = `<tr class="section-title-row"><td colspan="10">${escapeHtml(sec.label)}</td></tr>`;
    table.appendChild(tbody);
    renderSectionRows(secIdx);
  });
}

function newCustomItem() {
  return {
    code: '', name: '', jikkou: 0, genka: 0, shiharai: 0, miharai: 0, yosanZangaku: 0,
    tsuikaKoji: 0, yoteiShishutsu: 0, memo: '', isCustom: true,
  };
}

function numCellHtml(it, field, editable, colClass = '') {
  if (editable) {
    return `<td class="${colClass}"><input type="text" inputmode="numeric" class="num-input" data-field="${field}" value="${yen(it[field] ?? 0)}"></td>`;
  }
  return `<td class="${colClass}">${yen(it[field] ?? 0)}</td>`;
}

function renderSectionRows(secIdx) {
  const sec = currentProject.sections[secIdx];
  const tbody = $(`#mainItemTable tbody[data-section="${secIdx}"]`);
  const titleRow = tbody.querySelector('.section-title-row');
  $$('tr:not(.section-title-row)', tbody).forEach((tr) => tr.remove());

  const itemRowsHtml = sec.items.map((it, itemIdx) => {
    const calced = calcItem(it);
    const nameCell = it.isCustom
      ? `<td class="name-cell">
          <div class="row-actions no-print">
            <button type="button" class="row-del-btn" data-item="${itemIdx}" title="この行を削除">×</button>
          </div>
          <input type="text" class="custom-name-input" data-item="${itemIdx}" placeholder="項目名を入力" value="${escapeHtml(it.name || '')}">
        </td>`
      : `<td class="name-cell">
          <span class="row-name-text">${escapeHtml(it.code)} ${escapeHtml(it.name)}</span>
        </td>`;

    return `<tr data-item="${itemIdx}" class="${it.isCustom ? 'custom-row' : ''}">
      ${nameCell}
      ${numCellHtml(it, 'jikkou', it.isCustom)}
      ${numCellHtml(it, 'genka', it.isCustom)}
      ${numCellHtml(it, 'shiharai', it.isCustom)}
      ${numCellHtml(it, 'miharai', it.isCustom)}
      ${numCellHtml(it, 'yosanZangaku', it.isCustom)}
      <td class="col-tsuika"><input type="text" inputmode="numeric" class="num-input" data-field="tsuikaKoji" value="${yen(it.tsuikaKoji ?? 0)}"></td>
      <td class="col-yotei"><input type="text" inputmode="numeric" class="num-input" data-field="yoteiShishutsu" value="${yen(it.yoteiShishutsu ?? 0)}"></td>
      <td class="sabikigo-cell ${calced.sabikigo < 0 ? 'neg' : ''}">${yen(calced.sabikigo)}</td>
      <td><input type="text" class="memo-input" data-item="${itemIdx}" value="${escapeHtml(it.memo || '')}"></td>
    </tr>`;
  }).join('');
  const addRowHtml = `<tr class="add-row-tr no-print"><td colspan="10">
    <div class="add-row-cell">
      <button type="button" class="btn-add-section-row" data-section="${secIdx}">＋ 項目を追加</button>
      <span class="add-row-hint">（追加工事予算で項目が増える場合、ここをクリックして項目を追加してください）</span>
    </div>
  </td></tr>`;
  titleRow.insertAdjacentHTML('afterend', itemRowsHtml + addRowHtml + '<tr class="subtotal-row"><td class="name-cell">(小計)</td><td colspan="9"></td></tr>');

  $$('input.num-input', tbody).forEach((input) => {
    const row = input.closest('tr');
    const itemIdx = Number(row.dataset.item);
    const field = input.dataset.field;
    input.addEventListener('input', () => {
      const numeric = Number(input.value.replace(/[^0-9-]/g, '')) || 0;
      sec.items[itemIdx][field] = numeric;
      const calced = calcItem(sec.items[itemIdx]);
      const cell = row.querySelector('.sabikigo-cell');
      cell.textContent = yen(calced.sabikigo);
      cell.classList.toggle('neg', calced.sabikigo < 0);
      renderSectionFooter(secIdx);
      renderTotalsAndSummary();
      scheduleAutosave();
    });
    input.addEventListener('blur', () => {
      input.value = yen(sec.items[itemIdx][field] ?? 0);
    });
    input.addEventListener('focus', () => {
      input.select();
    });
  });
  $$('input.memo-input', tbody).forEach((input) => {
    const itemIdx = Number(input.closest('tr').dataset.item);
    input.addEventListener('input', () => {
      sec.items[itemIdx].memo = input.value;
      scheduleAutosave();
    });
  });
  $$('input.custom-name-input', tbody).forEach((input) => {
    const itemIdx = Number(input.closest('tr').dataset.item);
    input.addEventListener('input', () => {
      sec.items[itemIdx].name = input.value;
      scheduleAutosave();
    });
  });
  $$('button.row-del-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', () => {
      const itemIdx = Number(btn.dataset.item);
      sec.items.splice(itemIdx, 1);
      renderSectionRows(secIdx);
      renderTotalsAndSummary();
      scheduleAutosave();
    });
  });
  const addSectionBtn = tbody.querySelector('.btn-add-section-row');
  if (addSectionBtn) {
    addSectionBtn.addEventListener('click', () => {
      sec.items.push(newCustomItem());
      renderSectionRows(secIdx);
      renderTotalsAndSummary();
      scheduleAutosave();
    });
  }

  renderSectionFooter(secIdx);
}

function renderSectionFooter(secIdx) {
  const sec = currentProject.sections[secIdx];
  const totals = sumSection(sec.items.map(calcItem));
  const tbody = $(`#mainItemTable tbody[data-section="${secIdx}"]`);
  const subtotalRow = tbody.querySelector('.subtotal-row');
  subtotalRow.innerHTML = `
    <td class="name-cell">(小計)</td>
    <td>${yen(totals.jikkou)}</td>
    <td>${yen(totals.genka)}</td>
    <td>${yen(totals.shiharai)}</td>
    <td>${yen(totals.miharai)}</td>
    <td>${yen(totals.yosanZangaku)}</td>
    <td class="col-tsuika">${yen(totals.tsuikaKoji)}</td>
    <td class="col-yotei">${yen(totals.yoteiShishutsu)}</td>
    <td class="${totals.sabikigo < 0 ? 'neg' : ''}">${yen(totals.sabikigo)}</td>
    <td></td>`;
}

function renderTotalsAndSummary() {
  const p = currentProject;
  const allItems = p.sections.flatMap((s) => s.items.map(calcItem));
  const grand = sumSection(allItems);
  const saishuuGenka = grand.genka + grand.yoteiShishutsu; // 最終原価(①＋②)

  // 列ごとに合計を表示（項目一覧の各列と対応する合計値の表）
  $('#grandTotalTable').innerHTML = `
    <tr class="totals-header-row">
      <td class="label" rowspan="2">合計</td>
      <td>実行合計</td>
      <td>原価合計(①)</td>
      <td>予算残額</td>
      <td class="col-tsuika">追加工事予算</td>
      <td class="col-yotei">今後の支出予定(②)</td>
      <td>最終原価(①＋②)</td>
      <td>差引後残額</td>
    </tr>
    <tr class="totals-value-row">
      <td>${yen(grand.jikkou)}</td>
      <td>${yen(grand.genka)}</td>
      <td>${yen(grand.yosanZangaku)}</td>
      <td class="col-tsuika">${yen(grand.tsuikaKoji)}</td>
      <td class="col-yotei">${yen(grand.yoteiShishutsu)}</td>
      <td>${yen(saishuuGenka)}</td>
      <td class="${grand.sabikigo < 0 ? 'neg' : ''}">${yen(grand.sabikigo)}</td>
    </tr>`;

  const keiyaku = Number(p.keiyakuKingaku) || 0;
  const tsuikaKeiyaku = Number(p.tsuikaKoujiKeiyaku) || 0;
  // 実行粗利率 = (契約金額－実行合計) ÷ 契約金額
  const jikkouArariRate = keiyaku ? ((keiyaku - grand.jikkou) / keiyaku) * 100 : null;
  // 追加工事粗利率 = (追加工事契約予定金額－追加工事実行金額) ÷ 追加工事契約予定金額
  const tsuikaArariRate = tsuikaKeiyaku ? ((tsuikaKeiyaku - grand.tsuikaKoji) / tsuikaKeiyaku) * 100 : null;
  // 最終粗利率 = (契約金額＋追加工事契約予定金額－最終原価) ÷ (契約金額＋追加工事契約予定金額)
  const saishuuBase = keiyaku + tsuikaKeiyaku;
  const saishuuArariRate = saishuuBase ? ((saishuuBase - saishuuGenka) / saishuuBase) * 100 : null;

  // 契約金額・実行合計・実行粗利率の3列グリッドの直下に、予定追加工事契約金額・
  // 追加工事実行金額・追加工事粗利率を対になるよう並べる。最終原価・最終粗利率は
  // 別グループとして右側に配置する。
  const pairCards = [
    ['契約金額', yen(keiyaku)],
    ['実行合計', yen(grand.jikkou)],
    ['実行粗利率', formatRate(jikkouArariRate)],
    ['予定追加工事契約金額', yen(tsuikaKeiyaku)],
    ['追加工事実行金額', yen(grand.tsuikaKoji)],
    ['追加工事粗利率', formatRate(tsuikaArariRate)],
  ];
  const finalCards = [
    ['最終原価(①＋②)', yen(saishuuGenka)],
    ['最終粗利率', formatRate(saishuuArariRate)],
  ];
  const cardHtml = ([label, value]) => `
    <div class="summary-card"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  $('#summaryCards').innerHTML = `
    <div class="summary-pair-grid">${pairCards.map(cardHtml).join('')}</div>
    <div class="summary-final-group">${finalCards.map(cardHtml).join('')}</div>`;
}

// ---------------- 保存（自動保存 + 手動保存） ----------------
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  $('#saveStatus').textContent = '編集中...';
  autosaveTimer = setTimeout(() => {
    saveProject(currentProject);
    $('#saveStatus').textContent = '自動保存しました（' + new Date().toLocaleTimeString('ja-JP') + '）';
  }, 800);
}
$('#saveBtn').addEventListener('click', () => {
  saveProject(currentProject);
  $('#saveStatus').textContent = '保存しました（' + new Date().toLocaleTimeString('ja-JP') + '）';
});

// ---------------- 印刷 ----------------
$('#printBtn').addEventListener('click', () => window.print());

// ---------------- CSV出力 ----------------
$('#csvBtn').addEventListener('click', () => {
  const p = currentProject;
  const rows = [['区分', 'コード', '項目名', '実行合計', '原価合計', '支払額', '未払額', '予算残額', '追加工事予算', '今後の支出予定', '差引後残額', '備考']];
  p.sections.forEach((sec) => {
    sec.items.forEach((it) => {
      const c = calcItem(it);
      rows.push([sec.label, it.code, it.name, it.jikkou, it.genka, it.shiharai, it.miharai, it.yosanZangaku, it.tsuikaKoji, it.yoteiShishutsu, c.sabikigo, it.memo || '']);
    });
  });
  const csv = '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `原価計算表_${p.koban}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- ファイル保存/読み込み（Teams/メール送付での検印フロー用） ----------------
// サーバー・共有ストレージを使わず、工番ごとのプロジェクトデータ全体をファイルに書き出し、
// Teams/メール添付で次の担当者へ渡す運用に対応する。受け取った側は「ファイルを開く」
// （対応ブラウザ・インストール済みPWAならファイルのダブルクリック）で読み込める。
function sanitizeFilename(name) {
  return String(name ?? '').replace(/[\\/:*?"<>|]/g, '_');
}

async function exportProjectToFile() {
  const p = currentProject;
  const filename = sanitizeFilename(`原価計算表_${p.koban}`) + '.json';
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      $('#saveStatus').textContent = `ファイルに保存しました（${filename}）`;
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // ユーザーがキャンセル
      // 未対応/失敗時は下のフォールバックへ
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  $('#saveStatus').textContent = `ファイルに保存しました（${filename}）`;
}

async function openProjectFromFile(file) {
  try {
    const text = await file.text();
    const project = JSON.parse(text);
    if (!project || typeof project !== 'object' || !project.koban || !Array.isArray(project.sections)) {
      throw new Error('原価計算表のデータファイルではないようです');
    }
    currentProject = project;
    saveProject(currentProject);
    $('#importPanel').hidden = true;
    showMainView();
    $('#saveStatus').textContent = `ファイルから開きました（${file.name}）`;
  } catch (err) {
    alert('ファイルを開けませんでした: ' + err.message);
  }
}

$('#exportFileBtn').addEventListener('click', () => { exportProjectToFile(); });
$('#openFileBtn').addEventListener('click', () => { $('#openFileInput').click(); });
$('#openFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) openProjectFromFile(file);
});

// PWAとしてインストールされている場合、ファイル(.json)のダブルクリックから
// このアプリが直接起動し、launchQueueでファイルを受け取れる。
if ('launchQueue' in window && window.LaunchParams && 'files' in window.LaunchParams.prototype) {
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files || !launchParams.files.length) return;
    const file = await launchParams.files[0].getFile();
    openProjectFromFile(file);
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* PWA非対応環境では無視 */ });
}

// ---------------- 初期化 ----------------
renderProjectSelect();
