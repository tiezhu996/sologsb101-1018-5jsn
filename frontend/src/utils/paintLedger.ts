/**
 * 漆料台账领域服务：领用登记、原子扣减、台账对账
 *
 * 并发安全：领用在单个 IndexedDB 可串行化事务内完成「读批次余量 → 校验 →
 * 写领用流水 → 扣减余量」。IndexedDB 的 rw 事务对同一对象库互斥，
 * 两个标签页同时保存时第二个会在第一个提交后才读到最新余量，超量即抛
 * PaintShortageError，事务整体回滚（不留半截领用与扣减）。
 */
import { db, createId } from '@/utils/db';
import {
  PaintBatchInactiveError,
  PaintShortageError,
  type PaintBatch,
  type PaintIssue,
  type PaintIssueDraft,
} from '@/types/paint';

/** 台账参与领用扣减与对账的对象库 */
const LEDGER_TABLES = [db.paintBatches, db.paintIssues];

export interface IssueResult {
  issue: PaintIssue;
  batch: PaintBatch;
}

/**
 * 登记一笔领用并原子扣减批次余量。
 * 余量不足 / 批次停用 / 数量非法时抛出，事务一次回滚。
 */
export async function registerIssue(draft: PaintIssueDraft): Promise<IssueResult> {
  const qtyG = Number(draft.qtyG);
  if (!Number.isFinite(qtyG) || qtyG <= 0) {
    throw new Error('领用数量必须是大于 0 的数字');
  }

  return db.transaction('rw', LEDGER_TABLES, async () => {
    const batch = await db.paintBatches.get(draft.batchId);
    if (!batch) throw new Error('未找到对应漆料批次');
    if (batch.status === 'inactive') throw new PaintBatchInactiveError(batch.batchNo);
    if (qtyG > batch.remainingQtyG) throw new PaintShortageError(qtyG, batch.remainingQtyG);

    const now = Date.now();
    const issue: PaintIssue = {
      ...draft,
      qtyG,
      id: createId('pi'),
      createdAt: now,
      updatedAt: now,
    };
    const nextBatch: PaintBatch = {
      ...batch,
      remainingQtyG: round1(batch.remainingQtyG - qtyG),
      updatedAt: now,
    };
    await db.paintIssues.put(issue);
    await db.paintBatches.put(nextBatch);
    return { issue, batch: nextBatch };
  });
}

/** 删除领用流水并把数量退回批次余量（红冲），单事务保证一致 */
export async function reverseIssue(issueId: string): Promise<void> {
  await db.transaction('rw', LEDGER_TABLES, async () => {
    const issue = await db.paintIssues.get(issueId);
    if (!issue) return;
    const batch = await db.paintBatches.get(issue.batchId);
    if (batch) {
      const now = Date.now();
      await db.paintBatches.put({
        ...batch,
        remainingQtyG: round1(batch.remainingQtyG + issue.qtyG),
        updatedAt: now,
      });
    }
    await db.paintIssues.delete(issueId);
  });
}

/** 按批次汇总领用流水（克），与批次台账余量对账 */
export async function sumIssuedByBatch(batchId: string): Promise<number> {
  const rows = await db.paintIssues.where('batchId').equals(batchId).toArray();
  return round1(rows.reduce((sum, row) => sum + row.qtyG, 0));
}

export interface BatchReconcile {
  batch: PaintBatch;
  initialQtyG: number;
  issuedQtyG: number;
  /** 台账登记余量 */
  ledgerRemainingG: number;
  /** 由 初始量 − 领用汇总 推算的余量 */
  computedRemainingG: number;
  /** 两者是否一致（容忍 0.1g 浮点误差） */
  consistent: boolean;
  diffG: number;
}

/** 单个批次对账：比较台账余量与流水推算余量 */
export async function reconcileBatch(batchId: string): Promise<BatchReconcile | null> {
  const batch = await db.paintBatches.get(batchId);
  if (!batch) return null;
  const issuedQtyG = await sumIssuedByBatch(batchId);
  const computedRemainingG = round1(batch.initialQtyG - issuedQtyG);
  const diffG = round1(batch.remainingQtyG - computedRemainingG);
  return {
    batch,
    initialQtyG: batch.initialQtyG,
    issuedQtyG,
    ledgerRemainingG: batch.remainingQtyG,
    computedRemainingG,
    consistent: Math.abs(diffG) <= 0.1,
    diffG,
  };
}

/** 全量批次对账 */
export async function reconcileAll(): Promise<BatchReconcile[]> {
  const batches = await db.paintBatches.toArray();
  const result: BatchReconcile[] = [];
  for (const batch of batches) {
    const item = await reconcileBatch(batch.id);
    if (item) result.push(item);
  }
  return result;
}

/**
 * 以领用流水为准，把批次台账余量校准为「初始量 − 领用汇总」。
 * 仅在对账不一致时使用，单事务避免校准与领用并发交错。
 */
export async function realignRemaining(batchId: string): Promise<number> {
  return db.transaction('rw', LEDGER_TABLES, async () => {
    const batch = await db.paintBatches.get(batchId);
    if (!batch) throw new Error('未找到对应漆料批次');
    const rows = await db.paintIssues.where('batchId').equals(batchId).toArray();
    const issuedQtyG = round1(rows.reduce((sum, row) => sum + row.qtyG, 0));
    const computed = round1(batch.initialQtyG - issuedQtyG);
    await db.paintBatches.put({ ...batch, remainingQtyG: computed, updatedAt: Date.now() });
    return computed;
  });
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
