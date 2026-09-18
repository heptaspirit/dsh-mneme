import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// #217 增量（2026-09-19 拍板）：注入是曝光型访问事件，注入终选集落
// mode='inject' 审计行（跟随 recallRecordDefault；空选不记）。留痕与消费
// 解耦：heatEnabled=false 时行照写，touch（heat 消费侧）不发生。

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  // 与 index.js 相同的接线：审计记账 → recall_runs（best effort）
  service.setRecallRecorder((recall) => {
    store.saveRecallRun({
      query: recall.query,
      mode: recall.mode,
      topK: recall.topK,
      threshold: recall.threshold ?? null,
      candidates: recall.candidates ?? [],
      created_at: recall.createdAt
    });
  });
  return { store, service };
}

const injectRow = (store) =>
  store.listRecallRunsSince(new Date(Date.now() - 86400000).toISOString())
    .rows.find((r) => r.mode === "inject");

test("注入落账：终选集写一行 mode='inject'，candidates 为实际注入条目", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 4 });
  service.saveWithDedupe({ type: "decision", title: "乙", content: "内容乙", importance: 3 });
  const selected = service.injectCandidates({ maxItems: 5 });
  assert.ok(selected.length >= 2);
  const row = injectRow(store);
  assert.ok(row, "注入应落一行审计");
  assert.equal(row.mode, "inject");
  // recall_runs.query 是 NOT NULL（store.js:61）：注入无查询词，用空串而非 null
  assert.equal(row.query, "");
  assert.deepEqual(row.candidates.map((c) => c.id), selected.map((m) => m.id));
  store.close();
});

test("recallRecordDefault=false 不落账（与检索侧同门）", () => {
  const { store, service } = setup({ recallRecordDefault: false });
  service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 4 });
  service.injectCandidates({ maxItems: 5 });
  assert.equal(injectRow(store), undefined);
  store.close();
});

test("空选不落账（没有访问发生）", () => {
  const { store, service } = setup();
  service.injectCandidates({ maxItems: 5 });
  assert.equal(injectRow(store), undefined);
  store.close();
});

test("留痕与消费解耦：heat 关闭时行照写、touch 不发生", () => {
  // 显式 false = 生产 config 经 resolveConfig 后的默认值；touchRecalled 的
  // 门控是 === false 才跳过（service.js:515）
  const { store, service } = setup({ heatEnabled: false });
  const m = service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 4 }).memory;
  const before = store.getById(m.id).last_accessed_at ?? null;
  service.injectCandidates({ maxItems: 5 });
  assert.ok(injectRow(store), "heat 关闭时注入行仍照写");
  assert.equal(store.getById(m.id).last_accessed_at ?? null, before, "touch 属 heat 消费侧，不发生");
  store.close();
});

test("聚合：注入候选计入零曝光判定，注入口径单独报数", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "decision", title: "被注入", content: "被注入候选的内容说明", importance: 4 });
  // importance 2 低于注入阈值 3：活跃但不进注入候选 → 零曝光 → 僵尸
  service.saveWithDedupe({ type: "decision", title: "没动静", content: "低重要度不进注入候选的内容", importance: 2 });
  // 回拨 created_at 避开 nowIso 同毫秒单调顶推的 1ms 豁免边界：刚写入的记忆
  // 可能比 recallStats 的 Date.now() 晚 1ms，exemptDays:0 时会落进豁免桶
  // （宁漏勿误伤），断言就变成看运气。回拨到 10 天前，判定确定性成立。
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  for (const m of store.all()) {
    store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(old, m.id);
  }
  service.injectCandidates({ maxItems: 5 });
  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(stats.injection.runs, 1);
  assert.ok(stats.injection.injectedCount >= 1);
  assert.equal(stats.zombie.activeCount, 2);
  assert.equal(stats.zombie.zombieCount, 1, "被注入的不算僵尸（注入=曝光），未进候选的计僵尸");
  store.close();
});

test("slotFillRate = 注入条数 / (轮数 × 槽位数)", () => {
  const { store, service } = setup();
  for (let i = 0; i < 3; i++) {
    service.saveWithDedupe({ type: "decision", title: `t${i}`, content: "x", importance: 4 });
  }
  service.injectCandidates({ maxItems: 5 });
  const stats = service.recallStats({ windowDays: 30, exemptDays: 0, maxInjectSlots: 4 });
  assert.equal(stats.injection.runs, 1);
  assert.equal(stats.injection.injectedCount, 3);
  assert.equal(stats.injection.slotFillRate, 3 / 4);
  store.close();
});
