/**
 * 批次停用召回单（PaintRecall）数据模型
 * 供应商通报批次停用时：先预览受影响的胎体、道次、打磨、镶嵌与质检，
 * 确认后冻结下游记录并保留原值；同一通报只生成一份召回单。
 * 冻结失败不留半套标记（单事务），重启后可继续处理（pending 自动续冻结）。
 */
import type { Body } from '@/types/body';
import type { Coat } from '@/types/coat';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';

/** 召回单状态：待冻结（预览已确认、冻结可续做）/ 已冻结 */
export type RecallStatus = 'pending' | 'frozen';

export interface PaintRecall {
  id: string;
  /** 供应商通报号，同一通报只生成一份召回单（唯一索引） */
  noticeNo: string;
  /** 被停用的漆料批次 id */
  batchId: string;
  /** 被停用的批次号（冗余快照，批次后续改动不影响召回单展示） */
  batchNo: string;
  /** 通报来源说明 */
  source: string;
  /** 通报日期 yyyy-MM-dd */
  noticeDate: string;
  /** 待冻结 / 已冻结 */
  status: RecallStatus;
  /** 受影响胎体 id 列表（冻结时据此圈定下游） */
  affectedBodyIds: string[];
  /** 各类受影响记录数量快照，用于回显与重启后续做 */
  counts: RecallCounts;
  /** 失败原因（续做失败时记录，便于提示） */
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecallCounts {
  bodies: number;
  coats: number;
  polishes: number;
  inlays: number;
  inspects: number;
}

/** 预览结果：分组列出受影响的五类下游记录 */
export interface RecallPreview {
  batchId: string;
  batchNo: string;
  bodies: Body[];
  coats: Coat[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
  counts: RecallCounts;
}

export type PaintRecallDraft = Omit<
  PaintRecall,
  'id' | 'createdAt' | 'updatedAt' | 'status' | 'counts' | 'lastError' | 'affectedBodyIds'
> &
  Partial<Pick<PaintRecall, 'affectedBodyIds' | 'counts'>>;

export const RECALL_STATUS_LABEL: Record<RecallStatus, string> = {
  pending: '待冻结',
  frozen: '已冻结',
};

export const RECALL_STATUS_COLOR: Record<RecallStatus, string> = {
  pending: '#c9963c',
  frozen: '#3a6ea5',
};

/** 已冻结记录在各业务表上的统一标记字段名（保留原值时同时写入） */
export const FROZEN_FLAG = 'frozenByRecallId' as const;

export function emptyRecallCounts(): RecallCounts {
  return { bodies: 0, coats: 0, polishes: 0, inlays: 0, inspects: 0 };
}

/** 由通报号生成稳定召回单 id，保证同一通报天然去重 */
export function recallIdOfNotice(noticeNo: string): string {
  return `recall_${noticeNo.trim()}`;
}
