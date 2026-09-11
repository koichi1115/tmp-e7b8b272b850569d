# 自由範囲の固定試験データ

- 地域: 東京都杉並区高円寺北
- bbox（南、西、北、東）: `35.701, 139.646, 35.704, 139.650`
- 取得日時: `2026-09-05T22:20:00Z`
- 取得元: `https://overpass.private.coffee/api/interpreter`
- ライセンス: ODbL 1.0
- 帰属: © OpenStreetMap contributors

取得クエリ:

```overpass
[out:json][timeout:90];(way[highway](35.701,139.646,35.704,139.65);way[building](35.701,139.646,35.704,139.65);way[landuse](35.701,139.646,35.704,139.65);way[leisure](35.701,139.646,35.704,139.65);way[natural](35.701,139.646,35.704,139.65);way[water](35.701,139.646,35.704,139.65););out geom;
```

通常の試験は `free-range-sample.json` だけを読み、上記取得元へ接続しません。