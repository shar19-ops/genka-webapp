# 再取込引継ぎチェックボックス分割 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一工番へのPDF再取込時に、「今後の支出予定・備考欄」と「追加工事契約金額・追加工事予算」を個別に引き継ぐかどうか選べるよう、既存の単一チェックボックスを2つに分割する。

**Architecture:** `public/index.html`の再取込プレビュー画面にあるチェックボックスを1つから2つに分割し、`public/app.js`の`#commitImportBtn`クリックハンドラ内で単一の`carryOver`フラグを`carryOverYotei`/`carryOverTsuika`の2つの独立フラグに置き換える。引継ぎ通知バナー(`#carriedOverNotice`)は、どちらのグループを引き継いだかに応じて文言を出し分けるオブジェクト形式に変更し、分割前の真偽値データとの後方互換も持たせる。フォルダ一括取込(`processFolderImport`)は挙動を変えず、通知データの形式だけ追随させる。

**Tech Stack:** バニラJS（フレームワーク・ビルドステップなし）、Node.js/Express（ローカル起動のみ）、検証はPlaywright（開発時のみ一時インストール）。ユニットテストフレームワークはリポジトリに存在しないため、検証はPlaywrightによるブラウザ操作の実機確認で行う（`DEVLOG.md`5章に記載の既存手法を踏襲）。

## Global Constraints

- 対象は単体のPDF再取込フロー(`#commitImportBtn`)のみ。フォルダ一括取込(`processFolderImport`)の引継ぎ挙動（常に無条件で全項目引継ぎ）は変更しない。
- 契約金額の変更検知に基づく自動引継ぎ／自動クリアのロジックは実装しない（今回はスコープ外）。
- チェックボックスの表示順は「今後の支出予定・備考欄」が先、「追加工事契約金額・追加工事予算」が後。
- 両チェックボックスともデフォルトON（従来の単一チェックボックスと同じ初期状態）。
- 変更対象ファイル（`index.html`/`app.js`/`style.css`いずれか）を変更したら、`index.html`の`?v=`クエリ文字列とヘッダーの`.app-version`表示を同じ値に更新すること（house convention、`DEVLOG.md`6章・10章参照）。
- コード変更と同じコミットまたは直後のコミットで、本セッションの要点を`DEVLOG.md`末尾に追記すること（`DEVLOG.md`冒頭の運用ルール）。
- pushは自動で行わない。ユーザーに確認してから実施する（`DEVLOG.md`10章に記載の既定運用）。

---

### Task 1: 引継ぎチェックボックスの分割とロジック実装

**Files:**
- Modify: `public/index.html:65-68`（再取込プレビューのチェックボックス行）
- Modify: `public/index.html:98-101`（引継ぎ通知バナー）
- Modify: `public/app.js:494-534`（`processFolderImport`内のcarriedOverNotice生成箇所）
- Modify: `public/app.js:594`（`renderPreview`内の表示切替）
- Modify: `public/app.js:599-605`（`#cancelImportBtn`ハンドラ）
- Modify: `public/app.js:607-680`（`#commitImportBtn`ハンドラ）
- Modify: `public/app.js:756-759`（`renderMainView`冒頭、通知バナー表示切替）— 直前にヘルパー関数2つを新設

**Interfaces:**
- Produces: `carriedOverNoticeFlags(project)` — `project.carriedOverNotice`（真偽値またはオブジェクト）を`{ yotei: boolean, tsuika: boolean }`に正規化する純粋関数。以後、通知バナーの表示判定はすべてこの関数経由で行う。
- Produces: `carriedOverNoticeText(flags)` — 上記フラグから通知バナーの表示文言（先頭に`⚠ `を含む完全な文字列）を返す純粋関数。

- [ ] **Step 1: `index.html`のチェックボックス行を2つに分割**

現在の行65-68:
```html
      <label id="reimportCarryOverRow" class="reimport-carry-over-row" hidden>
        <input type="checkbox" id="reimportCarryOverCheckbox" checked>
        追加工事契約金額・追加工事予算・今後の支出予定・備考欄の内容を、この工番の既存データから引き継ぐ（項目コードが一致するもののみ）
      </label>
```

これを以下に置き換える（表示順は今後の支出予定・備考欄が先）:
```html
      <label id="reimportCarryOverYoteiRow" class="reimport-carry-over-row" hidden>
        <input type="checkbox" id="reimportCarryOverYoteiCheckbox" checked>
        今後の支出予定・備考欄の内容を、この工番の既存データから引き継ぐ（項目コードが一致するもののみ）
      </label>
      <label id="reimportCarryOverTsuikaRow" class="reimport-carry-over-row" hidden>
        <input type="checkbox" id="reimportCarryOverTsuikaCheckbox" checked>
        追加工事契約金額・追加工事予算の内容を、この工番の既存データから引き継ぐ（項目コードが一致するもののみ）
      </label>
```

既存の`.reimport-carry-over-row` / `.reimport-carry-over-row[hidden]`スタイル（`style.css`95-101行）をそのまま流用するため、CSSの変更は不要。

