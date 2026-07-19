// ---------------- 一般材警告書（B_一般資材の別画面） ----------------
// 原価計算書アプリ本体（app.js）の currentProject / $ / $$ / yen / escapeHtml / scheduleAutosave /
// saveProject / STAMP_SLOT_COUNT / STAMP_TITLES / STAMP_TITLE_COLOR / STAMP_SLOT_LABELS /
// STAMP_STATE_BADGE / newStampSlot / buildStampDataUrl / todayIso / sanitizeFilename / csvEscape /
// closeAppWindow / showMainView をそのまま利用する（app.js より後に読み込まれる前提）。
// 検印まわりは本体の検印フロー・承認運用に影響を与えないよう、あえて関数を複製して独立させている。

const IPPANZAI_B_SECTION_LABEL = 'B_一般資材';
// 今後要望があれば true に戻すだけで、行ごとの「転記」ボタンを再表示できる
const IPPANZAI_SHOW_ROW_TRANSFER = false;
// 印刷時は「原価計算書の今後の支出予定額」参考列をDOMごと除外する。
// table-layout:fixed の列に width:0 を指定してもブラウザが最小幅を確保してしまい
// 完全には消えないため、CSSだけでなくJS側で列自体を出し分ける。
let ippanzaiPrintMode = false;

function findIppanzaiSection(project = currentProject) {
  return project?.sections?.find((s) => s.label === IPPANZAI_B_SECTION_LABEL) || null;
}

function ensureIppanzaiKeikoku(project = currentProject) {
  if (!project.ippanzaiKeikoku || typeof project.ippanzaiKeikoku !== 'object') {
    project.ippanzaiKeikoku = { overBudgetReason: '', approvalCondition: '', stampSlots: null, stampFlow: null };
  }
  const k = project.ippanzaiKeikoku;
  const prevSlots = Array.isArray(k.stampSlots) ? k.stampSlots : [];
  k.stampSlots = Array.from({ length: STAMP_SLOT_COUNT }, (_, i) => prevSlots[i] || newStampSlot());
  if (!k.stampFlow || typeof k.stampFlow.stage !== 'number') {
    let stage = 0;
    while (stage < STAMP_SLOT_COUNT && (k.stampSlots[stage]?.name || '').trim()) stage++;
    k.stampFlow = { stage, skipped: [] };
  }
  const sec = findIppanzaiSection(project);
  if (sec) {
    sec.items.forEach((it) => {
      if (it.keikokuYoteiShishutsu == null) it.keikokuYoteiShishutsu = 0;
      if (it.ippanzaiYoukyuGaku == null) it.ippanzaiYoukyuGaku = 0;
    });
  }
  return k;
}

// 差引後残額 = (予算残額＋追加工事予算) － 警告書向け今後の支出予定（本体calcItemと同じ式）
function calcKeikokuItem(it) {
  const yotei = Number(it.keikokuYoteiShishutsu) || 0;
  const tsuika = Number(it.tsuikaKoji) || 0;
  const yosanZangaku = Number(it.yosanZangaku) || 0;
  return { ...it, keikokuSabikigo: (yosanZangaku + tsuika) - yotei };
}

function sumKeikokuItems(items) {
  const keys = ['jikkou', 'genka', 'yosanZangaku', 'ippanzaiYoukyuGaku', 'keikokuYoteiShishutsu', 'keikokuSabikigo'];
  const totals = {};
  keys.forEach((k) => { totals[k] = 0; });
  items.forEach((it) => keys.forEach((k) => { totals[k] += Number(it[k]) || 0; }));
  return totals;
}

// 使用比率 = 発注金額(genka) ÷ 実行金額(jikkou) × 100（一般材使用状況一覧表の数式と一致）
function ippanzaiUsageRate(it) {
  const jikkou = Number(it.jikkou) || 0;
  const genka = Number(it.genka) || 0;
  return jikkou ? (genka / jikkou) * 100 : 0;
}

function ippanzaiShowWarning(project = currentProject) {
  const sec = findIppanzaiSection(project);
  return !!sec && sec.items.some((it) => (Number(it.yosanZangaku) || 0) < 0);
}

// app.js の renderTotalsAndSummary() 末尾から呼ばれるフック
function updateIppanzaiWarningButton() {
  const btn = $('#ippanzaiWarningBtn');
  if (!btn || !currentProject) return;
  const show = ippanzaiShowWarning(currentProject);
  btn.hidden = !show;
  if (show) {
    btn.textContent = '⚠ B_一般資材項目が予算オーバーです。一般材警告書に今後の支出予定額記入して別途、回送してください（一般材警告書を開く）';
  }
}

