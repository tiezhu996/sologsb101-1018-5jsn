/**
 * 漆料台账状态管理（Zustand）
 * 维护漆料批次、领用流水与召回单；写入动作统一走 paintService 的事务保证。
 * 跨标签页的余额变化由各页面的 useIdbTable 订阅与本 store 的重新加载共同感知。
 */
import { create } from 'zustand';
import { db } from '@/utils/db';
import type { PaintBatch, PaintUsage, RecallNoticeDraft, RecallOrder } from '@/types/paint';
import {
  confirmRecall as confirmRecallTx,
  createPaintBatch,
  registerPaintUsage,
  registerRecallNotice,
  resumePendingRecalls,
  type ResumeResult,
} from '@/utils/paintService';
import type { PaintUsageDraft } from '@/types/paint';

export interface CreatePaintBatchInput {
  batchNo: string;
  kind: PaintBatch['kind'];
  colorName: string;
  supplier: string;
  producedDate: string;
  unit: PaintBatch['unit'];
  receivedQty: number;
  note?: string;
}

interface PaintStoreState {
  batches: PaintBatch[];
  usages: PaintUsage[];
  recalls: RecallOrder[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadPaint: () => Promise<void>;
  createBatch: (input: CreatePaintBatchInput) => Promise<PaintBatch>;
  registerUsage: (draft: PaintUsageDraft) => Promise<PaintUsage>;
  registerNotice: (notice: RecallNoticeDraft) => Promise<RecallOrder>;
  confirmRecall: (recallId: string) => Promise<RecallOrder>;
  resumeRecalls: () => Promise<ResumeResult>;
}

export const usePaintStore = create<PaintStoreState>((set, get) => ({
  batches: [],
  usages: [],
  recalls: [],
  loading: false,
  ready: false,
  error: '',

  async loadPaint() {
    set({ loading: true });
    try {
      const [batches, usages, recalls] = await Promise.all([
        db.paintBatches.orderBy('updatedAt').reverse().toArray(),
        db.paintUsages.orderBy('updatedAt').reverse().toArray(),
        db.recallOrders.orderBy('updatedAt').reverse().toArray(),
      ]);
      set({ batches, usages, recalls, loading: false, ready: true, error: '' });
    } catch (error) {
      set({
        loading: false,
        ready: true,
        error: error instanceof Error ? error.message : '漆料台账读取失败',
      });
    }
  },

  async createBatch(input) {
    const batch = await createPaintBatch(input);
    await get().loadPaint();
    return batch;
  },

  async registerUsage(draft) {
    const usage = await registerPaintUsage(draft);
    await get().loadPaint();
    return usage;
  },

  async registerNotice(notice) {
    const order = await registerRecallNotice(notice);
    await get().loadPaint();
    return order;
  },

  async confirmRecall(recallId) {
    const order = await confirmRecallTx(recallId);
    await get().loadPaint();
    return order;
  },

  async resumeRecalls() {
    const result = await resumePendingRecalls();
    if (result.resumed.length > 0 || result.failed.length > 0) await get().loadPaint();
    return result;
  },
}));