- [ ] **Step 2: `index.html`の引継ぎ通知バナーをテキスト差し替え可能な構造に変更**

現在の行98-101:
```html
      <div id="carriedOverNotice" class="warning-banner carried-over-notice no-print" hidden>
        ⚠ 前回のデータから追加工事契約金額・追加工事予算・今後の支出予定・備考欄を引き継ぎました。内容を見直してください。
        <button id="carriedOverDismissBtn" class="btn" type="button">確認しました</button>
      </div>
```

これを以下に置き換える:
```html
      <div id="carriedOverNotice" class="warning-banner carried-over-notice no-print" hidden>
        <span id="carriedOverNoticeText"></span>
        <button id="carriedOverDismissBtn" class="btn" type="button">確認しました</button>
      </div>
```

- [ ] **Step 3: `app.js`に通知フラグ用のヘルパー関数を追加**

`public/app.js`の`function renderMainView() {`（現在756行目）の直前に、以下の2関数を追加する:

```js
// carriedOverNotice: 分割前(旧データ)は真偽値、分割後は {yotei, tsuika} のオブジェクト。
// 旧データ(true)は両方引き継いだものとして扱う(後方互換)。
function carriedOverNoticeFlags(project) {
  const notice = project.carriedOverNotice;
  if (!notice) return { yotei: false, tsuika: false };
  if (notice === true) return { yotei: true, tsuika: true };
  return { yotei: !!notice.yotei, tsuika: !!notice.tsuika };
}

function carriedOverNoticeText(flags) {
  if (flags.yotei && flags.tsuika) {
    return '⚠ 前回のデータから今後の支出予定・備考欄、追加工事契約金額・追加工事予算を引き継ぎました。内容を見直してください。';
  }
  if (flags.yotei) {
    return '⚠ 前回のデータから今後の支出予定・備考欄を引き継ぎました。内容を見直してください。';
  }
  if (flags.tsuika) {
    return '⚠ 前回のデータから追加工事契約金額・追加工事予算を引き継ぎました。内容を見直してください。';
  }
  return '';
}
```

- [ ] **Step 4: `renderMainView`の通知バナー表示切替を新ヘルパー経由に変更**

現在の759行目:
```js
  $('#carriedOverNotice').hidden = !p.carriedOverNotice;
```

これを以下に置き換える:
```js
  const carriedOverFlags = carriedOverNoticeFlags(p);
  const carriedOverAny = carriedOverFlags.yotei || carriedOverFlags.tsuika;
  $('#carriedOverNotice').hidden = !carriedOverAny;
  if (carriedOverAny) $('#carriedOverNoticeText').textContent = carriedOverNoticeText(carriedOverFlags);
```

- [ ] **Step 5: `renderPreview`のチェックボックス表示切替を2行分に変更**

現在の594行目:
```js
  $('#reimportCarryOverRow').hidden = !reimportTargetKoban;
```

これを以下に置き換える:
```js
  $('#reimportCarryOverYoteiRow').hidden = !reimportTargetKoban;
  $('#reimportCarryOverTsuikaRow').hidden = !reimportTargetKoban;
```

- [ ] **Step 6: `#cancelImportBtn`ハンドラの非表示処理を2行分に変更**

現在の599-605行目:
```js
$('#cancelImportBtn').addEventListener('click', () => {
  pendingParseResult = null;
  reimportTargetKoban = null;
  $('#previewArea').hidden = true;
  $('#reimportCarryOverRow').hidden = true;
  setStatus('');
});
```

これを以下に置き換える:
```js
$('#cancelImportBtn').addEventListener('click', () => {
  pendingParseResult = null;
  reimportTargetKoban = null;
  $('#previewArea').hidden = true;
  $('#reimportCarryOverYoteiRow').hidden = true;
  $('#reimportCarryOverTsuikaRow').hidden = true;
  setStatus('');
});
```

- [ ] **Step 7: `#commitImportBtn`ハンドラの引継ぎロジックを2フラグに分割**

現在の607-680行目全体（`$('#commitImportBtn').addEventListener('click', () => { ... });`）を以下に置き換える:

