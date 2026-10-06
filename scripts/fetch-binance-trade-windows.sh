#!/usr/bin/env bash
# Download Binance spot monthly aggTrades, verify each against Binance's own
# checksum, and keep only the trades EXPERIMENT-011 needs: 10 minutes before to
# 70 minutes after each 00:00:00 UTC. The zip is deleted once extracted; its
# SHA-256 is kept in the manifest.
#
#   bash scripts/fetch-binance-trade-windows.sh BTCUSDT 2025-09 2026-09
#
# Output: data/trade-windows/<SYMBOL>-<YYYY-MM>.csv  (ts_us,price,qty,is_buyer_maker)
#         data/trade-windows/manifest.tsv            (symbol, month, zip sha256, rows kept)
set -euo pipefail

symbol=$1
first=$2
last=$3
out="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/trade-windows"
mkdir -p "$out"
base="https://data.binance.vision/data/spot/monthly/aggTrades/$symbol"

month=$first
while :; do
  file="$symbol-aggTrades-$month"
  csv="$out/$symbol-$month.csv"
  if [ ! -s "$csv" ]; then
    zip="$out/$file.zip"
    curl -sf -o "$zip" "$base/$file.zip"
    published=$(curl -sf "$base/$file.zip.CHECKSUM" | awk '{print $1}')
    actual=$(shasum -a 256 "$zip" | awk '{print $1}')
    if [ "$published" != "$actual" ]; then
      echo "CHECKSUM MISMATCH $file: published $published, got $actual" >&2
      exit 1
    fi
    # Binance spot timestamps are microseconds from 2025; older files use ms.
    unzip -p "$zip" | awk -F, '
      {
        ts = $6
        if (length(ts) == 13) ts = ts * 1000
        d = ts % 86400000000
        if (d >= 86400000000 - 600000000 || d <= 4200000000) print ts "," $2 "," $3 "," $7
      }' > "$csv.tmp"
    mv "$csv.tmp" "$csv"
    rows=$(wc -l < "$csv" | tr -d ' ')
    printf '%s\t%s\t%s\t%s\n' "$symbol" "$month" "$actual" "$rows" >> "$out/manifest.tsv"
    rm -f "$zip"
  fi
  [ "$month" = "$last" ] && break
  y=${month%-*}; m=$((10#${month#*-}))
  if [ "$m" -eq 12 ]; then y=$((y + 1)); m=1; else m=$((m + 1)); fi
  month=$(printf '%04d-%02d' "$y" "$m")
done
echo "$symbol done"
