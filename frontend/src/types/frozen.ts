/**
 * 冻结标记的公共结构
 * 批次停用召回时，下游记录（胎体 / 道次 / 打磨 / 镶嵌 / 质检）被冻结：
 * 仅追加冻结元数据并保留原值，不删除、不改写业务字段。
 */

/** 可被召回冻结的记录统一追加的字段 */
export interface FrozenMeta {
  /** 由哪一份召回单冻结；未冻结时为 undefined */
  frozenByRecallId?: string;
  /** 冻结时间戳；未冻结时为 undefined */
  frozenAt?: number;
  /**
   * 冻结前的原始状态快照（仅胎体 / 道次有状态流转），
   * 用于保留原值；冻结后业务 state 改为冻结态，原值存这里。
   */
  frozenOriginalState?: string;
}

export function isFrozen(record: FrozenMeta | undefined | null): boolean {
  return !!record && typeof record.frozenByRecallId === 'string' && record.frozenByRecallId.length > 0;
}
