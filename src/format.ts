/// <reference lib="es2015" />
/**
 * tok/s を人間が読みやすい文字列に変換する純粋関数。
 *
 * 仕様:
 * - 1000 未満: 小数1桁（ただし整数値および小数第1位が 0 の場合は末尾の .0 を除去）
 *   例: 58.3 -> "58.3 tok/s", 999 -> "999 tok/s"
 * - 1000 以上 10000 未満: "X.Xk tok/s"（小数1桁固定。末尾 .0 を保持）
 *   例: 1000 -> "1.0k tok/s", 1200 -> "1.2k tok/s", 9999 -> "10.0k tok/s"
 * - 10000 以上: "Xk tok/s"（整数 k 表記、四捨五入）
 *   例: 10000 -> "10k tok/s", 12345 -> "12k tok/s"
 * - 異常値（NaN, Infinity, 負数）: 計測不能・異常値としてクラッシュさせず "-- tok/s" を返す
 */
export function formatSpeed(n: number): string {
  // NaN, Infinity, 負数はトークン速度として無効値のため、未測定/異常値を示す "-- tok/s" を返す
  if (!Number.isFinite(n) || n < 0) {
    return "-- tok/s";
  }

  if (n < 1000) {
    // 1000 未満は小数1桁。DESIGN.md §6.2 の 999 -> "999 tok/s" を満たすため末尾 .0 は除去する。
    // ただし 999.95 等で四捨五入結果が 1000 に達した場合は、"1000 tok/s" と "1.0k tok/s" の
    // 表示単位の重複・不連続を防ぐため、k 表記（1000 以上 10000 未満）へ繰り上げる。
    const formatted = n.toFixed(1);
    if (Number(formatted) < 1000) {
      return `${formatted.replace(/\.0$/, "")} tok/s`;
    }
  }

  if (n < 10000) {
    // 1000 以上 10000 未満は k 単位で小数1桁固定（1000 -> "1.0k", 9999 -> "10.0k"）
    const formatted = (n / 1000).toFixed(1);
    return `${formatted}k tok/s`;
  }

  // 10000 以上は k 単位で四捨五入した整数表記（10000 -> "10k", 12345 -> "12k"）
  const formatted = Math.round(n / 1000);
  return `${formatted}k tok/s`;
}

/**
 * TTFT (Time to First Token) を "NNN ms" 形式に変換する純粋関数。
 *
 * 仕様:
 * - 整数 ms（四捨五入）
 *   例: 340 -> "340 ms"
 * - 異常値（NaN, Infinity, 負数）: 計測不能・異常値としてクラッシュさせず "-- ms" を返す
 */
export function formatTTFT(ms: number): string {
  // NaN, Infinity, 負数はレイテンシとして無効値のため、未測定/異常値を示す "-- ms" を返す
  if (!Number.isFinite(ms) || ms < 0) {
    return "-- ms";
  }

  return `${Math.round(ms)} ms`;
}