```js
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

  // 引継ぎするかどうかはユーザーが選択（再取込時のみ表示される2つのチェックボックス）。
  // 新規取込（reimportTargetKobanなし）の場合は引き継ぐ元データが無いため常にfalse扱い。
  const carryOverYotei = !!reimportTargetKoban && ($('#reimportCarryOverYoteiCheckbox')?.checked ?? true);
  const carryOverTsuika = !!reimportTargetKoban && ($('#reimportCarryOverTsuikaCheckbox')?.checked ?? true);

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
  const hasPreviousItemState = Object.keys(previousItemState).length > 0;
  const carriedOverNotice = {
    yotei: carryOverYotei && hasPreviousItemState,
    tsuika: carryOverTsuika && hasPreviousItemState,
  };

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
    tsuikaKoujiKeiyaku: carryOverTsuika ? (previousProject?.tsuikaKoujiKeiyaku ?? null) : null,
    stampSlots: previousProject?.stampSlots ?? null,
    stampFlow: previousProject?.stampFlow ?? null,
    carriedOverNotice,
    sections: pendingParseResult.sections.map((sec) => ({
      label: sec.label,
      items: sec.items.map((it) => ({
        ...it,
        // 優先順位: 同工番への再取込時の既存入力（引継ぎを選んだ場合のみ） > PDFに既に記録されている支出予定値 > 0
        yoteiShishutsu: carryOverYotei ? (previousItemState[it.code]?.yoteiShishutsu ?? it.yoteiShishutsuFromPdf ?? 0) : (it.yoteiShishutsuFromPdf ?? 0),
        tsuikaKoji: carryOverTsuika ? (previousItemState[it.code]?.tsuikaKoji ?? 0) : 0,
        memo: carryOverYotei ? (previousItemState[it.code]?.memo ?? '') : '',
      })),
    })),
    sourceInfo: pendingParseResult.sourceInfo,
    sourceHeader: pendingParseResult.sourceHeader,
  };

  saveProject(project);
  currentProject = project;
  pendingParseResult = null;
  reimportTargetKoban = null;
  $('#previewArea').hidden = true;
  $('#reimportCarryOverYoteiRow').hidden = true;
  $('#reimportCarryOverTsuikaRow').hidden = true;
  $('#fileInput').value = '';
  $('#urlInput').value = '';
  setStatus('取り込みました。');
  showMainView();
});
```

- [ ] **Step 8: `processFolderImport`の通知データを新形式に追随（挙動自体は変更なし）**

現在の494-503行目:
```js
      // フォルダ一括取込では既存工番と一致した場合、常に前回データ（追加工事契約金額・
      // 追加工事予算・今後の支出予定・備考欄）を引き継ぐ（1件ごとの確認は行わない）。
      const previousProject = loadProject(koban);
      const previousItemState = {};
      if (previousProject) {
        previousProject.sections.forEach((sec) => sec.items.forEach((it) => {
          previousItemState[it.code] = { yoteiShishutsu: it.yoteiShishutsu, tsuikaKoji: it.tsuikaKoji, memo: it.memo };
        }));
      }
      const carriedOverNotice = Object.keys(previousItemState).length > 0;
```

これを以下に置き換える（`carriedOverNotice`を新しいオブジェクト形式にするだけで、引継ぎ自体の挙動は変えない）:
```js
      // フォルダ一括取込では既存工番と一致した場合、常に前回データ（追加工事契約金額・
      // 追加工事予算・今後の支出予定・備考欄）を引き継ぐ（1件ごとの確認は行わない）。
      const previousProject = loadProject(koban);
      const previousItemState = {};
      if (previousProject) {
        previousProject.sections.forEach((sec) => sec.items.forEach((it) => {
          previousItemState[it.code] = { yoteiShishutsu: it.yoteiShishutsu, tsuikaKoji: it.tsuikaKoji, memo: it.memo };
        }));
      }
      const hasPreviousItemState = Object.keys(previousItemState).length > 0;
      const carriedOverNotice = { yotei: hasPreviousItemState, tsuika: hasPreviousItemState };
```

続けて、現在の534行目:
```js
      results.push({ file: file.name, ok: true, koban, carried: carriedOverNotice, itemCount });
```

これを以下に置き換える（`carriedOverNotice`がオブジェクトになったため、一覧表示用の真偽値には`hasPreviousItemState`を使う。オブジェクトのまま渡すと常にtruthyになり「既存データを引き継ぎ」の表示が誤って毎回出てしまうバグを防ぐため）:
```js
      results.push({ file: file.name, ok: true, koban, carried: hasPreviousItemState, itemCount });
```

- [ ] **Step 9: ローカルサーバーを起動**

Run: `cd "C:\Users\shar1\OneDrive\MCフォルダ\原価計算書\genka-webapp" && npm start`（バックグラウンドで起動。既に起動済みならスキップ）
Expected: `http://localhost:5173` で待受を開始するログが出力される。

- [ ] **Step 10: Playwrightを一時インストール**

Run: `cd "C:\Users\shar1\OneDrive\MCフォルダ\原価計算書\genka-webapp" && npm install --no-save playwright && npx playwright install chromium`
Expected: インストール完了（既存の`package.json`の`dependencies`は変更されない＝`--no-save`）。

- [ ] **Step 11: 検証スクリプトを作成**

`C:\Users\shar1\AppData\Local\Temp\genka-verify-reimport-carryover.js` を新規作成:

