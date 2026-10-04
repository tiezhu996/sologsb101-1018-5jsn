/**
 * 批次停用召回领域服务：预览 → 生成召回单 → 冻结下游 → 重启续做
 *
 * 设计要点：
 * - 先预览受影响的胎体、道次、打磨、镶嵌、质检（只读，不改动）。
 * - 同一通报只生成一份召回单：召回单 id 由通报号派生，noticeNo 上有唯一索引，
 *   创建与冻结在同一事务里先查重再写入。
 * - 冻结在单个 rw 事务内对五类下游记录整体打标并保留原值；任一步失败事务回滚，
 *   不留半套标记（要么全冻结，要么全不冻结）。
 * - 冻结只追加 frozenByRecallId / frozenAt / frozenOriginalState，业务字段原值保留。
 * - 重启后 resumePendingRecalls() 把停留 pending 的召回单继续冻结到完成。
 */
import { db } from '@/utils/db';
import type { Table } from 'dexie';
import { recallIdOfNotice, type PaintRecall, type RecallPreview } from '@/types/recall';
import type { Body, BodyState } from '@/types/body';
import type { CoatState } from '@/types/coat';

/** 冻结涉及的全部对象库 */
const FREEZE_TABLES = [
  db.paintBatches,
  db.paintRecalls,
  db.bodies,
  db.coats,
  db.polishes,
  db.inlays,
  db.inspects,
];

/** 预览某批次停用将影响的胎体及五类下游记录（只读） */
export async function buildRecallPreview(batchId: string): Promise<RecallPreview | null> {
  const batch = await db.paintBatches.get(batchId);
  if (!batch) return null;

  // 直接命中：使用了该批次漆料的道次
  const hitCoats = await db.coats.where('paintBatchId').equals(batchId).toArray();
  const bodyIds = [...new Set(hitCoats.map((coat) => coat.bodyId))];

  const [bodiesMaybe, polishes, inlays, inspects] = await Promise.all([
    db.bodies.bulkGet(bodyIds),
    recordsOfBodies(db.polishes, bodyIds),
    recordsOfBodies(db.inlays, bodyIds),
    recordsOfBodies(db.inspects, bodyIds),
  ]);
  const bodies = bodiesMaybe.filter((body): body is Body => body !== undefined);

  return {
    batchId,
    batchNo: batch.batchNo,
    bodies,
    coats: hitCoats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId))),
    polishes,
    inlays,
    inspects,
    counts: {
      bodies: bodies.length,
      coats: hitCoats.length,
      polishes: polishes.length,
      inlays: inlays.length,
      inspects: inspects.length,
    },
  };
}

export interface CreateRecallInput {
  noticeNo: string;
  batchId: string;
  source: string;
  noticeDate: string;
}

export interface CreateRecallResult {
  recall: PaintRecall;
  /** true 表示该通报此前已生成过召回单，本次直接复用，不重复生成 */
  reused: boolean;
}

/**
 * 由供应商通报生成召回单并立即冻结。
 * 同一通报只生成一份：已存在则复用其冻结结果（幂等），不另建单据。
 * 冻结整体在一个事务内完成，失败回滚不留半套标记。
 */
