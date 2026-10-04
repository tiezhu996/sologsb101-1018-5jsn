/**
 * 漆料领用、对账与批次召回领域服务（纯 Dexie 事务）
 *
 * 关键保证：
 * 1. 领用登记在单个 IndexedDB readwrite 事务内完成「校验 + 余量检查 + 扣减 + 写流水」，
 *    两个标签页同时登记时 IndexedDB 会串行化同库事务；余量不足抛错，事务整体回滚，
 *    不会出现「写了流水但没扣减」或「扣减成负数」的半成品。
 * 2. 召回冻结在单个 readwrite 事务内给全部下游记录打标，任何一步失败整体回滚，
 *    不留半套冻结标记；召回单先置「冻结中」并落库，进程中断后重启可继续处理。
 * 3. recallOrders 的 noticeNo 为唯一索引，同一供应商通报只允许生成一份召回单。
 */
import type { Table } from 'dexie';
import { db, createId, FREEZE_TABLES } from './db';
import { UNTRACED_BATCH_ID } from '@/types/freeze';
import type {
  PaintBatch,
  PaintUsage,
  PaintUsageDraft,
  RecallNoticeDraft,
  RecallOrder,
  RecallPreview,
  RecallPreviewSection,
  RecallTargetKind,
  RecallTargets,
} from '@/types/paint';

/** 领用 / 召回业务错误，UI 直接展示其 message */
export class PaintServiceError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaintServiceError';
    this.code = code;
  }
}

/* ------------------------------ 漆料批次 ------------------------------ */

export async function createPaintBatch(input: {
  batchNo: string;
  kind: PaintBatch['kind'];
  colorName: string;
  supplier: string;
  producedDate: string;
  unit: PaintBatch['unit'];
  receivedQty: number;
  note?: string;
}): Promise<PaintBatch> {
  const batchNo = input.batchNo.trim();
  if (batchNo.length === 0) throw new PaintServiceError('BATCH_NO_EMPTY', '请填写漆料批次号');
  if (!(input.receivedQty > 0)) throw new PaintServiceError('BATCH_QTY_INVALID', '入库量必须大于 0');
  const existed = await db.paintBatches.where('batchNo').equals(batchNo).first();
  if (existed) throw new PaintServiceError('BATCH_NO_DUPLICATE', `批次号 ${batchNo} 已登记，请勿重复入库`);
  const now = Date.now();
  const batch: PaintBatch = {
    id: createId('pb'),
    batchNo,
    kind: input.kind,
    colorName: input.colorName.trim(),
    supplier: input.supplier.trim(),
    producedDate: input.producedDate,
    unit: input.unit,
    receivedQty: input.receivedQty,
    remainingQty: input.receivedQty,
    status: 'active',
    note: input.note ?? '',
    createdAt: now,
    updatedAt: now,
  };
  await db.paintBatches.put(batch);
  return batch;
}

/* ------------------------------ 领用登记（事务扣减） ------------------------------ */

/**
 * 登记领用并扣减台账余量。
 * 整个过程在一个 rw 事务内：任一步失败（批次停用 / 余量不足 / 关联记录不存在）
 * 都由 IndexedDB 自动回滚，扣减失败不留任何写入。
 */