```js
const { chromium } = require('playwright');
const fs = require('fs');
const assert = require('assert');

const SAMPLE_PDF = 'C:\\Users\\shar1\\OneDrive\\MCフォルダ\\原価計算書\\サンプルPDF\\原価計算表01020230331.pdf';
const BASE_URL = 'http://localhost:5173';
const STORAGE_PROJECT_PREFIX = 'genka:project:';

async function importPdf(page, filePath) {
  await page.setInputFiles('#fileInput', filePath);
  await page.waitForSelector('#previewArea:not([hidden])');
}

function firstItemInputs(page) {
  return {
    tsuikaKoji: page.locator('input[data-field="tsuikaKoji"]').first(),
    yoteiShishutsu: page.locator('input[data-field="yoteiShishutsu"]').first(),
    memo: page.locator('input.memo-input').first(),
  };
}

// #saveBtnは画面上のクリックだとexportProjectToFile()経由でネイティブの
// ファイル保存ダイアログ(showSaveFilePicker)を開こうとし、ヘッドレス自動化では
// 応答できず停止してしまう。saveProject()はトップレベルのfunction宣言、
// currentProjectはトップレベルのlet宣言のため、同一ページのグローバル
// 実行コンテキストで動くpage.evaluate()からは素の識別子として参照できる
// （devtoolsコンソールから参照できるのと同じ理屈）。ここではそれを利用して
// ダイアログを経由せずlocalStorageへ直接保存する。
async function setPreviousValues(page) {
  const items = firstItemInputs(page);
  await page.fill('[data-proj="tsuikaKoujiKeiyaku"]', '1,000,000');
  await items.tsuikaKoji.fill('50,000');
  await items.yoteiShishutsu.fill('30,000');
  await items.memo.fill('前回メモ');
  await page.evaluate(() => saveProject(currentProject));
}

async function reimportWithCheckboxes(page, { yotei, tsuika }) {
  await page.click('#reimportBtn');
  await importPdf(page, SAMPLE_PDF);
  if ((await page.isChecked('#reimportCarryOverYoteiCheckbox')) !== yotei) {
    await page.setChecked('#reimportCarryOverYoteiCheckbox', yotei);
  }
  if ((await page.isChecked('#reimportCarryOverTsuikaCheckbox')) !== tsuika) {
    await page.setChecked('#reimportCarryOverTsuikaCheckbox', tsuika);
  }
  await page.click('#commitImportBtn');
  await page.waitForSelector('#mainView:not([hidden])');
}

async function readState(page) {
  const items = firstItemInputs(page);
  const noticeHidden = await page.isHidden('#carriedOverNotice');
  return {
    tsuikaKoujiKeiyaku: await page.$eval('[data-proj="tsuikaKoujiKeiyaku"]', (el) => el.value),
    tsuikaKoji: await items.tsuikaKoji.inputValue(),
    yoteiShishutsu: await items.yoteiShishutsu.inputValue(),
    memo: await items.memo.inputValue(),
    noticeHidden,
    noticeText: noticeHidden ? null : await page.$eval('#carriedOverNoticeText', (el) => el.textContent),
  };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (err) => { throw err; });

  // 0. 新規取込：チェックボックス自体が表示されないこと
  await page.goto(BASE_URL);
  await importPdf(page, SAMPLE_PDF);
  assert.strictEqual(await page.isHidden('#reimportCarryOverYoteiRow'), true, '新規取込ではYoteiチェックボックスは非表示のはず');
  assert.strictEqual(await page.isHidden('#reimportCarryOverTsuikaRow'), true, '新規取込ではTsuikaチェックボックスは非表示のはず');
  await page.click('#commitImportBtn');
  await page.waitForSelector('#mainView:not([hidden])');
  const koban = await page.$eval('[data-proj="koban"]', (el) => el.value);
  assert.ok(koban, '工番が取得できていない');

  // 1. 両方ON（デフォルト）：両方引き継がれ、通知は両方の文言
  await setPreviousValues(page);
  await reimportWithCheckboxes(page, { yotei: true, tsuika: true });
  let s = await readState(page);
  assert.strictEqual(s.tsuikaKoujiKeiyaku, '1,000,000', '[両方ON] 予定追加工事契約金額が引き継がれていない');
  assert.strictEqual(s.tsuikaKoji, '50,000', '[両方ON] 追加工事予算が引き継がれていない');
  assert.strictEqual(s.yoteiShishutsu, '30,000', '[両方ON] 今後の支出予定が引き継がれていない');
  assert.strictEqual(s.memo, '前回メモ', '[両方ON] 備考が引き継がれていない');
  assert.strictEqual(s.noticeHidden, false, '[両方ON] 通知バナーが表示されていない');
  assert.ok(s.noticeText.includes('今後の支出予定・備考欄') && s.noticeText.includes('追加工事契約金額・追加工事予算'), `[両方ON] 通知文言が想定と異なる: ${s.noticeText}`);

  // 2. Yoteiのみ ON：今後の支出予定・備考のみ引き継がれ、追加工事系はクリア
  await setPreviousValues(page);
  await reimportWithCheckboxes(page, { yotei: true, tsuika: false });
  s = await readState(page);
  assert.strictEqual(s.tsuikaKoujiKeiyaku, '', '[Yoteiのみ] 予定追加工事契約金額はクリアされるはず');
  assert.strictEqual(s.tsuikaKoji, '0', '[Yoteiのみ] 追加工事予算はクリアされるはず');
  assert.strictEqual(s.yoteiShishutsu, '30,000', '[Yoteiのみ] 今後の支出予定は引き継がれるはず');
  assert.strictEqual(s.memo, '前回メモ', '[Yoteiのみ] 備考は引き継がれるはず');
  assert.strictEqual(s.noticeHidden, false, '[Yoteiのみ] 通知バナーが表示されていない');
  assert.ok(s.noticeText.includes('今後の支出予定・備考欄') && !s.noticeText.includes('追加工事契約金額'), `[Yoteiのみ] 通知文言が想定と異なる: ${s.noticeText}`);

  // 3. Tsuikaのみ ON：追加工事系のみ引き継がれ、今後の支出予定・備考はクリア
  await setPreviousValues(page);
  await reimportWithCheckboxes(page, { yotei: false, tsuika: true });
  s = await readState(page);
  assert.strictEqual(s.tsuikaKoujiKeiyaku, '1,000,000', '[Tsuikaのみ] 予定追加工事契約金額は引き継がれるはず');
  assert.strictEqual(s.tsuikaKoji, '50,000', '[Tsuikaのみ] 追加工事予算は引き継がれるはず');
  assert.notStrictEqual(s.yoteiShishutsu, '30,000', '[Tsuikaのみ] 今後の支出予定はクリアされるはず');
  assert.strictEqual(s.memo, '', '[Tsuikaのみ] 備考はクリアされるはず');
  assert.strictEqual(s.noticeHidden, false, '[Tsuikaのみ] 通知バナーが表示されていない');
  assert.ok(!s.noticeText.includes('今後の支出予定') && s.noticeText.includes('追加工事契約金額・追加工事予算'), `[Tsuikaのみ] 通知文言が想定と異なる: ${s.noticeText}`);

  // 4. 両方OFF：すべてクリアされ、通知バナーは非表示
  await setPreviousValues(page);
  await reimportWithCheckboxes(page, { yotei: false, tsuika: false });
  s = await readState(page);
  assert.strictEqual(s.tsuikaKoujiKeiyaku, '', '[両方OFF] 予定追加工事契約金額はクリアされるはず');
  assert.strictEqual(s.tsuikaKoji, '0', '[両方OFF] 追加工事予算はクリアされるはず');
  assert.notStrictEqual(s.yoteiShishutsu, '30,000', '[両方OFF] 今後の支出予定はクリアされるはず');
  assert.strictEqual(s.memo, '', '[両方OFF] 備考はクリアされるはず');
  assert.strictEqual(s.noticeHidden, true, '[両方OFF] 通知バナーは非表示のはず');

  // 5. 後方互換：分割前(真偽値true)のデータでも「両方引き継いだ」文言になること
  await page.evaluate(({ prefix, koban }) => {
    const key = prefix + koban;
    const raw = JSON.parse(localStorage.getItem(key));
    raw.carriedOverNotice = true;
    localStorage.setItem(key, JSON.stringify(raw));
  }, { prefix: STORAGE_PROJECT_PREFIX, koban });
  await page.reload();
  await page.selectOption('#projectSelect', koban);
  await page.waitForSelector('#mainView:not([hidden])');
  assert.strictEqual(await page.isHidden('#carriedOverNotice'), false, '[後方互換] レガシーtrueで通知バナーが表示されるはず');
  const legacyNoticeText = await page.$eval('#carriedOverNoticeText', (el) => el.textContent);
  assert.ok(legacyNoticeText.includes('今後の支出予定・備考欄') && legacyNoticeText.includes('追加工事契約金額・追加工事予算'), `[後方互換] 通知文言が想定と異なる: ${legacyNoticeText}`);

  // 6. フォルダ一括取込の既存回帰：チェックボックスなしで無条件に全項目引き継がれること
  // （webkitdirectory inputへのsetInputFilesはPlaywrightで正しく動作しないことが
  //  DEVLOG.md 12.4章で判明済みのため、同章と同じDataTransfer経由でchangeイベントを発火する）
  await setPreviousValues(page);
  const pdfBase64 = fs.readFileSync(SAMPLE_PDF).toString('base64');
  await page.evaluate(({ base64, name }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const file = new File([bytes], name, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#folderInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { base64: pdfBase64, name: '原価計算表01020230331.pdf' });
  await page.waitForFunction(() => {
    const el = document.querySelector('#folderImportResultList');
    return el && el.textContent.trim().length > 0;
  });
  const folderResultText = await page.$eval('#folderImportResultList', (el) => el.textContent);
  assert.ok(folderResultText.includes('既存データを引き継ぎ'), `[フォルダ一括] 引継ぎ表示が出ていない: ${folderResultText}`);
  // #projectSelectは既に同じkobanが選択済みの可能性があるため、change イベントを
  // 確実に発火させるため一度空欄を選んでから選び直す。
  await page.selectOption('#projectSelect', '');
  await page.selectOption('#projectSelect', koban);
  await page.waitForSelector('#mainView:not([hidden])');
  s = await readState(page);
  assert.strictEqual(s.tsuikaKoujiKeiyaku, '1,000,000', '[フォルダ一括] 予定追加工事契約金額が引き継がれていない');
  assert.strictEqual(s.tsuikaKoji, '50,000', '[フォルダ一括] 追加工事予算が引き継がれていない');
  assert.strictEqual(s.yoteiShishutsu, '30,000', '[フォルダ一括] 今後の支出予定が引き継がれていない');
  assert.strictEqual(s.memo, '前回メモ', '[フォルダ一括] 備考が引き継がれていない');

  console.log('OK: 全アサーション成功');
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 12: 検証スクリプトを実行**

Run: `node "C:\Users\shar1\AppData\Local\Temp\genka-verify-reimport-carryover.js"`
Expected: `OK: 全アサーション成功` と出力され、終了コード0。失敗した場合はアサーションメッセージを見て該当ステップの実装を修正し、再実行する。

- [ ] **Step 13: 検証スクリプトとPlaywrightを片付ける**

Run:
```bash
rm "C:\Users\shar1\AppData\Local\Temp\genka-verify-reimport-carryover.js"
cd "C:\Users\shar1\OneDrive\MCフォルダ\原価計算書\genka-webapp" && npm uninstall --no-save playwright
```
Expected: `package.json`に`playwright`が追加されていないこと（`git diff package.json`で無変更を確認）。

- [ ] **Step 14: コミット**

```bash
cd "C:\Users\shar1\OneDrive\MCフォルダ\原価計算書\genka-webapp"
git add public/index.html public/app.js
git commit -m "$(cat <<'EOF'
feat: 再取込時の引継ぎチェックボックスを2つに分割

