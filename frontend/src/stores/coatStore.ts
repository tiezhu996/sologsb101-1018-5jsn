/**
 * 髹涂道次状态管理（Zustand）
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { useBodyStore } from './bodyStore';

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<Coat>;
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  removeCoat: (id: string) => Promise<void>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<void>;
  markRecheck: (bodyId: string, recheck: boolean) => Promise<void>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<void>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
}

export const useCoatStore = create<CoatStoreState>((set, get) => ({
  coats: [],
  loading: false,
  ready: false,
  error: '',

  async loadCoats() {
    set({ loading: true });
    try {
      const coats = await db.coats.toArray();
      coats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ coats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '道次读取失败' });
    }
  },

  coatsOfBody(bodyId) {
    return get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  async createCoat(draft) {
    const now = Date.now();
    const row: Coat = { ...draft, id: createId('coat'), frozen: false, frozenByRecallId: null, frozenAt: null, frozenReason: null, createdAt: now, updatedAt: now };
    await db.coats.put(row);
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    // 缓存未命中时直接查库，保证冻结判定不依赖页面是否已加载
    const target = get().coats.find((coat) => coat.id === id) ?? (await db.coats.get(id));
    if (target?.frozen) {
      throw new Error(`第 ${target.seq} 道已被召回冻结，原值保留，禁止修改`);
    }
    await db.coats.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    if (target?.frozen) {
      throw new Error(`第 ${target.seq} 道已被召回冻结，禁止删除`);
    }
    await db.coats.delete(id);
    if (target) {
      // 删除后按序重编号，保持 seq 连续；该胎体存在冻结道次时禁止删除（重编号会改动冻结原值）
      const siblings = get().coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id);
      if (siblings.some((coat) => coat.frozen)) {
        throw new Error('该胎体存在已召回冻结的道次，为保留冻结道次的原序号，禁止删除其他道次');
      }
      const rest = siblings
        .sort((a, b) => a.seq - b.seq)
        .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
      if (rest.length > 0) await db.coats.bulkPut(rest);
    }
    await get().loadCoats();
  },

  async batchUpdate(ids, patch) {
    if (ids.length === 0) return;
    const targets = get().coats.filter((coat) => ids.includes(coat.id));
    const locked = targets.filter((coat) => coat.frozen);
    if (locked.length > 0) {
      throw new Error(`有 ${locked.length} 道已被召回冻结，禁止批量修改（已全部跳过）`);
    }
    const now = Date.now();
    const rows = targets.map((coat) => ({ ...coat, ...patch, updatedAt: now }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const next = nextCoatState(coat.state);
    if (next === coat.state) return;
    await get().updateCoat(id, { state: next });
  },

  async markRecheck(bodyId, recheck) {
    const affected = get().coats.filter(
      (coat) => coat.bodyId === bodyId && coat.state !== 'done' && !coat.frozen,
    );
    if (affected.length === 0) return;
    const now = Date.now();
    await db.coats.bulkPut(affected.map((coat) => ({ ...coat, needRecheck: recheck, updatedAt: now })));
    await get().loadCoats();
  },

  async reorderCoats(bodyId, orderedIds) {
    if (get().coats.some((coat) => coat.bodyId === bodyId && coat.frozen)) {
      throw new Error('该胎体存在已召回冻结的道次，顺序与序号均已封存，禁止拖拽重排');
    }
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const rows = get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
  },

  suggestForBody(bodyId) {
    const bodies = useBodyStore.getState().bodies;
    const current = bodies.find((body) => body.id === bodyId);
    const previousBody = bodies.find((body) => body.id !== bodyId && current !== undefined && body.shape === current.shape);
    const previousCoat = previousBody
      ? get()
          .coats.filter((coat) => coat.bodyId === previousBody.id)
          .sort((a, b) => a.seq - b.seq)
          .pop()
      : undefined;
    const paintType = suggestPaintType(get().nextSeq(bodyId), previousCoat?.paintType, current?.shape);
    return {
      paintType,
      intervalHours: suggestIntervalHours(paintType),
      sourceCode: previousBody?.code ?? '',
      sourceColor: previousCoat?.colorName ?? '',
    };
  },
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