// ---------------- パネル切り替え ----------------
function showIppanzaiPanel() {
  if (!currentProject) return;
  ensureIppanzaiKeikoku(currentProject);
  $('#importPanel').hidden = true;
  $('#deletePanel').hidden = true;
  $('#mainView').hidden = true;
  $('#ippanzaiPanel').hidden = false;
  renderIppanzaiPanel();
}

function hideIppanzaiPanel() {
  $('#ippanzaiPanel').hidden = true;
  showMainView();
}

// ---------------- メイン描画 ----------------
function renderIppanzaiPanel() {
  const p = currentProject;
  const k = ensureIppanzaiKeikoku(p);

  $('#ippanzaiMetaForm').innerHTML = [
    ['koban', '工番'], ['kenmei', '件名'], ['koki', '工期'], ['tantou', '担当'],
  ].map(([key, label]) => `
    <label>${label}
      <input type="text" value="${escapeHtml(p[key] || '')}" disabled>
    </label>`).join('');

  const metaLine = [
    `工番: ${escapeHtml(p.koban || '')}`,
    `件名: ${escapeHtml(p.kenmei || '')}`,
    `工期: ${escapeHtml(p.koki || '')}`,
    `担当: ${escapeHtml(p.tantou || '')}`,
  ].join('　　');
  const sourceCiteHtml = p.sourceHeader
    ? `<span class="doc-meta-source">引用元：「${escapeHtml(p.sourceHeader)}」より</span>` : '';

  const showRef = !ippanzaiPrintMode;
  const colCount = showRef ? 9 : 8;
  const refColHtml = showRef ? '<col class="col-refyotei" style="width:40mm">' : '';
  const refThHtml = showRef ? '<th class="col-refyotei">原価計算書の<br>今後の支出予定額</th>' : '';

  const container = $('#ippanzaiSectionsContainer');
  container.innerHTML = `
    <table class="item-table" id="ippanzaiItemTable">
      <colgroup>
        <col style="width:45mm"><col style="width:27.4mm"><col style="width:27.4mm">
        <col style="width:27.4mm"><col style="width:27.4mm"><col style="width:21.3mm">
        ${refColHtml}<col style="width:40mm"><col style="width:27.4mm">
      </colgroup>
      <thead>
        <tr class="doc-title-row"><th colspan="${colCount}">＊＊ 一般材警告書 ＊＊</th></tr>
        <tr class="doc-meta-row"><th colspan="${colCount}"><div class="doc-meta-row-inner"><span class="doc-meta-left">${metaLine}</span>${sourceCiteHtml}</div></th></tr>
        <tr class="col-header-row">
          <th class="name-col">区分　　区分名</th>
          <th>実行金額</th><th>発注金額</th><th>一般材要求額</th><th>残額</th><th>使用比率</th>
          ${refThHtml}
          <th class="col-yotei">今後の支出予定額</th>
          <th>差引後残額</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>`;

  renderIppanzaiRows();

  const reasonEl = $('#ippanzaiOverBudgetReason');
  const conditionEl = $('#ippanzaiApprovalCondition');
  reasonEl.value = k.overBudgetReason || '';
  conditionEl.value = k.approvalCondition || '';
  reasonEl.oninput = () => { k.overBudgetReason = reasonEl.value; scheduleAutosave(); };
  conditionEl.oninput = () => { k.approvalCondition = conditionEl.value; scheduleAutosave(); };

  renderIppanzaiStampInputs();
  renderIppanzaiStampBoxes();
  refreshIppanzaiApprovalConditionLock();
}

// 差引後残額がマイナスの区分コードを「予算オーバー見込みの理由」欄に追記する（手動ボタン起動、既存の記述は消さない）
function appendOverBudgetCodesToReason() {
  const sec = findIppanzaiSection(currentProject);
  const k = ensureIppanzaiKeikoku(currentProject);
  const reasonEl = $('#ippanzaiOverBudgetReason');
  if (!sec || !reasonEl) return;
  const overItems = sec.items.filter((it) => calcKeikokuItem(it).keikokuSabikigo < 0);
  const existing = reasonEl.value || '';
  const newLines = overItems
    .filter((it) => !existing.includes(`${it.code}：`))
    .map((it) => `${it.code}：`);
  if (!newLines.length) return;
  reasonEl.value = existing ? `${existing}\n${newLines.join('\n')}` : newLines.join('\n');
  k.overBudgetReason = reasonEl.value;
  scheduleAutosave();
}

