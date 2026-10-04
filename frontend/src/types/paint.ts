/**
 * 漆料批次与领用台账（PaintBatch / PaintIssue）数据模型
 * 车间把同一批漆料领到髹涂与镶嵌工序；台账除余量外，逐笔登记领用以与漆料台账对账。
 * 同一批次两个标签页同时领用不能超过可用量，扣减失败整体回滚。
 */

/** 领用工序：髹涂 / 镶嵌 */
export type PaintStage = 'coat' | 'inlay';

/** 批次状态：在用 / 停用（供应商通报批次问题后冻结） */
export type PaintBatchStatus = 'active' | 'inactive';

export interface PaintBatch {
  id: string;
  /** 供应商批次号，同一批次唯一，也是召回单去重依据 */
  batchNo: string;
  /** 漆种：生漆 / 色漆 / 罩漆 */
  paintType: import('@/types/coat').PaintType;
  /** 色名 */
  colorName: string;
  /** 供应商名称 */
  supplier: string;
  /** 到货日期 yyyy-MM-dd */
  receivedDate: string;
  /** 初始入库量（克） */
  initialQtyG: number;
  /** 台账余量（克），与领用流水汇总对账；原子扣减以本字段为准 */
  remainingQtyG: number;
  /** 在用 / 停用 */
  status: PaintBatchStatus;
  /** 停用通报号；停用时写入，便于与召回单一一对应 */
  noticeNo: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PaintIssue {
  id: string;
  /** 领用的漆料批次 id */
  batchId: string;
  /** 领用工序 */
  stage: PaintStage;
  /** 领用数量（克），须为正数 */
  qtyG: number;
  /** 领用人 */
  receiver: string;
  /** 领用日期 yyyy-MM-dd */
  issueDate: string;
  /** 关联胎体 id（便于按胎体回溯） */
  bodyId: string | null;
  /** 关联道次序号（髹涂工序），镶嵌为 null */
  coatSeq: number | null;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type PaintBatchDraft = Omit<PaintBatch, 'id' | 'createdAt' | 'updatedAt' | 'remainingQtyG' | 'status' | 'noticeNo'>;

export type PaintIssueDraft = Omit<PaintIssue, 'id' | 'createdAt' | 'updatedAt'>;

/** 历史数据缺少漆料批次时统一标记为「未追溯」 */
export const UNTRACED_BATCH_ID = 'untraced';

/** 未追溯展示文案 */
export const UNTRACED_LABEL = '未追溯';

export const PAINT_STAGE_LABEL: Record<PaintStage, string> = {
  coat: '髹涂',
  inlay: '镶嵌',
};

export const PAINT_STAGE_COLOR: Record<PaintStage, string> = {
  coat: '#8c2f1f',
  inlay: '#7d6ba8',
};

export const PAINT_BATCH_STATUS_LABEL: Record<PaintBatchStatus, string> = {
  active: '在用',
  inactive: '停用',
};

export const PAINT_BATCH_STATUS_COLOR: Record<PaintBatchStatus, string> = {
  active: '#2f6f4f',
  inactive: '#b03a2e',
};

export const PAINT_STAGE_OPTIONS: ReadonlyArray<{ value: PaintStage; label: string }> = [
  { value: 'coat', label: '髹涂工序' },
  { value: 'inlay', label: '镶嵌工序' },
];

/** 领用数量超量等业务错误，供事务抛出后一次回滚 */
export class PaintShortageError extends Error {
  readonly availableG: number;
  readonly requestedG: number;

  constructor(requestedG: number, availableG: number) {
    super(`漆料余量不足：领用 ${requestedG}g，可用仅 ${availableG}g，已整体回滚`);
    this.name = 'PaintShortageError';
    this.requestedG = requestedG;
    this.availableG = availableG;
  }
}

/** 批次已被停用，禁止再领用 */
export class PaintBatchInactiveError extends Error {
  constructor(batchNo: string) {
    super(`批次 ${batchNo} 已停用，禁止领用`);
    this.name = 'PaintBatchInactiveError';
  }
}

export function createEmptyPaintBatchDraft(): PaintBatchDraft {
  return {
    batchNo: '',
    paintType: 'raw',
    colorName: '漆黑',
    supplier: '',
    receivedDate: new Date().toISOString().slice(0, 10),
    initialQtyG: 1000,
  };
}

export function createEmptyPaintIssueDraft(batchId = ''): PaintIssueDraft {
  return {
    batchId,
    stage: 'coat',
    qtyG: 50,
    receiver: '',
    issueDate: new Date().toISOString().slice(0, 10),
    bodyId: null,
    coatSeq: null,
    note: '',
  };
}

/** 台账余量是否为非负 */
export function isRemainingSane(batch: PaintBatch): boolean {
  return batch.remainingQtyG >= 0;
}