今後の支出予定・備考欄と、追加工事契約金額・追加工事予算を
個別に引き継ぐかどうか選べるようにした。フォルダ一括取込の挙動は変更なし。
EOF
)"
```

---

### Task 2: 操作説明書(manual.html)の更新

**Files:**
- Modify: `public/manual.html`（「再取込時のデータ引き継ぎ」章、現在261-267行目付近。Task 1のコミット後は行番号がずれる可能性があるため、`再取込時のデータ引き継ぎ`という見出し文字列で検索して特定すること）

**Interfaces:**
- Consumes: Task 1で完成した2チェックボックスUI（`#reimportCarryOverYoteiCheckbox`/`#reimportCarryOverTsuikaCheckbox`）

`public/manual.html`は埋め込みbase64画像により1MB超・特定行が数十万トークンに達するため、**Readツール・Editツールで直接開かない**こと。`DEVLOG.md`13.2章に記載の既存手法（Node.jsスクリプトを`fs.readFileSync`→文字列置換→`fs.writeFileSync`で実行し、base64画像はNode側で都度エンコードして会話コンテキストに一切出力しない）を踏襲する。

- [ ] **Step 1: 現在の説明文をGrepで確認**

Run: `grep -n "再取込時のデータ引き継ぎ" -A 8 "C:\Users\shar1\OneDrive\MCフォルダ\原価計算書\genka-webapp\public\manual.html"`
Expected: 見出し行と、旧文言「取込プレビュー画面のチェックボックスで「追加工事契約金額・追加工事予算・今後の支出予定・備考欄」を前回のデータから引き継ぐかどうかを選べます」を含む段落が出力される。