// 承認条件欄は、検印フローが「承認」段階（stage>=5）に到達するまで編集不可にする
// （パスワード等の別認証は設けず、既存の検印フローの順番そのものを保護手段として使う）
function refreshIppanzaiApprovalConditionLock() {
  const conditionEl = $('#ippanzaiApprovalCondition');
  const hintEl = $('#ippanzaiApprovalConditionHint');
  if (!conditionEl || !currentProject?.ippanzaiKeikoku) return;
  const stage = currentProject.ippanzaiKeikoku.stampFlow.stage;
  const unlocked = stage >= 5;
  conditionEl.disabled = !unlocked;
  if (hintEl) {
    hintEl.textContent = unlocked
      ? '承認段階のため記載できます。'
      : '承認段階（検印欄の「承認」欄が解放される段階）に到達するまで記載できません。';
  }
}

function renderIppanzaiRows() {
  const sec = findIppanzaiSection(currentProject);
  const tbody = $('#ippanzaiItemTable tbody');
  const showRef = !ippanzaiPrintMode;
  const colCount = showRef ? 9 : 8;
  if (!sec) {
    tbody.innerHTML = `<tr><td colspan="${colCount}">B_一般資材の区分が見つかりません。</td></tr>`;
    return;
  }

  const rowsHtml = sec.items.map((it, idx) => {
    const calced = calcKeikokuItem(it);
    const isOver = (Number(it.yosanZangaku) || 0) < 0;
    const rate = ippanzaiUsageRate(it);
    const refTd = showRef ? `<td class="ref-value col-refyotei">${yen(it.yoteiShishutsu ?? 0)}</td>` : '';
    return `<tr data-item="${idx}" class="${isOver ? 'over-budget-row' : ''}">
      <td class="name-cell">${escapeHtml(it.code)} ${escapeHtml(it.name)}${isOver ? ' ⚠' : ''}</td>
      <td>${yen(it.jikkou)}</td>
      <td>${yen(it.genka)}</td>
      <td><input type="text" inputmode="numeric" class="num-input" data-field="ippanzaiYoukyuGaku" value="${yen(it.ippanzaiYoukyuGaku ?? 0)}"></td>
      <td class="${isOver ? 'neg' : ''}">${yen(it.yosanZangaku)}</td>
      <td>${rate.toFixed(1)}%</td>
      ${refTd}
      <td class="col-yotei transfer-cell">
        <input type="text" inputmode="numeric" class="num-input" data-field="keikokuYoteiShishutsu" value="${yen(it.keikokuYoteiShishutsu ?? 0)}">
        ${IPPANZAI_SHOW_ROW_TRANSFER ? `<button type="button" class="transfer-btn no-print" data-item="${idx}" title="原価計算書の今後の支出予定額をコピー">転記</button>` : ''}
      </td>
      <td class="sabikigo-cell ${calced.keikokuSabikigo < 0 ? 'neg' : ''}">${yen(calced.keikokuSabikigo)}</td>
    </tr>`;
  }).join('');

  const tbodyEl = $('#ippanzaiItemTable tbody');
  tbodyEl.innerHTML = rowsHtml + `<tr class="subtotal-row"><td class="name-cell">計</td><td colspan="${colCount - 1}"></td></tr>`;
  renderIppanzaiFooter();

  $$('input.num-input', tbodyEl).forEach((input) => {
    const row = input.closest('tr');
    const idx = Number(row.dataset.item);
    const field = input.dataset.field;
    input.addEventListener('input', () => {
      const numeric = Number(input.value.replace(/[^0-9-]/g, '')) || 0;
      sec.items[idx][field] = numeric;
      if (field === 'keikokuYoteiShishutsu') {
        const calced = calcKeikokuItem(sec.items[idx]);
        const cell = row.querySelector('.sabikigo-cell');
        cell.textContent = yen(calced.keikokuSabikigo);
        cell.classList.toggle('neg', calced.keikokuSabikigo < 0);
      }
      renderIppanzaiFooter();
      scheduleAutosave();
    });
    input.addEventListener('blur', () => { input.value = yen(sec.items[idx][field] ?? 0); });
    input.addEventListener('focus', () => { input.select(); });
  });

  $$('.transfer-btn', tbodyEl).forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.item);
      sec.items[idx].keikokuYoteiShishutsu = Number(sec.items[idx].yoteiShishutsu) || 0;
      renderIppanzaiRows();
      scheduleAutosave();
    });
  });
}