export async function registerPaintUsage(draft: PaintUsageDraft): Promise<PaintUsage> {
  if (draft.batchId === UNTRACED_BATCH_ID) {
    throw new PaintServiceError('UNTRACED_NOT_ALLOWED', '未追溯批次不能登记新领用，请先选择具体漆料批次');
  }
  if (!(draft.qty > 0)) throw new PaintServiceError('USAGE_QTY_INVALID', '领用量必须大于 0');
  if (draft.process === 'coat' && !draft.coatId) {
    throw new PaintServiceError('COAT_REQUIRED', '髹涂工序领用必须关联具体道次');
  }
  if (draft.process === 'inlay' && !draft.inlayId) {
    throw new PaintServiceError('INLAY_REQUIRED', '镶嵌工序领用必须关联具体镶嵌记录');
  }

  return db.transaction('rw', [db.paintBatches, db.paintUsages, db.coats, db.inlays], async () => {
    const batch = await db.paintBatches.get(draft.batchId);
    if (!batch) throw new PaintServiceError('BATCH_NOT_FOUND', '漆料批次不存在或已删除');
    if (batch.status !== 'active') {
      throw new PaintServiceError('BATCH_INACTIVE', `批次 ${batch.batchNo} 已被供应商通报停用，不能再领用`);
    }
    if (draft.process === 'coat' && draft.coatId) {
      const coat = await db.coats.get(draft.coatId);
      if (!coat) throw new PaintServiceError('COAT_NOT_FOUND', '关联的髹涂道次不存在');
      if (coat.frozen) throw new PaintServiceError('TARGET_FROZEN', '关联道次已被召回冻结，不能登记领用');
    }
    if (draft.process === 'inlay' && draft.inlayId) {
      const inlay = await db.inlays.get(draft.inlayId);
      if (!inlay) throw new PaintServiceError('INLAY_NOT_FOUND', '关联的镶嵌记录不存在');
      if (inlay.frozen) throw new PaintServiceError('TARGET_FROZEN', '关联镶嵌记录已被召回冻结，不能登记领用');
    }

    // 条件扣减：余量不足时抛错，事务整体回滚（流水与余量都不会落库）
    if (batch.remainingQty < draft.qty) {
      throw new PaintServiceError(
        'INSUFFICIENT_STOCK',
        `批次 ${batch.batchNo} 可用余量仅 ${batch.remainingQty} ${batch.unit}，不足本次领用 ${draft.qty} ${batch.unit}，已取消登记`,
      );
    }
    const updated = await db.paintBatches.update(batch.id, {
      remainingQty: batch.remainingQty - draft.qty,
      updatedAt: Date.now(),
    });
    // update 返回 0 说明记录在事务内被其他写入删掉（并发防护），抛错触发回滚
    if (updated === 0) {
      throw new PaintServiceError('BATCH_CHANGED', '漆料台账在登记期间发生变动，请重试');
    }

    const now = Date.now();
    const usage: PaintUsage = {
      id: createId('usage'),
      batchId: batch.id,
      batchNo: batch.batchNo,
      process: draft.process,
      bodyId: draft.bodyId,
      coatId: draft.coatId,
      inlayId: draft.inlayId,
      qty: draft.qty,
      unit: batch.unit,
      operator: draft.operator.trim(),
      usageDate: draft.usageDate,
      note: draft.note.trim(),
      createdAt: now,
      updatedAt: now,
    };
    await db.paintUsages.put(usage);
    return usage;
  });
}

/* ------------------------------ 对账 ------------------------------ */

export interface BatchReconcileRow {
  batch: PaintBatch;
  /** 髹涂工序领用合计 */
  coatUsed: number;
  /** 镶嵌工序领用合计 */
  inlayUsed: number;
  usedTotal: number;
  /** 理论余量 = 入库 − 领用合计 */
  expectedRemaining: number;
  /** 台账余量与理论余量的差额，0 表示账实相符 */
  diff: number;
  balanced: boolean;
}

/** 按批次汇总领用并与台账余量对账 */
export async function reconcileBatches(): Promise<BatchReconcileRow[]> {
  const [batches, usages] = await Promise.all([db.paintBatches.toArray(), db.paintUsages.toArray()]);
  return batches
    .map((batch) => {
      const batchUsages = usages.filter((usage) => usage.batchId === batch.id);
      const coatUsed = batchUsages
        .filter((usage) => usage.process === 'coat')
        .reduce((sum, usage) => sum + usage.qty, 0);
      const inlayUsed = batchUsages
        .filter((usage) => usage.process === 'inlay')
        .reduce((sum, usage) => sum + usage.qty, 0);
      const usedTotal = coatUsed + inlayUsed;
      const expectedRemaining = batch.receivedQty - usedTotal;
      const diff = batch.remainingQty - expectedRemaining;
      return { batch, coatUsed, inlayUsed, usedTotal, expectedRemaining, diff, balanced: diff === 0 };
    })
    .sort((a, b) => a.batch.batchNo.localeCompare(b.batch.batchNo));
}

/* ------------------------------ 召回：预览 ------------------------------ */

/**
 * 预览停用批次影响到的胎体、道次、打磨、镶嵌、质检。
 * 追溯链：批次 → 道次（coat.batchId）/ 镶嵌（inlay.batchId）→ 胎体；
 * 打磨按胎体 + 道次关联，质检按胎体关联。
 */
