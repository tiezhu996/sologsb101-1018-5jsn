/**
 * 漆料批次台账、领用流水与召回单数据模型
 * - PaintBatch：车间漆料台账（入库量 / 可用余量），同一批漆料由髹涂与镶嵌两个工序领用
 * - PaintUsage：领用流水（工序、关联道次 / 镶嵌记录、领用量），登记时在同一事务内扣减台账余量
 * - RecallOrder：供应商批次停用通报生成的召回单（同一通报只生成一份），冻结其下游记录
 */

/** 漆种：生漆 / 色漆 / 罩漆（与 Coat.PaintType 保持一致） */
export type PaintKind = 'raw' | 'color' | 'topcoat';

/** 批次状态：在用 / 停用（供应商通报停用后不可再领用） */
export type PaintBatchStatus = 'active' | 'inactive';

/** 计量单位 */
export type PaintUnit = 'g' | 'ml';

/** 领用工序：髹涂 / 镶嵌 */
export type UsageProcess = 'coat' | 'inlay';

/** 召回单状态：待确认冻结 / 冻结中（重启后续处理）/ 已冻结 / 冻结失败（可重试） */
export type RecallStatus = 'pending' | 'freezing' | 'done' | 'failed';

export interface PaintBatch {
  id: string;
  /** 漆料批次号（供应商批号），台账展示与召回均以此为准 */
  batchNo: string;
  /** 漆种 */
  kind: PaintKind;
  /** 色名，如「朱红」「漆黑」 */
  colorName: string;
  /** 供应商 */
  supplier: string;
  /** 生产日期 yyyy-MM-dd */
  producedDate: string;
  /** 计量单位（克 / 毫升） */
  unit: PaintUnit;
  /** 入库总量 */
  receivedQty: number;
  /** 当前可用余量（仅由领用登记的事务扣减） */
  remainingQty: number;
  /** 在用 / 停用 */
  status: PaintBatchStatus;
  /** 停用 / 召回说明 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type PaintBatchDraft = Omit<PaintBatch, 'id' | 'createdAt' | 'updatedAt' | 'remainingQty' | 'status' | 'note'>;

export interface PaintUsage {
  id: string;
  /** 领用的漆料批次 id；旧数据无批次时为哨兵 'untraced' */
  batchId: string;
  /** 领用批次号快照（批次被停用 / 删除后流水仍可对账） */
  batchNo: string;
  /** 领用工序：髹涂 / 镶嵌 */
  process: UsageProcess;
  /** 关联胎体 id（两个工序都能定位到胎体） */
  bodyId: string;
  /** 髹涂工序关联道次 id；镶嵌工序为 null */
  coatId: string | null;
  /** 镶嵌工序关联镶嵌记录 id；髹涂工序为 null */
  inlayId: string | null;
  /** 领用量 */
  qty: number;
  /** 计量单位快照 */
  unit: PaintUnit;
  /** 领用人 */
  operator: string;
  /** 领用日期 yyyy-MM-dd */
  usageDate: string;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type PaintUsageDraft = Omit<PaintUsage, 'id' | 'createdAt' | 'updatedAt' | 'batchNo' | 'unit'>;

/** 召回预览中每一类下游记录的计数与样例 */
export interface RecallPreviewSection {
  key: RecallTargetKind;
  label: string;
  count: number;
  bodyIds: string[];
}

/** 受召回影响的下游类别：胎体 / 道次 / 打磨 / 镶嵌 / 质检 */
export type RecallTargetKind = 'bodies' | 'coats' | 'polishes' | 'inlays' | 'inspects';

/** 召回预览结果（不落库，仅用于确认前展示） */
export interface RecallPreview {
  batchId: string;
  batchNo: string;
  bodyIds: string[];
  coatIds: string[];
  polishIds: string[];
  inlayIds: string[];
  inspectIds: string[];
  sections: RecallPreviewSection[];
  total: number;
}

/** 冻结目标清单（确认召回时随召回单持久化，作为冻结快照） */
export interface RecallTargets {
  bodyIds: string[];
  coatIds: string[];
  polishIds: string[];
  inlayIds: string[];
  inspectIds: string[];
}

export interface RecallOrder {
  id: string;
  /** 供应商通报编号（唯一：同一通报只生成一份召回单） */
  noticeNo: string;
  /** 被通报停用的漆料批次 id */
  batchId: string;
  /** 批次号快照 */
  batchNo: string;
  /** 供应商 */
  supplier: string;
  /** 停用原因 */
  reason: string;
  /** 通报日期 yyyy-MM-dd */
  noticeDate: string;
  /** 待确认冻结 / 冻结中 / 已冻结 / 冻结失败 */
  status: RecallStatus;
  /** 是否已确认（登记通报先生成召回单，确认后才冻结下游） */
  confirmed: boolean;
  /** 受影响记录快照（登记时生成，冻结失败 / 重启续处理时复用） */
  targets: RecallTargets;
  /** 各分类计数快照，用于召回单列表回显 */
  countSnapshot: Record<RecallTargetKind, number>;
  /** 失败原因（冻结失败时记录，可重试） */
  errorNote: string;
  /** 冻结完成时间戳 */
  frozenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 登记供应商停用通报的入参 */
export interface RecallNoticeDraft {
  noticeNo: string;
  batchId: string;
  reason: string;
  noticeDate: string;
}

export const PAINT_KIND_LABEL: Record<PaintKind, string> = {
  raw: '生漆',
  color: '色漆',
  topcoat: '罩漆',
};

export const PAINT_BATCH_STATUS_LABEL: Record<PaintBatchStatus, string> = {
  active: '在用',
  inactive: '停用',
};

export const PAINT_UNIT_LABEL: Record<PaintUnit, string> = {
  g: '克',
  ml: '毫升',
};

export const USAGE_PROCESS_LABEL: Record<UsageProcess, string> = {
  coat: '髹涂',
  inlay: '镶嵌',
};

export const RECALL_STATUS_LABEL: Record<RecallStatus, string> = {
  pending: '待确认冻结',
  freezing: '冻结中',
  done: '已冻结',
  failed: '冻结失败',
};

export const PAINT_KIND_OPTIONS: ReadonlyArray<{ value: PaintKind; label: string }> = [
  { value: 'raw', label: '生漆' },
  { value: 'color', label: '色漆' },
  { value: 'topcoat', label: '罩漆' },
];

export const PAINT_UNIT_OPTIONS: ReadonlyArray<{ value: PaintUnit; label: string }> = [
  { value: 'g', label: '克（g）' },
  { value: 'ml', label: '毫升（ml）' },
];

export const USAGE_PROCESS_OPTIONS: ReadonlyArray<{ value: UsageProcess; label: string }> = [
  { value: 'coat', label: '髹涂工序' },
  { value: 'inlay', label: '镶嵌工序' },
];

export function createEmptyPaintBatchDraft(): PaintBatchDraft {
  return {
    batchNo: '',
    kind: 'raw',
    colorName: '漆黑',
    supplier: '',
    producedDate: new Date().toISOString().slice(0, 10),
    unit: 'g',
    receivedQty: 1000,
  };
}