function renderIppanzaiFooter() {
  const sec = findIppanzaiSection(currentProject);
  const row = $('#ippanzaiItemTable .subtotal-row');
  if (!sec || !row) return;
  const totals = sumKeikokuItems(sec.items.map(calcKeikokuItem));
  const totalRate = totals.jikkou ? (totals.genka / totals.jikkou) * 100 : 0;
  const totalYotei = sec.items.reduce((s, it) => s + (Number(it.yoteiShishutsu) || 0), 0);
  const refTd = !ippanzaiPrintMode ? `<td class="ref-value col-refyotei">${yen(totalYotei)}</td>` : '';
  row.innerHTML = `
    <td class="name-cell">計</td>
    <td>${yen(totals.jikkou)}</td>
    <td>${yen(totals.genka)}</td>
    <td>${yen(totals.ippanzaiYoukyuGaku)}</td>
    <td class="${totals.yosanZangaku < 0 ? 'neg' : ''}">${yen(totals.yosanZangaku)}</td>
    <td>${totalRate.toFixed(1)}%</td>
    ${refTd}
    <td class="col-yotei">${yen(totals.keikokuYoteiShishutsu)}</td>
    <td class="${totals.keikokuSabikigo < 0 ? 'neg' : ''}">${yen(totals.keikokuSabikigo)}</td>`;
}

function transferAllIppanzai() {
  const sec = findIppanzaiSection(currentProject);
  if (!sec) return;
  sec.items.forEach((it) => { it.keikokuYoteiShishutsu = Number(it.yoteiShishutsu) || 0; });
  renderIppanzaiRows();
  scheduleAutosave();
}

// ---------------- 検印欄（一般材警告書 専用・本体とは独立） ----------------
function ippanzaiStampSlotState(i) {
  const flow = currentProject.ippanzaiKeikoku.stampFlow;
  if (flow.skipped.includes(i)) return 'skipped';
  if (i < flow.stage) return 'done';
  if (i === flow.stage) return 'active';
  return 'locked';
}

function ippanzaiPrevRealStage(stage) {
  const flow = currentProject.ippanzaiKeikoku.stampFlow;
  for (let i = stage - 1; i >= 0; i--) {
    if (!flow.skipped.includes(i)) return i;
  }
  return -1;
}

// ファイル名規則: 工番_一般材警告書_日付(YYYY-MM-DD)_苗字.json （苗字は提出者本人の欄が空欄なら空欄のまま。
// 原価計算書本体のbuildExportFilename()と対称のルール）
function buildIppanzaiExportFilename(project, submitterName) {
  const koban = sanitizeFilename(project.koban || '');
  const date = todayIso();
  const name = sanitizeFilename((submitterName || '').trim());
  return `${koban}_一般材警告書_${date}_${name}.json`;
}

async function exportIppanzaiProjectToFile(project = currentProject, submitterName = null) {
  const p = project;
  const k = p.ippanzaiKeikoku || {};
  const name = submitterName != null ? submitterName : (k.stampSlots?.[k.stampFlow?.stage]?.name || '');
  const filename = buildIppanzaiExportFilename(p, name);
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
      $('#ippanzaiSaveStatus').textContent = `ファイルに保存しました（${filename}）`;
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // ユーザーがキャンセル
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  $('#ippanzaiSaveStatus').textContent = `ファイルに保存しました（${filename}）`;
}

