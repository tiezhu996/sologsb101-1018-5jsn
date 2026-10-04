/**
 * 漆料批次 / 领用 / 召回状态管理（Zustand）
 * 维护批次台账、领用流水、召回单列表；关键事务（原子扣减、整体冻结）下沉到 utils。
 * 跨页只读 store 暴露的数据，写操作走本 store 方法。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import { db, createId } from '@/utils/db';
import type { PaintBatch, PaintBatchDraft, PaintIssue, PaintIssueDraft } from '@/types/paint';
import type { PaintRecall } from '@/types/recall';
import { registerIssue, reverseIssue } from '@/utils/paintLedger';

interface PaintStoreState {
  batches: PaintBatch[];
  issues: PaintIssue[];
  recalls: PaintRecall[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadPaint: () => Promise<void>;
  createBatch: (draft: PaintBatchDraft) => Promise<PaintBatch>;
  updateBatch: (id: string, patch: Partial<PaintBatch>) => Promise<void>;
  removeBatch: (id: string) => Promise<void>;
  /** 登记领用并原子扣减余量；失败抛出（上层捕获提示），事务已回滚 */
  issuePaint: (draft: PaintIssueDraft) => Promise<PaintIssue>;
  reverseIssue: (id: string) => Promise<void>;
  batchById: (id: string) => PaintBatch | undefined;
  issuesOfBatch: (batchId: string) => PaintIssue[];
}

export const usePaintStore = create<PaintStoreState>((set, get) => ({
  batches: [],
  issues: [],
  recalls: [],
  loading: false,
  ready: false,
  error: '',

  async loadPaint() {
    set({ loading: true });
    try {
      const [batches, issues, recalls] = await Promise.all([
        db.paintBatches.toArray(),
        db.paintIssues.toArray(),
        db.paintRecalls.toArray(),
      ]);
      batches.sort((a, b) => (a.receivedDate < b.receivedDate ? 1 : a.receivedDate > b.receivedDate ? -1 : 0));
      issues.sort((a, b) => b.createdAt - a.createdAt);
      recalls.sort((a, b) => b.createdAt - a.createdAt);
      set({ batches, issues, recalls, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '漆料台账读取失败' });
    }
  },

  async createBatch(draft) {
    const now = Date.now();
    const existing = await db.paintBatches.where('batchNo').equals(draft.batchNo.trim()).first();
    if (existing) throw new Error(`批次号 ${draft.batchNo} 已存在`);
    const row: PaintBatch = {
      ...draft,
      batchNo: draft.batchNo.trim(),
      id: createId('pb'),
      remainingQtyG: draft.initialQtyG,
      status: 'active',
      noticeNo: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.paintBatches.put(row);
    await get().loadPaint();
    return row;
  },

  async updateBatch(id, patch) {
    await db.paintBatches.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadPaint();
  },

  async removeBatch(id) {
    const used = await db.paintIssues.where('batchId').equals(id).count();
    if (used > 0) throw new Error('该批次已有领用流水，不能删除（可改为停用）');
    await db.paintBatches.delete(id);
    await get().loadPaint();
  },

  async issuePaint(draft) {
    const { issue } = await registerIssue(draft);
    await get().loadPaint();
    return issue;
  },

  async reverseIssue(id) {
    await reverseIssue(id);
    await get().loadPaint();
  },

  batchById(id) {
    return get().batches.find((batch) => batch.id === id);
  },

  issuesOfBatch(batchId) {
    return get()
      .issues.filter((issue) => issue.batchId === batchId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
}));

/** 批次选项选择器：仅在用批次可领用 */
export function selectActiveBatches(batches: PaintBatch[]): PaintBatch[] {
  return batches.filter((batch) => batch.status === 'active');
}

function sortBatches(list: PaintBatch[]): PaintBatch[] {
  return [...list].sort((a, b) => (a.receivedDate < b.receivedDate ? 1 : a.receivedDate > b.receivedDate ? -1 : 0));
}
function sortIssues(list: PaintIssue[]): PaintIssue[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}
function sortRecalls(list: PaintRecall[]): PaintRecall[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 订阅三张漆料表的变更（含其他标签页提交的事务）。
 * 两个标签页同时领用 / 冻结时，库存与召回状态在本标签页即时刷新。
 * 返回取消订阅函数。
 */
export function subscribePaintLive(): () => void {
  const subscriptions = [
    liveQuery(() => db.paintBatches.toArray()).subscribe({
      next: (batches) => usePaintStore.setState({ batches: sortBatches(batches) }),
      error: () => undefined,
    }),
    liveQuery(() => db.paintIssues.toArray()).subscribe({
      next: (issues) => usePaintStore.setState({ issues: sortIssues(issues) }),
      error: () => undefined,
    }),
    liveQuery(() => db.paintRecalls.toArray()).subscribe({
      next: (recalls) => usePaintStore.setState({ recalls: sortRecalls(recalls) }),
      error: () => undefined,
    }),
  ];
  return () => subscriptions.forEach((sub) => sub.unsubscribe());
}