- [ ] **Step 2: 説明文を2チェックボックス仕様に書き換えるNode.jsスクリプトを作成・実行**

`C:\Users\shar1\AppData\Local\Temp\genka-update-manual-carryover-text.js` を作成:

```js
const fs = require('fs');
const path = 'C:\\Users\\shar1\\OneDrive\\MCフォルダ\\原価計算書\\genka-webapp\\public\\manual.html';
let html = fs.readFileSync(path, 'utf8');

const oldText = '同じ工番にPDFを再取込する際は、取込プレビュー画面のチェックボックスで「追加工事契約金額・追加工事予算・今後の支出予定・備考欄」を前回のデータから引き継ぐかどうかを選べます（項目コードが一致する項目のみ引き継がれます）。通常はチェックを入れたまま（初期状態）で構いません。';
const newText = '同じ工番にPDFを再取込する際は、取込プレビュー画面の2つのチェックボックス「今後の支出予定・備考欄」「追加工事契約金額・追加工事予算」で、それぞれを前回のデータから引き継ぐかどうかを個別に選べます（項目コードが一致する項目のみ引き継がれます）。通常はどちらもチェックを入れたまま（初期状態）で構いません。';

if (!html.includes(oldText)) throw new Error('oldText not found');
html = html.replace(oldText, newText);
fs.writeFileSync(path, html, 'utf8');
console.log('manual.html text updated');
```

Run: `node "C:\Users\shar1\AppData\Local\Temp\genka-update-manual-carryover-text.js"`
Expected: `manual.html text updated` と出力される。

