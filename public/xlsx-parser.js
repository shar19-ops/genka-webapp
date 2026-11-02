// 基幹システム(OBIC7)の「テンプレート出力」で作られる原価計算書Excel（原価計算書.xlsx）を
// 解析し、pdf-parser.js（GenkaPdfParser.parsePdf）と同じ形の結果を返すモジュール。
// セル番地の固定には頼らず、「コード」「実行合計」等の見出し文字列と「工番」「件名」等の
// ラベルを探して位置を決める（テンプレートの列・行が多少ずれても読めるように）。
// 予算残高などの数式セルは計算結果がファイルに保存されていないことがあるため、
// 値が無い場合はこちらで 実行合計 − 原価合計 を計算する（テンプレートの数式と同じ）。
(function (global) {
  const SECTION_LABELS = {
    A: 'A_主要資材', B: 'B_一般資材', O: 'O_現場経費', C: 'C_労務', D: 'D_その他',
  };
  // OBIC7では3桁（Z50等）のほか、5桁の細目コード（K5002 店舗・事務所工料 等）もある
  const CODE_RE = /^[A-Z0-9]{3,5}$/;
  const HEADER_LABELS = {
    code: 'コード', name: '項目名', jikkou: '実行合計', genka: '原価合計',
    shiharai: '支払額', miharai: '未払額', yosanZangaku: '予算残高',
  };

  const compact = (v) => (v == null ? '' : String(v).replace(/[\s　]/g, ''));
  const pad2 = (n) => String(n).padStart(2, '0');

  function cellText(v, monthOnly = false) {
    if (v == null) return '';
    if (v instanceof Date) {
      const ymd = `${v.getFullYear()}/${pad2(v.getMonth() + 1)}`;
      return monthOnly ? ymd : `${ymd}/${pad2(v.getDate())}`;
    }
    return String(v).trim();
  }

  function toNumber(v) {
    if (typeof v === 'number') return Math.round(v);
    if (v == null) return null;
    const s = String(v).replace(/[,\s]/g, '').replace(/^▲/, '-');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Math.round(parseFloat(s));
  }

  // 「工番 ： 値」のように、ラベルの右側にある最初の値セル（区切りの"："は飛ばす）を返す
  function valueRightOf(row, col) {
    for (let c = col + 1; c < row.length; c++) {
      const t = cellText(row[c]);
      if (t === '' || /^[:：]$/.test(t)) continue;
      return row[c];
    }
    return null;
  }

  function findLabel(rows, label, maxRow) {
    for (let r = 0; r < maxRow; r++) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (compact(row[c]) === label) return { r, c };
      }
    }
    return null;
  }

  // 「(完成月)」「（契約期間）」「（工事担当）」のような括弧付き見出しは、直下の行に値がある。
  // 値の範囲は見出しの列から次の見出しの手前の列まで（契約期間は 開始日・～・終了日 の3セル）。
  function parseBracketLabels(rows, maxRow) {
    const out = {};
    for (let r = 0; r < maxRow; r++) {
      const row = rows[r] || [];
      const labels = [];
      row.forEach((v, c) => {
        const m = /^[(（](.+)[)）]$/.exec(compact(v));
        if (m) labels.push({ c, label: m[1] });
      });
      if (!labels.length) continue;
      const next = rows[r + 1] || [];
      labels.forEach((l, i) => {
        const end = i + 1 < labels.length ? labels[i + 1].c : next.length;
        const parts = [];
        for (let c = l.c; c < end; c++) {
          const t = cellText(next[c], l.label.includes('月') && !l.label.includes('期間'));
          if (t) parts.push(t);
        }
        out[l.label] = parts.join('');
      });
    }
    return out;
  }

  function parseSheet(rows) {
    const headerRowIdx = rows.findIndex((row) => (row || []).some((v) => compact(v) === HEADER_LABELS.code) &&
      (row || []).some((v) => compact(v) === HEADER_LABELS.jikkou));
    if (headerRowIdx < 0) return null;
    const header = rows[headerRowIdx];
    const col = {};
    Object.entries(HEADER_LABELS).forEach(([key, label]) => {
      col[key] = header.findIndex((v) => compact(v) === label);
    });

    // ---- 見出し部（工番・件名・得意先・契約金額・完成月・契約期間・工事担当） ----
    const meta = { koban: '', tokuisaki: '', kenmei: '', kanseiKeijougetsu: '', koki: '', tantou: '', han: '' };
    const labelValue = (label) => {
      const pos = findLabel(rows, label, headerRowIdx);
      return pos ? valueRightOf(rows[pos.r], pos.c) : null;
    };
    meta.koban = compact(cellText(labelValue('工番')));
    meta.kenmei = cellText(labelValue('件名'));
    meta.tokuisaki = compact(cellText(labelValue('得意先') ?? labelValue('得意先名')));
    const bracket = parseBracketLabels(rows, headerRowIdx);
    meta.kanseiKeijougetsu = compact(bracket['完成月'] || bracket['完成計上月'] || '');
    meta.koki = compact(bracket['契約期間'] || bracket['工期'] || '');
    meta.tantou = compact(bracket['工事担当'] || '');
    const keiyakuKingaku = toNumber(labelValue('契約金額'));

    const titleRow = rows.slice(0, headerRowIdx).find((row) => (row || []).some((v) => compact(v).includes('原価計算表')));
    // 同じ行にある「(完成月)」等の括弧付き見出しは除き、「本店 原価計算表」のように事業所名＋帳票名だけにする
    const sourceHeader = titleRow
      ? titleRow.map((v) => cellText(v)).filter((t) => t && !/^[(（].*[)）]$/.test(t)).join(' ') : null;

    // ---- 明細部 ----
    // コード列に3桁コードがある行＝項目行。コードが無く数値だけの行＝小計行（区切り）。
    // 項目行の右端（予算残高より右）に区分記号(A/B/O/C/D)があればそれで区分を決める。
    const items = [];
    const sectionBreaks = [];
    const lastNumCol = Math.max(col.jikkou, col.genka, col.shiharai, col.miharai, col.yosanZangaku);
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const code = compact(row[col.code]);
      const nameText = col.name >= 0 ? compact(row[col.name]) : '';
      if (!code && nameText.includes('合計')) continue; // 総合計行
      const jikkou = toNumber(row[col.jikkou]);
      if (!CODE_RE.test(code)) {
        if (jikkou !== null && !nameText) sectionBreaks.push(items.length);
        continue;
      }
      const genka = toNumber(row[col.genka]) ?? 0;
      let sectionKey = null;
      for (let c = lastNumCol + 1; c < row.length; c++) {
        const t = compact(row[c]);
        if (SECTION_LABELS[t]) { sectionKey = t; break; }
      }
      items.push({
        code,
        name: nameText,
        jikkou: jikkou ?? 0,
        genka,
        shiharai: toNumber(row[col.shiharai]) ?? 0,
        miharai: toNumber(row[col.miharai]) ?? 0,
        yoteiShishutsuFromPdf: null,
        yosanZangaku: (col.yosanZangaku >= 0 ? toNumber(row[col.yosanZangaku]) : null) ?? (jikkou ?? 0) - genka,
        sectionKey,
      });
    }

    const sections = [];
    if (items.length && items.every((it) => it.sectionKey)) {
      // 区分記号で振り分け、A→B→O→C→D の順に並べる
      Object.keys(SECTION_LABELS).forEach((key) => {
        const secItems = items.filter((it) => it.sectionKey === key);
        if (secItems.length) sections.push({ label: SECTION_LABELS[key], items: secItems });
      });
    } else {
      // 区分記号が無い場合は小計行の区切りで振り分ける（新帳票PDFと同じ考え方）
      const rawGroups = [];
      let start = 0;
      sectionBreaks.forEach((end) => { if (end > start) rawGroups.push(items.slice(start, end)); start = end; });
      if (start < items.length) rawGroups.push(items.slice(start));
      if (rawGroups.length >= 4 && rawGroups[2].every((it) => it.code === 'O00')) {
        rawGroups.splice(2, 2, [...rawGroups[2], ...rawGroups[3]]);
      }
      const push = (label, g) => { if (g && g.length) sections.push({ label, items: g }); };
      push('A_主要資材', rawGroups[0]);
      push('B_一般資材', rawGroups[1]);
      if (rawGroups[2]) {
        push('O_現場経費', rawGroups[2].filter((it) => it.code === 'O00'));
        push('C_労務', rawGroups[2].filter((it) => it.code !== 'O00'));
      }
      push('D_その他', rawGroups[3]);
      for (let i = 4; i < rawGroups.length; i++) push(`区分${i + 1}`, rawGroups[i]);
    }
    sections.forEach((sec) => sec.items.forEach((it) => { delete it.sectionKey; }));

    const rawLines = rows.map((row) => (row || []).map((v) => cellText(v)).filter(Boolean).join('  ')).filter(Boolean);
    return {
      meta,
      footer: { keiyakuKingaku, nyukinGaku: null, nyukinZangaku: null, percentages: [] },
      sections,
      rawLines,
      sourceHeader,
    };
  }

  // OBIC7出力のExcelはシートの範囲情報（!ref）が1ページ目（A1:O50）までしか入っておらず、
  // そのまま読むと2ページ目以降の項目が欠落する。実際に存在するセルから範囲を計算し直す。
  function fixSheetRange(ws) {
    let maxR = 0;
    let maxC = 0;
    Object.keys(ws).forEach((key) => {
      if (key[0] === '!') return;
      const { r, c } = XLSX.utils.decode_cell(key);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    });
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  }

  async function parseXlsx(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    // 「コード」「実行合計」の見出しがある最初のシートを対象にする
    for (const name of wb.SheetNames) {
      fixSheetRange(wb.Sheets[name]);
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
      const result = parseSheet(rows);
      if (result) {
        if (!result.meta.koban && /^[0-9A-Z]{6,}$/.test(name)) result.meta.koban = name; // シート名＝工番
        return result;
      }
    }
    throw new Error('原価計算書の見出し（コード・実行合計）が見つかりませんでした。Excelの形式をご確認ください。');
  }

  // ファイル名または先頭バイト（xlsxはZIP形式で"PK"から始まる）でExcelかどうかを判定する
  function isXlsx(arrayBuffer, name) {
    if (name && /\.xlsx$/i.test(name)) return true;
    const head = new Uint8Array(arrayBuffer, 0, Math.min(2, arrayBuffer.byteLength));
    return head[0] === 0x50 && head[1] === 0x4b;
  }

  global.GenkaXlsxParser = { parseXlsx, isXlsx };
})(window);