export async function buildRecallPreview(batchId: string): Promise<RecallPreview> {
  const batch = await db.paintBatches.get(batchId);
  if (!batch) throw new PaintServiceError('BATCH_NOT_FOUND', '漆料批次不存在或已删除');

  const coats = await db.coats.where('batchId').equals(batchId).toArray();
  const inlays = await db.inlays.where('batchId').equals(batchId).toArray();
  const bodyIdSet = new Set<string>([...coats.map((c) => c.bodyId), ...inlays.map((i) => i.bodyId)]);

  const [bodiesAll, polishesAll, inspectsAll] = await Promise.all([
    db.bodies.toArray(),
    db.polishes.toArray(),
    db.inspects.toArray(),
  ]);
  const bodyIds = bodiesAll.filter((body) => bodyIdSet.has(body.id)).map((body) => body.id);
  const affectedCoatSeqByBody = new Map<string, Set<number>>();
  coats.forEach((coat) => {
    const set = affectedCoatSeqByBody.get(coat.bodyId) ?? new Set<number>();
    set.add(coat.seq);
    affectedCoatSeqByBody.set(coat.bodyId, set);
  });
  const polishRows = polishesAll.filter((polish) => {
    const seqs = affectedCoatSeqByBody.get(polish.bodyId);
    return seqs !== undefined && seqs.has(polish.seq);
  });
  const polishIds = polishRows.map((polish) => polish.id);
  const inspectRows = inspectsAll.filter((inspect) => bodyIdSet.has(inspect.bodyId));
  const inspectIds = inspectRows.map((inspect) => inspect.id);
  const coatIds = coats.map((coat) => coat.id);
  const inlayIds = inlays.map((inlay) => inlay.id);

  const sections: RecallPreviewSection[] = [
    { key: 'bodies', label: '胎体', count: bodyIds.length, bodyIds },
    { key: 'coats', label: '髹涂道次', count: coatIds.length, bodyIds: [...new Set(coats.map((c) => c.bodyId))] },
    { key: 'polishes', label: '打磨记录', count: polishIds.length, bodyIds: [...new Set(polishRows.map((p) => p.bodyId))] },
    { key: 'inlays', label: '镶嵌记录', count: inlayIds.length, bodyIds: [...new Set(inlays.map((i) => i.bodyId))] },
    { key: 'inspects', label: '质检记录', count: inspectIds.length, bodyIds: [...new Set(inspectRows.map((i) => i.bodyId))] },
  ];
  const total = bodyIds.length + coatIds.length + polishIds.length + inlayIds.length + inspectIds.length;

  return { batchId, batchNo: batch.batchNo, bodyIds, coatIds, polishIds, inlayIds, inspectIds, sections, total };
}

/* ------------------------------ 召回：登记通报（一份召回单） ------------------------------ */

const EMPTY_COUNTS: Record<RecallTargetKind, number> = {
  bodies: 0,
  coats: 0,
  polishes: 0,
  inlays: 0,
  inspects: 0,
};

/**
 * 登记供应商停用通报：批次置停用并生成召回单（待确认冻结）。
 * - 先预览受影响记录并随召回单落库（targets / countSnapshot）；
 * - noticeNo 唯一索引兜底并发：两个标签页同时提交同一通报时，后者事务因约束失败回滚，
 *   同一通报只生成一份召回单；
 * - 批次停用与召回单生成在同一事务内，失败一并回滚。
 */