- [ ] **Step 3: スクリーンショットを新UIで再撮影するNode.jsスクリプトを作成・実行**

ローカルサーバー(`npm start`)が起動済みであることを確認したうえで、`C:\Users\shar1\AppData\Local\Temp\genka-reshoot-manual-carryover.js` を作成:

```js
const { chromium } = require('playwright');
const fs = require('fs');

const SAMPLE_PDF = 'C:\\Users\\shar1\\OneDrive\\MCフォルダ\\原価計算書\\サンプルPDF\\原価計算表01020230331.pdf';
const MANUAL_PATH = 'C:\\Users\\shar1\\OneDrive\\MCフォルダ\\原価計算書\\genka-webapp\\public\\manual.html';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto('http://localhost:5173');
  await page.setInputFiles('#fileInput', SAMPLE_PDF);
  await page.waitForSelector('#previewArea:not([hidden])');
  await page.click('#commitImportBtn');
  await page.waitForSelector('#mainView:not([hidden])');
  await page.click('#reimportBtn');
  await page.setInputFiles('#fileInput', SAMPLE_PDF);
  await page.waitForSelector('#reimportCarryOverYoteiRow:not([hidden])');

  const shot = await page.locator('#previewArea').screenshot();
  const base64 = shot.toString('base64');

  let html = fs.readFileSync(MANUAL_PATH, 'utf8');
  // 既存の「再取込時のデータ引き継ぎ」章にある<figure>内の<img>のsrcだけを対象に、
  // 直後に来る最初のbase64画像行(data:image/png;base64,...)をピンポイントで置換する。
  const anchor = html.indexOf('再取込時のデータ引き継ぎ');
  if (anchor === -1) throw new Error('anchor not found');
  const imgStart = html.indexOf('data:image/png;base64,', anchor);
  if (imgStart === -1) throw new Error('image not found after anchor');
  const imgEnd = html.indexOf('"', imgStart);
  html = html.slice(0, imgStart) + 'data:image/png;base64,' + base64 + html.slice(imgEnd);
  fs.writeFileSync(MANUAL_PATH, html, 'utf8');

  console.log('screenshot replaced, bytes:', base64.length);
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Run: `node "C:\Users\shar1\AppData\Local\Temp\genka-reshoot-manual-carryover.js"`
Expected: `screenshot replaced, bytes: <数値>` と出力される。

**注意**: 実行前に必ず`grep -n "再取込時のデータ引き継ぎ" -A 5 public/manual.html`で該当`<figure>`が本当にその見出し直後にあるか、対象の`<img>`が1つだけかを確認すること（`DEVLOG.md`13.2章の注意点と同様、アンカー文字列の一致・対象の一意性を事前に確かめてから機械的な置換を行う）。

- [ ] **Step 4: 目視確認**

Run: `node -e "const {chromium}=require('playwright'); (async()=>{const b=await chromium.launch(); const p=await b.newPage(); await p.goto('file://C:/Users/shar1/OneDrive/MCフォルダ/原価計算書/genka-webapp/public/manual.html'); await p.screenshot({path:'C:/Users/shar1/AppData/Local/Temp/manual-check.png', fullPage:false}); await b.close();})()"`

Readツールで`C:\Users\shar1\AppData\Local\Temp\manual-check.png`を開き、ページが正常に表示され破損していないことを確認する。問題なければ`C:\Users\shar1\AppData\Local\Temp\genka-update-manual-carryover-text.js`・`genka-reshoot-manual-carryover.js`・`manual-check.png`を削除する。

- [ ] **Step 5: コミット**

```bash
cd "C:\Users\shar1\OneDrive\MCフォルダ\原価計算書\genka-webapp"
git add public/manual.html
git commit -m "docs: 操作説明書を再取込引継ぎチェックボックス分割に合わせて更新"
```

---

### Task 3: キャッシュバスティング更新・DEVLOGへの追記・最終コミット

**Files:**
- Modify: `public/index.html:9,187-190`（`?v=`クエリ文字列）
- Modify: `public/index.html:13`（`.app-version`表示）
- Modify: `DEVLOG.md`（末尾に本セッションの要点を追記）

**Interfaces:**
- Consumes: Task 1・Task 2で完了した実装内容（このタスクはコード変更を伴わず、house conventionの後始末とドキュメント化のみ）

- [ ] **Step 1: キャッシュバスティング文字列を更新**

`public/index.html`内の以下4箇所の`?v=20260719a`をすべて`?v=20260728a`に置き換える（9行目・187〜190行目）:
```html
<link rel="stylesheet" href="style.css?v=20260719a">
```
```html
<script src="pdf-parser.js?v=20260719a"></script>
<script src="date-stamp.js?v=20260719a"></script>
<script src="app.js?v=20260719a"></script>
<script src="ippanzai-keikoku.js?v=20260719a"></script>
```
それぞれ`20260719a`→`20260728a`に変更。

- [ ] **Step 2: ヘッダーのバージョン表示を更新**

現在の13行目:
```html
  <h1>原価計算書アプリ <span class="app-version">v20260719a</span></h1>
