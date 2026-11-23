-- 1日の利用回数（利用者ごと・全体・声の推薦）。「上限より少なければ増やす」を 1 つの SQL で行うために D1 に置く
-- （KV は読んでから書くので、同時に大量に送られると上限を超えて通る）
CREATE TABLE usage_counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  -- 日本時間の日付（YYYY-MM-DD）。前の日までの行は消す
  day TEXT NOT NULL
);

CREATE INDEX usage_counters_day ON usage_counters(day);