export async function registerRecallNotice(notice: RecallNoticeDraft): Promise<RecallOrder> {
  const noticeNo = notice.noticeNo.trim();
  if (noticeNo.length === 0) throw new PaintServiceError('NOTICE_NO_EMPTY', '请填写供应商通报编号');
  if (notice.reason.trim().length === 0) throw new PaintServiceError('NOTICE_REASON_EMPTY', '请填写停用原因');

  const preview = await buildRecallPreview(notice.batchId);

  return db.transaction('rw', [db.paintBatches, db.recallOrders], async () => {
    const existing = await db.recallOrders.where('noticeNo').equals(noticeNo).first();
    if (existing) {
      throw new PaintServiceError(
        'NOTICE_DUPLICATE',
        `通报 ${noticeNo} 已生成召回单（批次 ${existing.batchNo}），同一通报不能重复登记`,
      );
    }
    const batch = await db.paintBatches.get(notice.batchId);
    if (!batch) throw new PaintServiceError('BATCH_NOT_FOUND', '漆料批次不存在或已删除');
    await db.paintBatches.update(batch.id, { status: 'inactive' as const, note: notice.reason.trim(), updatedAt: Date.now() });

    const now = Date.now();
    const targets: RecallTargets = {
      bodyIds: preview.bodyIds,
      coatIds: preview.coatIds,
      polishIds: preview.polishIds,
      inlayIds: preview.inlayIds,
      inspectIds: preview.inspectIds,
    };
    const order: RecallOrder = {
      id: createId('recall'),
      noticeNo,
      batchId: batch.id,
      batchNo: batch.batchNo,
      supplier: batch.supplier,
      reason: notice.reason.trim(),
      noticeDate: notice.noticeDate,
      status: 'pending',
      confirmed: false,
      targets,
      countSnapshot: {
        bodies: preview.bodyIds.length,
        coats: preview.coatIds.length,
        polishes: preview.polishIds.length,
        inlays: preview.inlayIds.length,
        inspects: preview.inspectIds.length,
      },
      errorNote: '',
      frozenAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.recallOrders.put(order);
    return order;
  });
}

/* ------------------------------ 召回：确认冻结（原子，不留半套） ------------------------------ */

/**
 * 确认召回：冻结全部下游记录。
 * 步骤 1（独立短事务）：召回单置「冻结中」并落库 —— 若随后进程崩溃 / 重启，
 *   resumePendingRecalls() 会找到冻结中的召回单继续处理；
 * 步骤 2（单个大事务）：五张下游表按 targets 快照统一打标，任一更新失败则事务回滚，
 *   已写入的冻结标记也会被撤销，不留半套；成功后召回单置「已冻结」。
 * 步骤 2 失败时步骤 3（独立短事务）：召回单置「冻结失败」并记录原因，可重试。
 * 冻结只追加 frozen* 字段，业务原值全部保留。
 */
export async function confirmRecall(orderId: string): Promise<RecallOrder> {
  const initial = await db.recallOrders.get(orderId);
  if (!initial) throw new PaintServiceError('RECALL_NOT_FOUND', '召回单不存在');
  if (initial.status === 'done') return initial;

  // 步骤 1：冻结中状态持久化（崩溃恢复锚点）
  const stamped = Date.now();
  await db.recallOrders.update(orderId, {
    status: 'freezing' as const,
    confirmed: true,
    errorNote: '',
    updatedAt: stamped,
  });

  try {
    // 步骤 2：全部冻结标记在同一事务内提交 / 回滚
    await db.transaction('rw', FREEZE_TABLES, async () => {
      const reason = `供应商通报 ${initial.noticeNo}：批次 ${initial.batchNo} 停用召回`;
      await applyFreezeMarks(initial.targets, orderId, reason);
      await db.recallOrders.update(orderId, {
        status: 'done' as const,
        frozenAt: Date.now(),
        errorNote: '',
        updatedAt: Date.now(),
      });
    });
  } catch (error) {
    // 步骤 3：大事务已整体回滚，下游不会有半套标记；召回单记录失败，等待重试 / 重启续处理
    await db.recallOrders.update(orderId, {
      status: 'failed' as const,
      errorNote: error instanceof Error ? error.message : '冻结失败，未知错误',
      updatedAt: Date.now(),
    });
    throw error instanceof PaintServiceError
      ? error
      : new PaintServiceError('FREEZE_FAILED', error instanceof Error ? error.message : '冻结失败，请重试');
  }

  const done = await db.recallOrders.get(orderId);
  if (!done) throw new PaintServiceError('RECALL_NOT_FOUND', '召回单不存在');
  return done;
}

/** 单事务内按 targets 给五类记录追加冻结标记（原值不动） */
async function applyFreezeMarks(targets: RecallTargets, recallId: string, reason: string): Promise<void> {
  const now = Date.now();
  const mark = {
    frozen: true,
    frozenByRecallId: recallId,
    frozenAt: now,
    frozenReason: reason,
    updatedAt: now,
  } as const;

  // 某类记录可能为空，anyOf 空数组在 Dexie 中会抛错，空目标直接视为成功
  const markByIds = async <TRecord extends { id: string }, TKey>(
    table: Table<TRecord, TKey>,
    ids: string[],
    label: string,
  ): Promise<void> => {
    if (ids.length === 0) return;
    const count = await table
      .where('id')
      .anyOf(ids)
      .modify({ ...mark } as never);
    if (count !== ids.length) {
      throw new PaintServiceError('FREEZE_TARGET_MISSING', `${label}冻结不完整（${count}/${ids.length}），已回滚`);
    }
  };

  await markByIds(db.bodies, targets.bodyIds, '胎体');
  await markByIds(db.coats, targets.coatIds, '道次');
  await markByIds(db.polishes, targets.polishIds, '打磨');
  await markByIds(db.inlays, targets.inlayIds, '镶嵌');
  await markByIds(db.inspects, targets.inspectIds, '质检');
}

/* ------------------------------ 召回：重启续处理 ------------------------------ */

export interface ResumeResult {
  resumed: RecallOrder[];
  failed: Array<{ order: RecallOrder; error: string }>;
}

/**
 * 应用启动时调用：继续处理「冻结中」（上次崩溃）与「冻结失败」（可重试）的已确认召回单。
 * 未确认的 pending 单不自动冻结（必须人工确认）。
 */
export async function resumePendingRecalls(): Promise<ResumeResult> {
  const orders = await db.recallOrders
    .where('status')
    .anyOf('freezing', 'failed')
    .toArray();
  const resumed: RecallOrder[] = [];
  const failed: Array<{ order: RecallOrder; error: string }> = [];
  for (const order of orders) {
    if (!order.confirmed) continue;
    try {
      const done = await confirmRecall(order.id);
      resumed.push(done);
    } catch (error) {
      const latest = await db.recallOrders.get(order.id);
      if (latest) failed.push({ order: latest, error: error instanceof Error ? error.message : '续处理失败' });
    }
  }
  return { resumed, failed };
}

export { EMPTY_COUNTS };
