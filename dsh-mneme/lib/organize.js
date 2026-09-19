// dsh-mneme/src/organize.js
// agent 主动整理接口（issue #231，口径基线 = #164 的「第三腿触发」）：dryRun
// 出比对报告 → agent 判断 → apply 落库；筛除项进归档不删；调用全程留审计回执。
//
// 只做功能本体（维护者口径，issue #231）：落在 service 层并带测试，**不进工具
// 列表、不加独立 opt-in 开关**——#249 到位时只差「注册工具 + 注入指引」一步。
//
// 独立成模块（AGENTS.md 尺寸约定，同 document.js / recall-stats.js 先例）：
// service.js 只做依赖注入 + barrel 出口，调用方零改动。
//
// 三条硬规则，都是「宁可什么都不做」的形态：
// 1. dryRun 不写记忆表：它只读 + 写一行审计（dream_runs）。比对是报告，不是动作。
// 2. apply 必须引用一次真实 dryRun（run_id 且 run_type='organize'）——没有比对过
//    的候选一律不落库，堵死「跳过报告直接写」这条绕过路径。
// 3. 筛除 = 归档（store.setArchived），绝不物理删除：归档可恢复，删除不可逆。
//
// 宽容形态（仓库红线 4，同 issue #89）：单条非法候选/决策跳过 + 应用合法子集 +
// run 记 degraded，不整单拒绝。审计口径复用 dream_runs 的 receipt 语义
// （buildReceipt / parseReceipt 同一格式），不新建审计面。

import { createHash, randomUUID } from "node:crypto";
import { scopeKeyOf } from "./scope.js";
import { cosineSimilarity } from "./dream/clustering.js";
import { buildReceipt } from "./dream.js";

// 与 document 的 C2 档（#230）和 findSessionDuplicate 的 vector 档同源：同一份
// 「近重复」语义只有一个阈值，不在第三个地方另发明一个。
const MIN_SIM = 0.92;
// 向量比对对象的上限（document.js 同口径：精确层全量、向量层有界）。精确层
// 不能截断——同标题漏检会让报告给出错误的 verdict。
const CANDIDATE_LIMIT = 200;
// 单次 dryRun 的候选硬上限：主场景是「长段工作收尾整理」，不是批量导入；不设界
// 的话一次调用会把整库拉进比对。
const MAX_ITEMS = 50;

/**
 * Build the organizer.
 *
 * Injected deps are service.js closure members (store / embedQuery / saveWithDedupe
 * / transaction) so this module stays free of service-internal wiring; `saveWithDedupe`
 * is the normal write path, so its own epilogue (mirror sync / notify / re-embed)
 * is never duplicated here.
 *
 * @returns {{ organize: (payload: object) => Promise<object> }}
 *   `organize({ mode: "dryRun"|"apply", ... })` — 一个入口带 mode 参数（维护者
 *   倾向的形态），内部两个具名函数各自可测。
 */
