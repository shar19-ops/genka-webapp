// 原価計算書PDF（縦書き帳票形式）を解析し、項目データを抽出するモジュール。
// 帳票PDFはテキストの格納順序が視覚上の並びと一致しないことがあるため、
// 座標(x,y)を基準に行を再構成してから列を読み取る。
(function (global) {
  const CODE_RE = /^([A-Z0-9][0-9A-Z][0-9A-Z])\s+(.+)$/;
  const NUM_RE = /-?\d{1,3}(?:,\d{3})*/g;
  const KOBAN_RE = /^\d{2}-\d{3,5}/;

  async function loadPdf(arrayBuffer) {
    // 日本語（CID化フォント）を正しく抽出するためcMapが必須
    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: 'vendor/pdfjs/cmaps/',
      cMapPacked: true,
    });
    return loadingTask.promise;
  }

  // ページのテキストを座標クラスタリングして「行」（セル配列＋結合文字列）に再構成する
  // 帳票PDFはページ自体に回転(page.rotate)がかかっていることがあるため、
  // viewportの変換を適用した「見た目通り」の座標を基準にする。
  async function extractRows(page) {
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const rows = [];
    const Y_TOL = 2.2;

    for (const item of content.items) {
      const str = item.str;
      if (str === undefined) continue;
      const [x, y] = pdfjsLib.Util.applyTransform([item.transform[4], item.transform[5]], viewport.transform);
      let row = rows.find((r) => Math.abs(r.y - y) <= Y_TOL);
      if (!row) {
        row = { y, cells: [] };
        rows.push(row);
      }
      row.cells.push({ x, str, width: item.width || 0 });
    }

    rows.sort((a, b) => a.y - b.y); // viewport変換後は上から下へyが増加する
    rows.forEach((row) => {
      row.cells.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const cell of row.cells) {
        if (prevEnd !== null) {
          const gap = cell.x - prevEnd;
          if (gap > 6) line += '  ';
          else if (gap > 1.5) line += ' ';
        }
        line += cell.str;
        prevEnd = cell.x + cell.width;
      }
      row.text = line.replace(/\s+/g, (m) => (m.length > 1 ? '  ' : ' ')).trim();
    });
    return rows.filter((r) => r.text.length > 0);
  }

  async function extractLines(page) {
    const rows = await extractRows(page);
    return rows.map((r) => r.text);
  }

  // ヘッダーのラベル行（(工番)(得意先名)…）のセルx位置を基準に、
  // 直後の値行のセルを最も近い列へ振り分けて項目ごとの値を取り出す。
  // 単純な空白幅の閾値だけでは列間の余白が短い場合に誤結合するため、座標基準で補正する。
  function extractMetaByColumns(labelRow, valueRow) {
    if (!labelRow || !valueRow) return null;
    // ラベルは "(件" + "名)" のように分割されることがあるため、")"で終わるまで結合する
    const labels = [];
    let buf = null;
    for (const cell of labelRow.cells) {
      if (cell.str.trim() === '') continue;
      if (!buf) buf = { x: cell.x, text: cell.str };
      else buf.text += cell.str;
      if (buf.text.includes(')') || buf.text.includes('）')) {
        labels.push(buf);
        buf = null;
      }
    }
    if (buf) labels.push(buf);
    if (labels.length < 2) return null;

    // 値は左詰めで描画されるためラベルのx位置より若干左から始まることがある。
    // ラベル間の中点を列の境界とすることで、値の開始位置ずれによる誤割当を防ぐ。
    const boundaries = [];
    for (let i = 0; i < labels.length - 1; i++) boundaries.push((labels[i].x + labels[i + 1].x) / 2);

    const buckets = labels.map(() => []);
    for (const cell of valueRow.cells) {
      if (cell.str.trim() === '') continue;
      let best = 0;
      for (let i = 0; i < boundaries.length; i++) {
        if (cell.x >= boundaries[i]) best = i + 1; else break;
      }
      buckets[best].push(cell.str);
    }
    return labels.map((l, i) => ({ label: l.text, value: buckets[i].join('') }));
  }

  function extractNumbers(text) {
    const nums = [];
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text))) {
      nums.push({ text: m[0], value: parseInt(m[0].replace(/,/g, ''), 10), index: m.index });
    }
    return nums;
  }

  function stripNumbers(text, numbers) {
    let out = text;
    for (let i = numbers.length - 1; i >= 0; i--) {
      const n = numbers[i];
      out = out.slice(0, n.index) + out.slice(n.index + n.text.length);
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function isSubtotalLine(line) {
    const compact = line.replace(/\s/g, '');
    return /^\(?小計\)?$/.test(compact) || compact.startsWith('(小計)') || compact.startsWith('（小計）');
  }
  function isGrandTotalLine(line) {
    const compact = line.replace(/\s/g, '');
    return compact.startsWith('(合計)') || compact.startsWith('（合計）');
  }

  // 帳票のバージョンにより数値列は4〜6個ある:
  //  4列: 実行合計/原価合計/支払額/未払額（予算残額なし・当方で算出）
  //  5列: 実行合計/原価合計/支払額/未払額/予算残額
  //  6列: 実行合計/原価合計/支払額/未払額/今後の支出予定/予算残額（システムが既に予定額を保持している版）
  function parseItemRow(line) {
    const m = CODE_RE.exec(line.trim());
    if (!m) return null;
    const code = m[1];
    const rest = m[2];
    const numbers = extractNumbers(rest);
    if (numbers.length < 4) return null;
    // 帳票のバージョンによっては全角文字が1文字ずつ空白を挟んで描画されるため、
    // 項目名の空白は除去する（メタ情報の値と同様の理由）。
    const name = stripNumbers(rest, numbers).replace(/\s/g, '').trim();
    if (!name) return null;

    const tail = numbers.slice(-6);
    let jikkou, genka, shiharai, miharai, yoteiShishutsuFromPdf = null, yosanZangaku;
    if (tail.length >= 6) {
      [jikkou, genka, shiharai, miharai, yoteiShishutsuFromPdf, yosanZangaku] = tail.slice(-6).map((n) => n.value);
    } else if (tail.length >= 5) {
      [jikkou, genka, shiharai, miharai, yosanZangaku] = tail.slice(-5).map((n) => n.value);
    } else {
      [jikkou, genka, shiharai, miharai] = tail.slice(-4).map((n) => n.value);
      yosanZangaku = jikkou - genka;
    }
    return { code, name, jikkou, genka, shiharai, miharai, yoteiShishutsuFromPdf, yosanZangaku };
  }

  function parseMetaLine(line) {
    return KOBAN_RE.test(line.trim());
  }

  // 1ページ目の帳票見出し行（例:"本 店 ＊ ＊ 原 価 計 算 表 ＊ ＊ 2026.07.17 PAGE 1 PLMT6C"）から、
  // 印刷時に「引用元」として表示する文字列を作る。ページ番号(PAGE n)は除外する。
  // 全角文字は1文字ずつ空白を挟んで描画されるため、全角文字同士の間の空白のみ詰める
  // （日付・PAGE表記など半角文字まわりの空白はトークンの区切りとして必要なため残す）。
  function extractSourceHeader(page1Rows) {
    const headerRow = (page1Rows || []).find((r) => /PAGE\s*\d+/i.test(r.text.replace(/\s/g, '')));
    if (!headerRow) return null;
    let text = headerRow.text.replace(/PAGE\s*\d+/i, '');
    text = text.replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, '$1');
    text = text.replace(/\s+/g, ' ').trim();
    return text || null;
  }

  const META_LABEL_MAP = [
    ['koban', '工番'],
    ['tokuisaki', '得意先名'],
    ['kenmei', '件名'],
    ['kanseiKeijougetsu', '完成計上月'],
    ['koki', '工期'],
    ['tantou', '工事担当'],
    ['han', '工事班'],
  ];

  function buildMetaFromColumns(columns) {
    const meta = { koban: '', tokuisaki: '', kenmei: '', kanseiKeijougetsu: '', koki: '', tantou: '', han: '' };
    columns.forEach((col) => {
      const compactLabel = col.label.replace(/[()（）\s]/g, '');
      const found = META_LABEL_MAP.find(([, jp]) => compactLabel.includes(jp));
      // 帳票のバージョンによっては全角文字が1文字ずつ空白を挟んで描画されるため、
      // 値側の空白は除去する（日本語の項目名・会社名等に意味のある空白が
      // 含まれることは通常ないため、除去してよいと判断）。
      if (found) meta[found[0]] = col.value.replace(/\s/g, '').trim();
    });
    // 工期の値（日付範囲）が長い場合、列境界（隣接ラベルx座標の中間点）を
    // わずかに超えてしまい、末尾の数字が工事担当欄の先頭に混入することがある
    // （例:「工期」に "25/09/01～30" だけが残り「工事担当」が "/06/26根間和佳" になる）。
    // 工事担当（氏名）の値が数字・スラッシュで始まることは実際には無いため、
    // 先頭がそのパターンに一致する場合は工期側へ戻す。
    const overflowMatch = meta.tantou.match(/^([\d/～]+)(.*)$/);
    if (overflowMatch && overflowMatch[1]) {
      meta.koki += overflowMatch[1];
      meta.tantou = overflowMatch[2];
    }
    return meta;
  }

  function parseFooterNumbers(lines) {
    const footer = { keiyakuKingaku: null, nyukinGaku: null, nyukinZangaku: null, percentages: [] };
    for (const line of lines) {
      const compact = line.replace(/\s/g, '');
      const nums = extractNumbers(line);
      // "追加工事"欄などにも「契約金額」の語が再登場するため、行頭が
      // "(契約金額)"等で始まる主要サマリー行のみを対象にし、最初の一致を採用する。
      if (footer.keiyakuKingaku === null && /^[(（]契約金額[)）]/.test(compact) && nums.length) {
        footer.keiyakuKingaku = nums[0].value;
      } else if (footer.nyukinGaku === null && /^[(（]入金額[)）]/.test(compact) && nums.length) {
        footer.nyukinGaku = nums[0].value;
      } else if (footer.nyukinZangaku === null && /^[(（]入金残額[)）]/.test(compact) && nums.length) {
        footer.nyukinZangaku = nums[0].value;
      }
      const pct = line.match(/[\d.]+\s*[%％]/g);
      if (pct) footer.percentages.push(...pct.map((p) => ({ label: line.trim(), value: p })));
    }
    return footer;
  }

  async function parsePdf(arrayBuffer) {
    const pdf = await loadPdf(arrayBuffer);
    const pagesRows = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      pagesRows.push(await extractRows(page));
    }
    const page1Rows = pagesRows[0] || null;
    // 帳票の版によっては、メインの集計（工番全体の合計）に続けて、枝番ごとの内訳
    // （"< 23-0081 >  < 23-0081A >" のような山括弧付き見出し行で始まり、実行金額/工事原価/
    // 支払額の列が2組横並びになる別形式）が同じPDFの後続ページに含まれることがある。
    // 列構成が異なり通常の解析ロジックでは正しく読めない（誤集計の原因になる）ため、
    // この山括弧付き見出し行が最初に現れるページ以降は丸ごと解析対象から除外する。
    const branchPageIdx = pagesRows.findIndex((rows) => rows.some((r) => /<[^<>]+>/.test(r.text)));
    const usablePages = branchPageIdx >= 0 ? pagesRows.slice(0, branchPageIdx) : pagesRows;
    const allRows = usablePages.flat();
    const allLines = allRows.map((r) => r.text);
    const sourceHeader = extractSourceHeader(page1Rows);

    // ヘッダーのラベル行（"工番"と"得意先名"を含む行）の直後を値行とみなし、
    // x座標を基準に列を振り分けてメタ情報を取り出す。
    // 帳票のバージョンによっては見出しの全角文字が1文字ずつ間隔を空けて描画され
    // （例:"(工 番 )"）、行の結合文字列に空白が挟まることがあるため、
    // 空白を除去した文字列で判定する（値の列振り分け自体はx座標ベースで別途行うため影響なし）。
    let meta = null;
    const labelRowIdx = allRows.findIndex((r) => {
      const compact = r.text.replace(/\s/g, '');
      return compact.includes('工番') && compact.includes('得意先名');
    });
    if (labelRowIdx >= 0 && allRows[labelRowIdx + 1]) {
      const columns = extractMetaByColumns(allRows[labelRowIdx], allRows[labelRowIdx + 1]);
      if (columns) {
        meta = buildMetaFromColumns(columns);
        // 得意先名が2行に折り返され、続きが単独行として次に出現することがある
        const wrapRow = allRows[labelRowIdx + 2];
        if (wrapRow && !KOBAN_RE.test(wrapRow.text) && !CODE_RE.test(wrapRow.text) &&
            !wrapRow.text.replace(/\s/g, '').includes('項目名') && wrapRow.text.length <= 12) {
          meta.tokuisaki += wrapRow.text;
        }
      }
    }

    const items = [];
    const sectionBreaks = []; // 各(小計)行が出た時点でのitems配列長を記録

    for (const line of allLines) {
      if (isSubtotalLine(line)) {
        sectionBreaks.push(items.length);
        continue;
      }
      if (isGrandTotalLine(line)) continue;
      const row = parseItemRow(line);
      if (row) items.push(row);
    }

    const footer = parseFooterNumbers(allLines);

    // (小計)の区切りをもとに項目を4グループへ分割したうえで、
    // 3番目のグループ（現場経費O00＋工事費K/L系）は現場経費(O00のみ)と
    // 工事費（それ以外）にさらに分割する。
    const rawGroups = [];
    let start = 0;
    sectionBreaks.forEach((end) => {
      if (end > start) rawGroups.push(items.slice(start, end));
      start = end;
    });
    if (start < items.length) rawGroups.push(items.slice(start));

    const sections = [];
    const pushIfAny = (label, groupItems) => {
      if (groupItems && groupItems.length) sections.push({ label, items: groupItems });
    };
    pushIfAny('A_主要資材', rawGroups[0]);
    pushIfAny('B_一般資材', rawGroups[1]);
    if (rawGroups[2]) {
      pushIfAny('O_現場経費', rawGroups[2].filter((it) => it.code === 'O00'));
      pushIfAny('C_労務', rawGroups[2].filter((it) => it.code !== 'O00'));
    }
    pushIfAny('D_その他', rawGroups[3]);
    // 想定外に多くのグループが検出された場合の保険（区分5以降）
    for (let i = 4; i < rawGroups.length; i++) pushIfAny(`区分${i + 1}`, rawGroups[i]);
    if (sections.length === 0 && items.length) {
      sections.push({ label: '項目', items });
    }

    return {
      meta: meta || { koban: '', tokuisaki: '', kenmei: '', kanseiKeijougetsu: '', koki: '', tantou: '', han: '' },
      footer,
      sections,
      rawLines: allLines,
      sourceHeader,
    };
  }

  global.GenkaPdfParser = { parsePdf, extractLines, parseItemRow, extractNumbers };
})(window);
