// #231：agent 主动整理接口——dryRun 比对报告 → agent 判断 → apply；筛除项进归档
// 不删；调用全程复用 dream_runs 的 receipt 语义（不新建审计面）。维护者口径：
// 功能本体落在 service 层并带测试，不进工具列表、不加独立 opt-in 开关。

import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createOrganizer } from "../src/organize.js";
import { parseReceipt } from "../src/dream.js";

const preference = (title, content = "内容", extra = {}) =>
  ({ type: "preference", title, content, importance: 5, ...extra });

/** 单元级 organizer：假 embedQuery 隔离向量档，写路径复用真 service。 */
function makeOrganizer(embedQuery = async () => null, config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const { organize } = createOrganizer({
    store,
    embedQuery,
    saveWithDedupe: service.saveWithDedupe,
    transaction: service.transaction
  });
  return { store, service, organize };
}

test("#231: dryRun writes no memory and leaves one organize receipt", async () => {
  const { store, service, organize } = makeOrganizer();
  const seeded = service.saveWithDedupe(preference("偏好X", "既有内容")).memory;
  const report = await organize({
    mode: "dryRun",
    candidates: [preference("偏好X", "同一标题的新内容"), { type: "decision", title: "全新决定", content: "库里没有" }]
  });
  assert.equal(report.items[0].verdict, "exact");
  assert.equal(report.items[0].match.id, seeded.id);
  assert.equal(report.items[1].verdict, "new");
  assert.equal(report.counts.total, 2);
  // 比对是报告不是动作：记忆表仍然只有种子那一行。
  assert.equal(store.list({ limit: null }).length, 1);
  const run = store.getDreamRun(report.run_id);
  assert.equal(run.run_type, "organize");
  assert.equal(run.status, "ok");
  assert.equal(run.applied, 0);
  assert.equal(parseReceipt(run.receipt).runId, report.run_id, "receipt 复用 dream 的既有格式");
});

test("#231: dryRun reports near duplicates with similarity (vector layer)", async () => {
  const { store, service, organize } = makeOrganizer(async () => [0.99, 0.1, 0]);
  const seeded = service.saveWithDedupe({ type: "decision", title: "令牌桶限流方案", content: "旧记录" }).memory;
  store.setEmbedding(seeded.id, [1, 0, 0]);
  const report = await organize({
    mode: "dryRun",
    candidates: [{ type: "decision", title: "限流方案选型", content: "内容相近但换了标题" }]
  });
  assert.equal(report.items[0].verdict, "near");
  assert.equal(report.items[0].match.id, seeded.id);
  assert.ok(report.items[0].match.sim > 0.9, "相似度带回报告，供 agent 判断");
  assert.equal(report.counts.near, 1);
});

test("#231: apply refuses to write without a real dryRun report", async () => {
  const { store, organize } = makeOrganizer();
  await assert.rejects(() => organize({ mode: "apply", decisions: [] }), /run_id is required/);
  await assert.rejects(() => organize({ mode: "apply", run_id: "nope", decisions: [] }), /unknown organize run/);
  assert.equal(store.list({ limit: null }).length, 0, "拒绝路径零写入");
});

test("#231: apply saves kept candidates, records discards, archives instead of deleting", async () => {
  const { store, service, organize } = makeOrganizer();
  const stale = service.saveWithDedupe({ type: "project", title: "被取代的状态", content: "过时" }).memory;
  const report = await organize({
    mode: "dryRun",
    candidates: [preference("新偏好"), { type: "decision", title: "被丢掉的决定", content: "不落库" }]
  });
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [
      { action: "save", index: 0 },
      { action: "discard", index: 1 },
      { action: "archive", id: stale.id }
    ]
  });
  assert.equal(outcome.saved, 1);
  assert.equal(outcome.discarded, 1);
  assert.equal(outcome.archived, 1);
  assert.equal(outcome.status, "ok");
  // 筛除 = 归档（可恢复），不是删除。
  assert.equal(store.getById(stale.id).archived, true, "archived row still exists");
  const titles = store.list({ limit: null }).map((m) => m.title);
  assert.ok(titles.includes("新偏好"), "kept candidate landed");
  assert.ok(!titles.includes("被丢掉的决定"), "discarded candidate was not written");
  // 审计链：apply 回执指向它依据的那份报告。
  const applyRun = store.getDreamRun(outcome.run_id);
  assert.equal(applyRun.outcome.dry_run_id, report.run_id);
  assert.equal(applyRun.applied, 2);
  assert.equal(parseReceipt(applyRun.receipt).status, "ok");
});

test("#231: apply tolerates bad decisions — legal subset lands, run is degraded", async () => {
  const { store, organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [preference("能落的")] });
  const outcome = await organize({
    mode: "apply",
    run_id: report.run_id,
    decisions: [
      { action: "save", index: 0 },
      { action: "save", index: 9 },           // 越界
      { action: "archive", id: "m_missing" }, // 未知 id
      { action: "explode", index: 0 }         // 未知动作
    ]
  });
  assert.equal(outcome.saved, 1, "legal subset applied");
  assert.equal(outcome.skipped.length, 3);
  assert.equal(outcome.status, "degraded");
  assert.equal(outcome.degraded, true);
  assert.equal(store.getDreamRun(outcome.run_id).skipped.length, 3, "逐条跳过明细进审计");
});

test("#231: dryRun refuses document candidates (registerDocument is the only mint)", async () => {
  const { organize } = makeOrganizer();
  const report = await organize({ mode: "dryRun", candidates: [{ type: "document", title: "长文", content: "摘要" }] });
  assert.equal(report.counts.total, 0);
  assert.equal(report.status, "degraded");
  assert.match(report.skipped[0].error, /registerDocument/);
});

test("#231: dryRun bounds the batch and reports the truncation", async () => {
  const { organize } = makeOrganizer();
  const report = await organize({
    mode: "dryRun",
    candidates: Array.from({ length: 55 }, (_, i) => preference(`偏好${i}`))
  });
  assert.equal(report.counts.total, 50);
  assert.equal(report.counts.truncated, 5);
});

test("#231: single entry point with a mode parameter, exported through the service barrel", async () => {
  const { service, organize } = makeOrganizer();
  await assert.rejects(() => organize({ mode: "wat" }), /unknown mode/);
  assert.equal(typeof service.organize, "function", "service 层 barrel 出口（调用方零改动）");
  const report = await service.organize({ mode: "dryRun", candidates: [preference("走 service 的")] });
  assert.equal(report.counts.total, 1);
});