export async function createAndFreezeRecall(input: CreateRecallInput): Promise<CreateRecallResult> {
  const noticeNo = input.noticeNo.trim();
  if (!noticeNo) throw new Error('通报号不能为空');
  const batch = await db.paintBatches.get(input.batchId);
  if (!batch) throw new Error('未找到对应漆料批次');

  const preview = await buildRecallPreview(input.batchId);
  if (!preview) throw new Error('批次不存在，无法生成召回单');

  const recallId = recallIdOfNotice(noticeNo);
  const affectedBodyIds = preview.bodies.map((body) => body.id);

  return db.transaction('rw', FREEZE_TABLES, async () => {
    const existing = await db.paintRecalls.get(recallId);
    if (existing) {
      // 已冻结则原样返回；仍 pending（上次中断）则在本事务内续冻结
      if (existing.status === 'frozen') return { recall: existing, reused: true };
      const frozen = await applyFreezeInTx(existing, affectedBodyIds);
      return { recall: frozen, reused: true };
    }

    // noticeNo 唯一索引兜底并发：同一通报两个标签页同时确认，只有一个能写入
    const duplicateNo = await db.paintRecalls.where('noticeNo').equals(noticeNo).first();
    if (duplicateNo) {
      const frozen =
        duplicateNo.status === 'frozen' ? duplicateNo : await applyFreezeInTx(duplicateNo, affectedBodyIds);
      return { recall: frozen, reused: true };
    }

    const now = Date.now();
    const recall: PaintRecall = {
      id: recallId,
      noticeNo,
      batchId: input.batchId,
      batchNo: batch.batchNo,
      source: input.source,
      noticeDate: input.noticeDate,
      status: 'pending',
      affectedBodyIds,
      counts: { ...preview.counts },
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    // 先落 pending 召回单（持久化中断点），再在同一事务内整体冻结
    await db.paintRecalls.put(recall);
    const frozen = await applyFreezeInTx(recall, affectedBodyIds);
    return { recall: frozen, reused: false };
  });
}

/**
 * 事务内执行整体冻结。幂等：已冻结记录不重复处理。
 * 五类下游记录要么全部打标，要么随事务回滚。
 */
async function applyFreezeInTx(recall: PaintRecall, bodyIds: string[]): Promise<PaintRecall> {
  const now = Date.now();
  const id = recall.id;

  // 胎体：保留原状态到 frozenOriginalState，state 置为 frozen
  let bodyTouched = 0;
  for (const bodyId of bodyIds) {
    const body = await db.bodies.get(bodyId);
    if (!body || body.frozenByRecallId) continue;
    await db.bodies.update(bodyId, {
      frozenByRecallId: id,
      frozenAt: now,
      frozenOriginalState: body.state,
      state: 'frozen' as BodyState,
      updatedAt: now,
    } as never);
    bodyTouched += 1;
  }

  // 道次：仅冻结直接命中该批次的记录，原 state 保留到 frozenOriginalState
  const hitCoats = await db.coats.where('paintBatchId').equals(recall.batchId).toArray();
  let coatTouched = 0;
  for (const coat of hitCoats) {
    if (coat.frozenByRecallId) continue;
    await db.coats.update(coat.id, {
      frozenByRecallId: id,
      frozenAt: now,
      frozenOriginalState: coat.state,
      state: 'recalled' as CoatState,
      updatedAt: now,
    } as never);
    coatTouched += 1;
  }

  // 打磨 / 镶嵌 / 质检：按胎体圈定，仅追加冻结标记，业务值原样保留
  const [polishTouched, inlayTouched, inspectTouched] = await Promise.all([
    freezeByBodies(db.polishes, bodyIds, id, now),
    freezeByBodies(db.inlays, bodyIds, id, now),
    freezeByBodies(db.inspects, bodyIds, id, now),
  ]);

  // 停用漆料批次（保留批次原值，仅置停用 + 通报号）
  const batch = await db.paintBatches.get(recall.batchId);
  if (batch && batch.status !== 'inactive') {
    await db.paintBatches.put({ ...batch, status: 'inactive', noticeNo: recall.noticeNo, updatedAt: now });
  }

  const frozenRecall: PaintRecall = {
    ...recall,
    status: 'frozen',
    affectedBodyIds: bodyIds.length > 0 ? bodyIds : recall.affectedBodyIds,
    counts: {
      bodies: bodyTouched || recall.counts.bodies,
      coats: coatTouched || recall.counts.coats,
      polishes: polishTouched || recall.counts.polishes,
      inlays: inlayTouched || recall.counts.inlays,
      inspects: inspectTouched || recall.counts.inspects,
    },
    lastError: null,
    updatedAt: now,
  };
  await db.paintRecalls.put(frozenRecall);
  return frozenRecall;
}

/** 重启后续做：把所有 pending 召回单继续冻结到完成（逐条独立事务） */
export async function resumePendingRecalls(): Promise<{ resumed: number; failed: PaintRecall[] }> {
  const pending = await db.paintRecalls.where('status').equals('pending').toArray();
  const failed: PaintRecall[] = [];
  let resumed = 0;
  for (const recall of pending) {
    try {
      await db.transaction('rw', FREEZE_TABLES, async () => {
        const preview = await buildRecallPreview(recall.batchId);
        const bodyIds = preview ? preview.bodies.map((body) => body.id) : recall.affectedBodyIds;
        await applyFreezeInTx(recall, bodyIds);
      });
      resumed += 1;
    } catch (error) {
      failed.push(recall);
      const message = error instanceof Error ? error.message : '续冻结失败';
      await db.paintRecalls.update(recall.id, { lastError: message, updatedAt: Date.now() } as never);
    }
  }
  return { resumed, failed };
}

/* ------------------------------ 内部工具 ------------------------------ */

/** 取一批胎体 id 对应的下游记录（打磨 / 镶嵌 / 质检） */
async function recordsOfBodies<T extends { id: string; bodyId: string }>(
  table: Table<T, string>,
  bodyIds: string[],
): Promise<T[]> {
  if (bodyIds.length === 0) return [];
  const set = new Set(bodyIds);
  const all = await table.toArray();
  return all.filter((row) => set.has(row.bodyId));
}

/** 冻结无独立状态流转的下游表（打磨 / 镶嵌 / 质检），仅追加标记，返回新打标数量 */
async function freezeByBodies<T extends { id: string; bodyId: string; frozenByRecallId?: string; frozenAt?: number }>(
  table: Table<T, string>,
  bodyIds: string[],
  recallId: string,
  now: number,
): Promise<number> {
  let touched = 0;
  for (const bodyId of bodyIds) {
    const rows = await table.where('bodyId').equals(bodyId).toArray();
    for (const row of rows) {
      if (row.frozenByRecallId) continue;
      await table.update(row.id, (target) => {
        target.frozenByRecallId = recallId;
        target.frozenAt = now;
      });
      touched += 1;
    }
  }
  return touched;
}
