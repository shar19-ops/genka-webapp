/*
 * date-stamp.js — 丸型デート印（日付印）描画ライブラリ
 * 支払伝票PJ / 見積書入力アプリと共通の実装（common-libs/date-stamp.js）を移植。
 * <script src="date-stamp.js"></script> で読み込むとグローバル変数 `DateStamp` が使えるようになる。
 *
 * 使い方:
 *   // Canvas（画面プレビュー）への描画。cx,cy は中心座標（円の中心）
 *   DateStamp.draw(ctx, cx, cy, { name: "佐藤", date: new Date(), color: "red", radius: 50 });
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DateStamp = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var COLORS = {
    black: { r: 0, g: 0, b: 0 },
    red: { r: 0.72, g: 0.06, b: 0.06 }
  };

  function resolveColor(name) {
    return COLORS[name] || COLORS.red;
  }

  function pad2(n, doPad) {
    return doPad ? String(n).padStart(2, "0") : String(n);
  }

  function toYMD(date) {
    if (date instanceof Date) {
      return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
    }
    if (typeof date === "string") {
      var dt = new Date(date);
      return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
    }
    if (date && typeof date === "object") {
      return { y: date.year, m: date.month, d: date.day };
    }
    var now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  }

  function formatDate(date, options) {
    var ymd = toYMD(date);
    var pad = !!options.padZero;
    var m = pad2(ymd.m, pad);
    var d = pad2(ymd.d, pad);
    switch (options.dateFormat) {
      case "kanji":
        return ymd.y + "年" + m + "月" + d + "日";
      case "slash":
        return ymd.y + "/" + m + "/" + d;
      case "yy-slash": // "26/6/25"（年を2桁表記）
        return String(ymd.y).slice(-2) + "/" + m + "/" + d;
      case "dot":
        return ymd.y + "." + m + "." + d;
      default: // "dot-space"（サンプルの "2026. 6. 25" 形式）
        return ymd.y + ". " + m + ". " + d;
    }
  }

  function splitName(options) {
    if (options.nameTop != null || options.nameBottom != null) {
      return { top: options.nameTop || "", bottom: options.nameBottom || "" };
    }
    var name = (options.name || "").trim();
    if (!name) return { top: "", bottom: "" };
    var half = Math.ceil(name.length / 2);
    return { top: name.slice(0, half), bottom: name.slice(half) };
  }

  // 円を3段（上段=名前/下段=名前/中段=日付）に分ける共通レイアウト計算
  function computeLayout(options) {
    var radius = options.radius || 50;
    var bandRatio = options.bandRatio != null ? options.bandRatio : 1 / 3;
    var offset = radius * bandRatio; // 中心から仕切り線までの距離
    var chordHalf = Math.sqrt(Math.max(radius * radius - offset * offset, 0));
    var names = splitName(options);
    return {
      radius: radius,
      offset: offset,
      chordHalf: chordHalf,
      borderWidth: options.borderWidth || Math.max(radius * 0.04, 1.5),
      color: resolveColor(options.color),
      nameTop: names.top,
      nameBottom: names.bottom,
      dateText: formatDate(options.date, options),
      nameFontSize: options.nameFontSize || radius * 0.4,
      dateFontSize: options.dateFontSize || radius * 0.32,
      fontFamily: options.fontFamily || '"Meiryo","Yu Gothic","MS Gothic",sans-serif'
    };
  }

  function measure(options) {
    var radius = options.radius || 50;
    return { width: radius * 2, height: radius * 2, radius: radius };
  }

  // ---- Canvas描画（画面プレビュー用、原点は左上・Y下向き） ----
  function draw(ctx, cx, cy, options) {
    var L = computeLayout(options || {});
    var css = "rgb(" + Math.round(L.color.r * 255) + "," + Math.round(L.color.g * 255) + "," + Math.round(L.color.b * 255) + ")";

    ctx.save();
    ctx.strokeStyle = css;
    ctx.fillStyle = css;
    ctx.lineWidth = L.borderWidth;

    ctx.beginPath();
    ctx.arc(cx, cy, L.radius, 0, Math.PI * 2);
    ctx.stroke();

    if (L.nameTop || L.nameBottom) {
      ctx.beginPath();
      ctx.moveTo(cx - L.chordHalf, cy - L.offset);
      ctx.lineTo(cx + L.chordHalf, cy - L.offset);
      ctx.moveTo(cx - L.chordHalf, cy + L.offset);
      ctx.lineTo(cx + L.chordHalf, cy + L.offset);
      ctx.stroke();
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (L.nameTop) {
      ctx.font = "bold " + L.nameFontSize + "px " + L.fontFamily;
      ctx.fillText(L.nameTop, cx, cy - (L.radius + L.offset) / 2);
    }
    if (L.nameBottom) {
      ctx.font = "bold " + L.nameFontSize + "px " + L.fontFamily;
      ctx.fillText(L.nameBottom, cx, cy + (L.radius + L.offset) / 2);
    }

    ctx.font = "bold " + L.dateFontSize + "px " + L.fontFamily;
    ctx.fillText(L.dateText, cx, cy);

    ctx.restore();
  }

  return {
    draw: draw,
    measure: measure,
    formatDate: formatDate
  };
});
