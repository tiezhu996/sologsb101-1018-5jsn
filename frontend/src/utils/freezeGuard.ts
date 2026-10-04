/**
 * 冻结守卫：批次召回冻结后的下游记录禁止继续编辑 / 状态推进。
 * 各 store 的写操作在落库前调用 assertNotFrozen，避免绕过页面禁用态。
 */
import { isFrozen, type FrozenMeta } from '@/types/frozen';

export class FrozenRecordError extends Error {
  constructor(target = '该记录') {
    super(`${target}已随批次召回冻结并保留原值，禁止编辑`);
    this.name = 'FrozenRecordError';
  }
}

export function assertNotFrozen(record: FrozenMeta | undefined | null, target = '该记录'): void {
  if (isFrozen(record)) throw new FrozenRecordError(target);
}

/** 胎体是否处于冻结态（胎体/道次有独立冻结状态） */
export function isBodyFrozen(record: { state?: string } & FrozenMeta): boolean {
  return isFrozen(record) || record.state === 'frozen';
}