```
これを以下に置き換える:
```html
  <h1>原価計算書アプリ <span class="app-version">v20260728a</span></h1>
```

- [ ] **Step 3: ブラウザで表示崩れがないことを目視確認**

Run: `node -e "const {chromium}=require('playwright'); (async()=>{const b=await chromium.launch(); const p=await b.newPage(); p.on('pageerror',e=>{throw e}); await p.goto('http://localhost:5173'); await p.screenshot({path:'C:/Users/shar1/AppData/Local/Temp/genka-topcheck.png'}); await b.close();})()"`

Readツールで`C:\Users\shar1\AppData\Local\Temp\genka-topcheck.png`を確認し、`pageerror`が発生していない（コマンドが正常終了している）ことも確認する。確認後、画像ファイルを削除する。

- [ ] **Step 4: `DEVLOG.md`に本セッションの要点を追記**

`DEVLOG.md`の末尾（677行目の後）に、以下の見出しと内容を追記する（見出し番号は直前の「## 14. アプリ名・表記を「原価計算表」→「原価計算書」に統一（2026-07-19）」に続く「## 15.」とする）:

```markdown

## 15. 再取込時の引継ぎチェックボックスを2グループに分割（2026-07-28）

同一工番へのPDF再取込時、従来は「追加工事契約金額・追加工事予算・今後の支出予定・備考欄」をまとめて引き継ぐかどうかを選ぶチェックボックスが1つだけだったが、ユーザーから「今後の支出予定・備考欄」と「追加工事契約金額・追加工事予算」を個別に引き継ぎ選択したいという要望を受けた。

### 検討の経緯
当初は「契約金額が変更されていなければ自動的に引き継ぎ、変更されていれば自動的にクリアする」という自動判定案も検討したが、ブレインストーミングの結果、契約金額変更の自動検知は今回のスコープから外し、単純に既存のチェックボックスを2つに分割するだけのシンプルな変更として実装することでユーザーと合意した。

### 実装内容
- 取込プレビュー画面のチェックボックスを、「今後の支出予定・備考欄」用（`#reimportCarryOverYoteiCheckbox`）と「追加工事契約金額・追加工事予算」用（`#reimportCarryOverTsuikaCheckbox`）の2つに分割（表示順はこの順）。ともにデフォルトON
- `#commitImportBtn`のクリックハンドラで、`carryOverYotei`/`carryOverTsuika`の2つの独立フラグとして扱うよう変更。各フラグがOFFの項目は、従来の「引継がない」場合と同じ初期値（今後の支出予定はPDFの値またはゼロ、備考は空文字、追加工事予算はゼロ、予定追加工事契約金額はnull）にクリアされる
- 引継ぎ通知バナー（`#carriedOverNotice`）の内部データを真偽値から`{ yotei, tsuika }`のオブジェクトに変更し、実際に引き継いだ組み合わせに応じて文言を出し分けるようにした。分割前に保存されたプロジェクトデータの`carriedOverNotice: true`は「両方引き継いだ」相当として扱う後方互換ロジック（`carriedOverNoticeFlags()`）を追加
- フォルダ一括取込（`processFolderImport`）は挙動自体は変更せず（従来通り常に全項目を無条件で引き継ぐ）、通知データの形式だけ新しいオブジェクト形式に追随させた。あわせて、結果一覧表示用の`carried`フラグに引継ぎオブジェクトそのものを渡すと常にtruthyになり「既存データを引き継ぎ」の表示が常に出てしまう不具合の芽があったため、`hasPreviousItemState`（実際に前回データが存在したか）の真偽値を渡すよう明示した
- 操作説明書（`manual.html`）の「再取込時のデータ引き継ぎ」章を2チェックボックス仕様に合わせて文言・スクリーンショットを更新

### 検証
Playwrightで実サンプルPDF（`原価計算表01020230331.pdf`）を用い、新規取込時はチェックボックス自体が表示されないこと、再取込時に「今後の支出予定・備考欄」のみ引継ぎを選んだ場合に追加工事契約金額・追加工事予算が正しくクリアされ今後の支出予定・備考は引き継がれること、通知バナーの文言が引き継いだ組み合わせに応じて正しく出し分けられることを確認した。
```

- [ ] **Step 5: 最終コミット**

```bash
cd "C:\Users\shar1\OneDrive\MCフォルダ\原価計算書\genka-webapp"
git add public/index.html DEVLOG.md
git commit -m "chore: キャッシュバージョンを20260728aに更新しDEVLOGへ追記"
git log --oneline -6
```

Expected: 直近のコミットに、Task 1（feat）・Task 2（docs）・Task 3（chore）の3件が並んでいる。

- [ ] **Step 6: ユーザーへ完了報告し、pushの要否を確認する**

このリポジトリはpushを都度ユーザーに確認してから行う運用（`DEVLOG.md`10章）のため、ここでは`push`を実行せず、実装内容とコミット一覧を報告してユーザーの指示を待つ。