async function advanceIppanzaiStampFlow(action) {
  const k = currentProject.ippanzaiKeikoku;
  const flow = k.stampFlow;
  const submitterName = (k.stampSlots[flow.stage]?.name || '').trim();
  const isSubmit = action === 'toConfirm' || action === 'addConfirm' || action === 'toApproval';

  if (isSubmit) {
    const exported = JSON.parse(JSON.stringify(currentProject));
    const exportedFlow = exported.ippanzaiKeikoku.stampFlow;
    if (action === 'toConfirm') {
      exportedFlow.stage = 1;
    } else if (action === 'addConfirm') {
      exportedFlow.stage = Math.min(exportedFlow.stage + 1, 4);
    } else if (action === 'toApproval') {
      for (let i = exportedFlow.stage + 1; i <= 4; i++) if (!exportedFlow.skipped.includes(i)) exportedFlow.skipped.push(i);
      exportedFlow.stage = 5;
    }
    saveProject(currentProject);
    await exportIppanzaiProjectToFile(exported, submitterName);
    $('#ippanzaiSaveStatus').textContent = '保存しました。Teams/メールで次の方へ送付してください。このアプリを閉じます（' + new Date().toLocaleTimeString('ja-JP') + '）';
    closeAppWindow();
    return;
  }

  if (action === 'finish') {
    flow.stage = 6;
  } else if (action === 'reject') {
    const p = ippanzaiPrevRealStage(flow.stage);
    if (p < 0) return;
    if (flow.stage < STAMP_SLOT_COUNT) k.stampSlots[flow.stage] = newStampSlot();
    k.stampSlots[p] = newStampSlot();
    flow.skipped = flow.skipped.filter((i) => i < p);
    flow.stage = p;
  }
  saveProject(currentProject);
  renderIppanzaiStampInputs();
  renderIppanzaiStampBoxes();
  refreshIppanzaiApprovalConditionLock();
  await exportIppanzaiProjectToFile(currentProject, submitterName);
  $('#ippanzaiSaveStatus').textContent = '保存しました。Teams/メールで次の方へ送付してください（' + new Date().toLocaleTimeString('ja-JP') + '）';
}

function refreshIppanzaiStampAdvanceButtons() {
  const k = currentProject.ippanzaiKeikoku;
  const flow = k.stampFlow;
  const activeName = (k.stampSlots[flow.stage]?.name || '').trim();
  $$('#ippanzaiStampFlowActions button').forEach((btn) => {
    if (btn.id === 'ippanzaiStampRejectBtn') return;
    if (btn.id === 'ippanzaiStampAddConfirmBtn') btn.disabled = !activeName || flow.stage >= 4;
    else btn.disabled = !activeName;
  });
}

function ippanzaiRejectButtonHtml(stage) {
  const p = ippanzaiPrevRealStage(stage);
  if (p < 0) return '';
  return `<button type="button" class="btn danger" id="ippanzaiStampRejectBtn">差し戻す（${STAMP_SLOT_LABELS[p]}へ）</button>`;
}

function renderIppanzaiStampFlowActions() {
  const area = $('#ippanzaiStampFlowActions');
  if (!area) return;
  const k = currentProject.ippanzaiKeikoku;
  const flow = k.stampFlow;
  const stage = flow.stage;
  const activeName = (k.stampSlots[stage]?.name || '').trim();

  if (stage >= STAMP_SLOT_COUNT) {
    area.innerHTML = `${ippanzaiRejectButtonHtml(STAMP_SLOT_COUNT)}<p class="stamp-flow-done">✓ すべての検印が完了しました</p>`;
    $('#ippanzaiStampRejectBtn')?.addEventListener('click', () => advanceIppanzaiStampFlow('reject'));
    return;
  }
  if (stage === 0) {
    area.innerHTML = `<button type="button" class="btn" id="ippanzaiStampAdvanceBtn" ${activeName ? '' : 'disabled'}>確認者へ提出</button>`;
    $('#ippanzaiStampAdvanceBtn').addEventListener('click', () => advanceIppanzaiStampFlow('toConfirm'));
    return;
  }
  if (stage >= 1 && stage <= 4) {
    const canAddMore = stage < 4;
    area.innerHTML = `
      ${ippanzaiRejectButtonHtml(stage)}
      <button type="button" class="btn" id="ippanzaiStampAddConfirmBtn" ${activeName && canAddMore ? '' : 'disabled'}>確認者へ提出</button>
      <button type="button" class="btn primary" id="ippanzaiStampToApprovalBtn" ${activeName ? '' : 'disabled'}>承認者へ提出</button>`;
    $('#ippanzaiStampAddConfirmBtn').addEventListener('click', () => advanceIppanzaiStampFlow('addConfirm'));
    $('#ippanzaiStampToApprovalBtn').addEventListener('click', () => advanceIppanzaiStampFlow('toApproval'));
    $('#ippanzaiStampRejectBtn')?.addEventListener('click', () => advanceIppanzaiStampFlow('reject'));
    return;
  }
  if (stage === 5) {
    area.innerHTML = `
      ${ippanzaiRejectButtonHtml(stage)}
      <button type="button" class="btn primary" id="ippanzaiStampFinishBtn" ${activeName ? '' : 'disabled'}>承認欄を保存して完了</button>`;
    $('#ippanzaiStampFinishBtn').addEventListener('click', () => advanceIppanzaiStampFlow('finish'));
    $('#ippanzaiStampRejectBtn')?.addEventListener('click', () => advanceIppanzaiStampFlow('reject'));
  }
}

