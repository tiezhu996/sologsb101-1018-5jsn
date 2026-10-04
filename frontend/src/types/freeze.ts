/**
 * 召回冻结公共字段
 * 供应商通报批次停用并确认召回后，受影响的下游记录（胎体 / 道次 / 打磨 / 镶嵌 / 质检）
 * 统一打冻结标记：原值全部保留，只追加冻结元数据，冻结后禁止编辑与删除。
 */

/** 可被召回冻结的下游记录 */
export interface FreezableRecord {
  /** 是否被召回冻结 */
  frozen: boolean;
  /** 冻结该记录的召回单 id，未冻结为 null */
  frozenByRecallId: string | null;
  /** 冻结时间戳，未冻结为 null */
  frozenAt: number | null;
  /** 冻结原因（召回通报编号 + 漆料批次号快照），未冻结为 null */
  frozenReason: string | null;
}

/** 未携带漆料批次信息的旧数据统一标记为该哨兵值（未追溯） */
export const UNTRACED_BATCH_ID = 'untraced';

/** 未追溯批次的展示文案 */
export const UNTRACED_BATCH_LABEL = '未追溯';

export const FROZEN_TAG_LABEL = '已冻结';