export function createOrganizer({ store, embedQuery, saveWithDedupe, transaction }) {
  const hashOf = (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

  /**
   * 候选规范化。返回 `{ candidate }` 或 `{ error }`——错误在 dryRun 里进 skipped，
   * 不抛整单（红线 4）。document 刻意在此拦下：它的唯一铸造口是 registerDocument
   * （#230），service 的通用 save 路径也会拒绝，这里提前拦截只是为了报告不撒谎。
   */
  function normalizeCandidate(raw) {
    const type = String(raw?.type ?? "").trim();
    const title = String(raw?.title ?? "").trim();
    const content = String(raw?.content ?? "").trim();
    if (!type || !title || !content) return { error: "type/title/content are required" };
    if (type === "document") return { error: "document rows are minted only via registerDocument (#230)" };
    const candidate = {
      type,
      title,
      content,
      importance: Number.isInteger(raw?.importance) ? Math.min(5, Math.max(1, raw.importance)) : 3,
      tags: [...new Set((Array.isArray(raw?.tags) ? raw.tags : []).map((t) => String(t ?? "").trim()).filter(Boolean))],
      source: String(raw?.source ?? "organize")
    };
    // scope 标注只做搬运（判定在 store / service 侧），省得整理接口成为第二条
    // 绕过 scope 治理的写入通道。
    for (const key of ["sensitivity", "agent_scope", "workspace_scope", "agent_scope_source", "workspace_scope_source"]) {
      if (raw?.[key] !== undefined) candidate[key] = raw[key];
    }
    return { candidate };
  }

  /** 标题归一（同 findSessionDuplicate 的 title 档）：大小写与标点不构成「不同标题」。 */
  const normalizeTitle = (s) => String(s ?? "").toLowerCase().replace(/[\s\p{P}]+/gu, "");

  /** 向量档最佳命中；拿不到向量/嵌入器时返回 null（无信号 = 不判定，不是报错）。 */
  async function bestNear(candidate, rows, vecs) {
    if (!vecs?.size) return null;
    let probe = null;
    try {
      probe = await embedQuery([candidate.title, candidate.content].filter(Boolean).join("\n"));
    } catch {
      return null; // 嵌入器故障只降级比对，不阻塞报告
    }
    if (!probe) return null;
    let best = null;
    for (const m of rows) {
      const v = vecs.get(m.id);
      if (!v) continue; // 无向量的既有行不参与比对
      const sim = cosineSimilarity(probe, v);
      if (sim >= MIN_SIM && (!best || sim > best.sim)) best = { memory: m, sim };
    }
    return best;
  }

  /**
   * 比对报告。**不写记忆表**；只写一行 dream_runs 审计（run_type='organize'）。
   *
   * @param {object} payload
   *   `{ candidates: Array<{type,title,content,importance?,tags?}>, agent_scope?,
   *      workspace_scope?, sensitivity? }`
   * @returns {Promise<{run_id, created_at, status, counts, items, skipped}>}
   *   items[i] = `{ index, type, title, verdict: "exact"|"near"|"new", match }`
   */
  async function dryRun(payload = {}) {
    const raws = Array.isArray(payload.candidates) ? payload.candidates : null;
    if (!raws) throw new Error("organize.dryRun: candidates must be an array");
    const bounded = raws.slice(0, MAX_ITEMS);

    const skipped = [];
    const accepted = [];
    bounded.forEach((raw, index) => {
      const { candidate, error } = normalizeCandidate(raw);
      if (error) skipped.push({ index, error });
      else accepted.push({ index, candidate });
    });

    // scope 同等才比对（跨 scope 永不互判——防泄漏，与 saveWithDedupe 的去重键
    // 「type+title+scope」同口径）。行扫描与向量读取按 type 缓存：一批候选通常
    // 同类型，避免逐条全表扫。
    const scopeMatches = (m) =>
      scopeKeyOf(m.agent_scope) === scopeKeyOf(payload?.agent_scope) &&
      scopeKeyOf(m.workspace_scope) === scopeKeyOf(payload?.workspace_scope) &&
      scopeKeyOf(m.sensitivity) === scopeKeyOf(payload?.sensitivity);
    const rowsByType = new Map();
    const rowsFor = (type) => {
      if (!rowsByType.has(type)) {
        rowsByType.set(type, store.list({ type, limit: null }).filter((m) => !m.archived && scopeMatches(m)));
      }
      return rowsByType.get(type);
    };
    const vecsByType = new Map();
    const vecsFor = (type, rows) => {
      if (!vecsByType.has(type)) {
        vecsByType.set(type, store.getEmbeddings(rows.slice(0, CANDIDATE_LIMIT).map((m) => m.id)));
      }
      return vecsByType.get(type);
    };

    const items = [];
    for (const { index, candidate } of accepted) {
      const rows = rowsFor(candidate.type);
      let item = { index, type: candidate.type, title: candidate.title, verdict: "new", match: null };
      const exact = rows.find((m) => normalizeTitle(m.title) === normalizeTitle(candidate.title));
      if (exact) {
        item = { ...item, verdict: "exact", match: { id: exact.id, title: exact.title, sim: null } };
      } else {
        const near = await bestNear(candidate, rows, vecsFor(candidate.type, rows));
        if (near) {
          item = { ...item, verdict: "near", match: { id: near.memory.id, title: near.memory.title, sim: near.sim } };
        }
      }
      items.push(item);
    }

    const counts = {
      total: items.length,
      exact: items.filter((i) => i.verdict === "exact").length,
      near: items.filter((i) => i.verdict === "near").length,
      new: items.filter((i) => i.verdict === "new").length,
      skipped: skipped.length,
      truncated: raws.length - bounded.length
    };
    // 有被拒的候选 → degraded（如实标记），而不是 ok 掩盖过去；一条都没报 → noop。
    const status = skipped.length ? "degraded" : items.length ? "ok" : "noop";
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const snapshotHash = hashOf(bounded);
    store.saveDreamRun({
      id: runId,
      created_at: createdAt,
      status,
      provider: null,
      model: null,
      snapshot_hash: snapshotHash,
      input_count: bounded.length,
      input: bounded,
      decisions: items,
      applied: 0,
      summary_stored: 0,
      receipt: buildReceipt({ runId, status, snapshotHash, inputCount: bounded.length, applied: 0, summaryStored: false }),
      policy_epoch: 0,
      run_type: "organize",
      ...(skipped.length ? { skipped } : {})
    });
    return { run_id: runId, created_at: createdAt, status, counts, items, skipped };
  }

  /**
   * 按 agent 的判断落库。decisions 逐条：
   *   `{ action: "save", index }`     — 写候选（走 saveWithDedupe：同键自动合并）
   *   `{ action: "discard", index }`  — 不写（只进回执，不删任何东西）
   *   `{ action: "archive", id }`     — 库内被取代的行 → 归档（可恢复，不删）
   *
   * @param {object} payload `{ run_id, decisions }`
   * @param {object} [opts] `{ hiddenIds }` — 调用者 scope 看不见的行按「不存在」
   *   处理（#170 复核项 4：无存在性泄漏），与 document 的 hiddenEvidenceIds 同形。
   * @returns {{run_id, dry_run_id, status, saved, discarded, archived, memory_ids, skipped, degraded}}
   */
  function apply(payload = {}, { hiddenIds = [] } = {}) {
    const dryRunId = String(payload?.run_id ?? "").trim();
    if (!dryRunId) {
      throw new Error("organize.apply: run_id is required (apply must reference a dryRun report)");
    }
    const report = store.getDreamRun(dryRunId);
    if (!report || report.run_type !== "organize") {
      throw new Error(`organize.apply: unknown organize run "${dryRunId}"`);
    }
    const decisions = Array.isArray(payload?.decisions) ? payload.decisions : null;
    if (!decisions) throw new Error("organize.apply: decisions must be an array");

    const input = Array.isArray(report.input) ? report.input : [];
    const hidden = new Set((Array.isArray(hiddenIds) ? hiddenIds : []).map((id) => String(id)));
    const skipped = [];
    const byId = {};
    const memoryIds = [];
    let saved = 0;
    let discarded = 0;
    let archived = 0;

    const runDecisions = () => {
      decisions.forEach((decision, i) => {
        const action = String(decision?.action ?? "").trim();
        if (action === "save") {
          const index = Number(decision?.index);
          const candidate = Number.isInteger(index) ? input[index] : undefined;
          if (!candidate) {
            skipped.push({ index: i, action, error: "candidate index is out of range" });
            return;
          }
          try {
            const result = saveWithDedupe(candidate);
            saved++;
            memoryIds.push(result.memory.id);
            byId[result.memory.id] = action;
          } catch (e) {
            // 单条失败不拖垮整批（红线 4）；原因进 skipped 明细，run 记 degraded。
            skipped.push({ index: i, action, error: String(e?.message ?? e) });
          }
          return;
        }
        if (action === "discard") {
          discarded++;
          return;
        }
        if (action === "archive") {
          const id = String(decision?.id ?? "").trim();
          const row = !id || hidden.has(id) ? null : store.getById(id);
          if (!row) {
            skipped.push({ index: i, action, ids: id ? [id] : [], error: "unknown, archived or out of scope" });
            return;
          }
          if (row.archived) {
            byId[id] = "keep"; // 已归档 = 目标状态已达，不重复计数
            return;
          }
          store.setArchived(id, true);
          archived++;
          byId[id] = action;
          return;
        }
        skipped.push({ index: i, action, error: `unknown action "${action}"` });
      });
    };

    // 批量写在一个事务里：要么整批可见，要么全不可见（不留半批）。单条业务失败
    // 已在上面吞掉，所以这里抛出的都是基础设施级错误 → failed + 原样上抛。
    const applyRunId = randomUUID();
    const createdAt = new Date().toISOString();
    const snapshotHash = report.snapshot_hash;
    const record = (status, error) => store.saveDreamRun({
      id: applyRunId,
      created_at: createdAt,
      status,
      error,
      provider: null,
      model: null,
      snapshot_hash: snapshotHash,
      input_count: input.length,
      input,
      decisions,
      // dry_run_id 是这条回执与它所指报告的连接键：审计能还原「报告 → 判断 → 落地」
      // 三步，而不用新建审计面。
      outcome: { dry_run_id: dryRunId, byId },
      applied: saved + archived,
      summary_stored: 0,
      receipt: buildReceipt({
        runId: applyRunId,
        status,
        snapshotHash,
        inputCount: input.length,
        applied: saved + archived,
        summaryStored: false
      }),
      policy_epoch: 0,
      run_type: "organize",
      ...(skipped.length ? { skipped } : {})
    });

    try {
      transaction(runDecisions);
    } catch (e) {
      record("failed", String(e?.message ?? e));
      throw e;
    }

    // 只有 discard 的批次什么都没改 → noop（绝不虚报 ok）。
    const status = skipped.length ? "degraded" : saved + archived > 0 ? "ok" : "noop";
    record(status, null);
    return {
      run_id: applyRunId,
      dry_run_id: dryRunId,
      status,
      saved,
      discarded,
      archived,
      memory_ids: memoryIds,
      skipped,
      degraded: skipped.length > 0
    };
  }

  async function organize(payload = {}) {
    const mode = String(payload?.mode ?? "dryRun").trim();
    if (mode === "dryRun") return dryRun(payload);
    if (mode === "apply") return apply(payload);
    throw new Error(`organize: unknown mode "${mode}" (dryRun | apply)`);
  }

  return { organize };
}