function renderIppanzaiStampBoxes() {
  const cells = $$('.ippanzai-stamp-boxes .stamp-cell');
  const k = currentProject.ippanzaiKeikoku;
  cells.forEach((cell, i) => {
    const slot = k.stampSlots[STAMP_SLOT_COUNT - 1 - i] || newStampSlot();
    const dataUrl = buildStampDataUrl(slot);
    cell.innerHTML = dataUrl ? `<img class="stamp-img" src="${dataUrl}" alt="">` : '';
  });
}

function renderIppanzaiStampInputs() {
  const k = ensureIppanzaiKeikoku(currentProject);
  const grid = $('#ippanzaiStampInputGrid');
  grid.innerHTML = k.stampSlots.map((slot, i) => {
    const state = ippanzaiStampSlotState(i);
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
      k.stampSlots[Number(input.dataset.idx)].name = input.value;
      renderIppanzaiStampBoxes();
      refreshIppanzaiStampAdvanceButtons();
      scheduleAutosave();
    });
  });
  $$('.stamp-title-select', grid).forEach((sel) => {
    sel.addEventListener('change', () => {
      k.stampSlots[Number(sel.dataset.idx)].title = sel.value;
      renderIppanzaiStampBoxes();
      scheduleAutosave();
    });
  });
  $$('.stamp-date-input', grid).forEach((input) => {
    input.addEventListener('input', () => {
      k.stampSlots[Number(input.dataset.idx)].date = input.value;
      renderIppanzaiStampBoxes();
      scheduleAutosave();
    });
  });

  renderIppanzaiStampFlowActions();
}

// ---------------- 保存・印刷・CSV ----------------
async function ippanzaiManualSave() {
  saveProject(currentProject);
  await exportIppanzaiProjectToFile();
  $('#ippanzaiSaveStatus').textContent = '保存しました。Teams/メールで送付する場合はこのファイルを添付してください（' + new Date().toLocaleTimeString('ja-JP') + '）';
}

function exportIppanzaiCsv() {
  const p = currentProject;
  const sec = findIppanzaiSection(p);
  if (!sec) return;
  const rows = [['区分', '区分名', '実行金額', '発注金額', '一般材要求額', '残額', '使用比率(%)', '警告書:今後の支出予定額', '差引後残額']];
  sec.items.forEach((it) => {
    const c = calcKeikokuItem(it);
    rows.push([it.code, it.name, it.jikkou, it.genka, it.ippanzaiYoukyuGaku, it.yosanZangaku, ippanzaiUsageRate(it).toFixed(1), it.keikokuYoteiShishutsu, c.keikokuSabikigo]);
  });
  const csv = '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `一般材警告書_${p.koban}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 初期化（静的ボタンへのイベント登録） ----------------
$('#ippanzaiWarningBtn')?.addEventListener('click', showIppanzaiPanel);
$('#ippanzaiBackBtn')?.addEventListener('click', hideIppanzaiPanel);
$('#ippanzaiSaveBtn')?.addEventListener('click', ippanzaiManualSave);
$('#ippanzaiPrintBtn')?.addEventListener('click', () => window.print());
$('#ippanzaiCsvBtn')?.addEventListener('click', exportIppanzaiCsv);
$('#ippanzaiBulkTransferBtn')?.addEventListener('click', transferAllIppanzai);
$('#ippanzaiAppendReasonBtn')?.addEventListener('click', appendOverBudgetCodesToReason);

// 印刷直前に「原価計算書の今後の支出予定額」参考列をDOMから除外し、印刷後に戻す
window.addEventListener('beforeprint', () => {
  if (!$('#ippanzaiPanel') || $('#ippanzaiPanel').hidden) return;
  ippanzaiPrintMode = true;
  renderIppanzaiPanel();
});
window.addEventListener('afterprint', () => {
  if (!ippanzaiPrintMode) return;
  ippanzaiPrintMode = false;
  renderIppanzaiPanel();
});
