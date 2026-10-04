/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Coat 增加 paintType 索引并回填历史记录
 *   v2 → v3：新增漆料批次 / 领用流水 / 召回单三张表；
 *            Coat、Inlay 增加 batchId（旧数据回填「未追溯」）；
 *            胎体 / 道次 / 打磨 / 镶嵌 / 质检增加召回冻结字段。
 * - 业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import type { Room } from '@/types/room';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';
import type { PaintBatch, PaintUsage, RecallOrder } from '@/types/paint';
import { UNTRACED_BATCH_ID } from '@/types/freeze';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gblacquer';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gblacquer:db-version',
  lastBackupAt: 'gblacquer:last-backup-at',
  uiPrefs: 'gblacquer:ui-prefs',
} as const;

export interface UiPrefs {
  /** 最近选中的胎体 */
  lastBodyId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBodyId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { lastBodyId: typeof parsed.lastBodyId === 'string' ? parsed.lastBodyId : null };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 记录结构版本与最近备份时间，便于「本地数据」页回显 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class LacquerDatabase extends Dexie {
  bodies!: Table<Body, string>;
  coats!: Table<Coat, string>;
  rooms!: Table<Room, string>;
  polishes!: Table<Polish, string>;
  inlays!: Table<Inlay, string>;
  inspects!: Table<Inspect, string>;
  paintBatches!: Table<PaintBatch, string>;
  paintUsages!: Table<PaintUsage, string>;
  recallOrders!: Table<RecallOrder, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, state, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    });

    // v2：Coat 增加 paintType 索引；历史记录缺少 paintType 时按「生漆」回填
    this.version(2)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            const legal: PaintType[] = ['raw', 'color', 'topcoat'];
            if (!legal.includes(coat.paintType)) coat.paintType = 'raw';
            if (typeof coat.needRecheck !== 'boolean') coat.needRecheck = false;
            if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
          });
      });

    // v3：漆料批次 / 领用流水 / 召回单；下游记录增加冻结字段，Coat / Inlay 增加批次追溯
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bodies: 'id, code, material, shape, state, frozen, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, batchId, frozen, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, frozen, updatedAt',
        inlays: 'id, bodyId, type, position, batchId, frozen, updatedAt',
        inspects: 'id, bodyId, verdict, date, frozen, updatedAt',
        paintBatches: 'id, batchNo, kind, status, updatedAt',
        paintUsages: 'id, batchId, process, bodyId, coatId, inlayId, usageDate, updatedAt',
        // noticeNo 唯一索引：同一供应商通报只能生成一份召回单
        recallOrders: 'id, &noticeNo, batchId, status, confirmed, updatedAt',
      })
      .upgrade(async (tx) => {
        const fillFrozen = (row: {
          frozen?: unknown;
          frozenByRecallId?: unknown;
          frozenAt?: unknown;
          frozenReason?: unknown;
        }): void => {
          if (typeof row.frozen !== 'boolean') row.frozen = false;
          if (row.frozenByRecallId === undefined) row.frozenByRecallId = null;
          if (row.frozenAt === undefined) row.frozenAt = null;
          if (row.frozenReason === undefined) row.frozenReason = null;
        };
        await tx
          .table<Body>('bodies')
          .toCollection()
          .modify((body) => fillFrozen(body));
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            fillFrozen(coat);
            // 旧数据没有漆料批次：统一标成「未追溯」
            if (typeof coat.batchId !== 'string' || coat.batchId.length === 0) {
              coat.batchId = UNTRACED_BATCH_ID;
            }
          });
        await tx
          .table<Polish>('polishes')
          .toCollection()
          .modify((polish) => fillFrozen(polish));
        await tx
          .table<Inlay>('inlays')
          .toCollection()
          .modify((inlay) => {
            fillFrozen(inlay);
            if (typeof inlay.batchId !== 'string' || inlay.batchId.length === 0) {
              inlay.batchId = UNTRACED_BATCH_ID;
            }
          });
        await tx
          .table<Inspect>('inspects')
          .toCollection()
          .modify((inspect) => fillFrozen(inspect));
      });
  }
}

export const db = new LacquerDatabase();

/** 九张业务表清单，事务中统一引用 */
const TABLE_LIST = [
  db.bodies,
  db.coats,
  db.rooms,
  db.polishes,
  db.inlays,
  db.inspects,
  db.paintBatches,
  db.paintUsages,
  db.recallOrders,
];

/** 召回冻结事务涉及的五张下游表 + 召回单本身（事务内同步置「已冻结」） */
export const FREEZE_TABLES = [
  db.bodies,
  db.coats,
  db.polishes,
  db.inlays,
  db.inspects,
  db.recallOrders,
];

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.bodies.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Body →（Coat / Room / Polish / Inlay）→ Inspect，id 固定便于深链命中 */
/* 漆料批次与领用流水同时播种，余量 = 入库量 − 髹涂 / 镶嵌两工序领用合计 */

const NOT_FROZEN = { frozen: false, frozenByRecallId: null, frozenAt: null, frozenReason: null } as const;

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const bodies: Body[] = [
    {
      id: 'body_01',
      code: 'LQ-2401',
      material: 'wood',
      shape: 'bowl',
      sizeMm: 152,
      ownerName: '陈氏委托',
      state: 'coating',
      ...NOT_FROZEN,
      createdAt: now - 86400000 * 12,
      updatedAt: now - 86400000 * 2,
    },
    {
      id: 'body_02',
      code: 'LQ-2402',
      material: 'lacquered',
      shape: 'box',
      sizeMm: 96,
      ownerName: '工作室自藏',
      state: 'drying',
      ...NOT_FROZEN,
      createdAt: now - 86400000 * 9,
      updatedAt: now - 86400000,
    },
    {
      id: 'body_03',
      code: 'LQ-2403',
      material: 'metal',
      shape: 'vase',
      sizeMm: 210,
      ownerName: '市工艺美术馆',
      state: 'done',
      ...NOT_FROZEN,
      createdAt: now - 86400000 * 30,
      updatedAt: now - 86400000 * 4,
    },
  ];

  const coats: Coat[] = [
    { id: 'coat_0101', bodyId: 'body_01', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'done', needRecheck: false, batchId: 'pb_raw_01', ...NOT_FROZEN, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 10 },
    { id: 'coat_0102', bodyId: 'body_01', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06', thicknessUm: 45, state: 'toPolish', needRecheck: true, batchId: 'pb_color_01', ...NOT_FROZEN, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0103', bodyId: 'body_01', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12', thicknessUm: 30, state: 'todo', needRecheck: false, batchId: 'pb_top_01', ...NOT_FROZEN, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'coat_0201', bodyId: 'body_02', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 35, state: 'done', needRecheck: false, batchId: 'pb_raw_01', ...NOT_FROZEN, createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 7 },
    // 早期余漆，入库时未登记批次 → 未追溯
    { id: 'coat_0202', bodyId: 'body_02', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-08', thicknessUm: 42, state: 'coated', needRecheck: true, batchId: UNTRACED_BATCH_ID, ...NOT_FROZEN, createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'coat_0301', bodyId: 'body_03', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10', thicknessUm: 38, state: 'done', needRecheck: false, batchId: 'pb_raw_01', ...NOT_FROZEN, createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 25 },
    { id: 'coat_0302', bodyId: 'body_03', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18', thicknessUm: 44, state: 'done', needRecheck: false, batchId: 'pb_color_02', ...NOT_FROZEN, createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 18 },
    { id: 'coat_0303', bodyId: 'body_03', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26', thicknessUm: 28, state: 'done', needRecheck: false, batchId: 'pb_top_01', ...NOT_FROZEN, createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 4 },
  ];

  const rooms: Room[] = [
    { id: 'room_0101', bodyId: 'body_01', date: '2026-03-03', tempC: 24, humidityPct: 78, inAt: '09:00', outAt: '21:00', verdict: 'suitable', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'room_0102', bodyId: 'body_01', date: '2026-03-07', tempC: 27, humidityPct: 56, inAt: '08:30', outAt: '20:00', verdict: 'dry', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'room_0201', bodyId: 'body_02', date: '2026-03-05', tempC: 23, humidityPct: 91, inAt: '10:00', outAt: '22:30', verdict: 'wet', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'room_0301', bodyId: 'body_03', date: '2026-02-20', tempC: 25, humidityPct: 76, inAt: '09:30', outAt: '21:30', verdict: 'suitable', createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
  ];

  const polishes: Polish[] = [
    { id: 'polish_0101', bodyId: 'body_01', seq: 1, grit: 600, method: 'water', durationMin: 35, operator: '王丽', ...NOT_FROZEN, createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 9 },
    { id: 'polish_0102', bodyId: 'body_01', seq: 2, grit: 1500, method: 'burnish', durationMin: 45, operator: '王丽', ...NOT_FROZEN, createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'polish_0201', bodyId: 'body_02', seq: 1, grit: 800, method: 'water', durationMin: 30, operator: '李成', ...NOT_FROZEN, createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'polish_0301', bodyId: 'body_03', seq: 3, grit: 2000, method: 'burnish', durationMin: 60, operator: '王丽', ...NOT_FROZEN, createdAt: now - 86400000 * 5, updatedAt: now - 86400000 * 4 },
  ];

  const inlays: Inlay[] = [
    { id: 'inlay_0101', bodyId: 'body_01', type: 'nacre', pattern: '缠枝莲', position: '外壁', materialNote: '0.8mm 螺钿片，刻纹嵌贴', batchId: 'pb_raw_01', ...NOT_FROZEN, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7 },
    { id: 'inlay_0201', bodyId: 'body_02', type: 'eggshell', pattern: '云纹', position: '盖面', materialNote: '鸭蛋壳拼贴后髹漆磨显', batchId: 'pb_raw_01', ...NOT_FROZEN, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inlay_0301', bodyId: 'body_03', type: 'incisedGold', pattern: '折枝花', position: '通体', materialNote: '戗金，金粉入刻线', batchId: 'pb_top_01', ...NOT_FROZEN, createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 12 },
    { id: 'inlay_0302', bodyId: 'body_03', type: 'goldTrace', pattern: '诗文', position: '外壁', materialNote: '描金，泥金细描', batchId: 'pb_top_01', ...NOT_FROZEN, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
  ];

  const inspects: Inspect[] = [
    { id: 'inspect_0101', bodyId: 'body_03', verdict: 'pass', defectNote: '', inspector: '周衡', date: '2026-03-02', defectCoatSeq: null, defectRoomId: null, ...NOT_FROZEN, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inspect_0102', bodyId: 'body_02', verdict: 'rework', defectNote: '起皱（荫干过快）', inspector: '周衡', date: '2026-03-08', defectCoatSeq: 2, defectRoomId: 'room_0201', ...NOT_FROZEN, createdAt: now - 86400000, updatedAt: now - 86400000 },
  ];

  // 漆料台账：余量与下方领用流水严格对账（入库 − 髹涂 − 镶嵌 = 余量）
  const batches: PaintBatch[] = [
    {
      id: 'pb_raw_01', batchNo: 'SQ-2601-RAW', kind: 'raw', colorName: '漆黑', supplier: '秦巴天然漆社',
      producedDate: '2026-01-12', unit: 'g', receivedQty: 2000, remainingQty: 1565, status: 'active', note: '',
      createdAt: now - 86400000 * 40, updatedAt: now - 86400000 * 2,
    },
    {
      id: 'pb_color_01', batchNo: 'SQ-2602-ZH', kind: 'color', colorName: '朱红', supplier: '秦巴天然漆社',
      producedDate: '2026-01-20', unit: 'g', receivedQty: 1500, remainingQty: 1420, status: 'active', note: '',
      createdAt: now - 86400000 * 38, updatedAt: now - 86400000 * 7,
    },
    {
      id: 'pb_color_02', batchNo: 'SQ-2602-LV', kind: 'color', colorName: '石绿', supplier: '闽中漆坊',
      producedDate: '2026-01-22', unit: 'g', receivedQty: 1200, remainingQty: 1110, status: 'active', note: '',
      createdAt: now - 86400000 * 36, updatedAt: now - 86400000 * 18,
    },
    {
      id: 'pb_top_01', batchNo: 'SQ-2603-TOP', kind: 'topcoat', colorName: '推光本色（描金）', supplier: '秦巴天然漆社',
      producedDate: '2026-02-02', unit: 'g', receivedQty: 1000, remainingQty: 885, status: 'active', note: '',
      createdAt: now - 86400000 * 30, updatedAt: now - 86400000 * 4,
    },
  ];

  // 领用流水：髹涂与镶嵌两个工序同批漆料分别登记
  const usages: PaintUsage[] = [
    { id: 'usage_0101', batchId: 'pb_raw_01', batchNo: 'SQ-2601-RAW', process: 'coat', bodyId: 'body_01', coatId: 'coat_0101', inlayId: null, qty: 120, unit: 'g', operator: '陈漆匠', usageDate: '2026-03-02', note: '第一道生漆打底', createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
    { id: 'usage_0102', batchId: 'pb_color_01', batchNo: 'SQ-2602-ZH', process: 'coat', bodyId: 'body_01', coatId: 'coat_0102', inlayId: null, qty: 80, unit: 'g', operator: '陈漆匠', usageDate: '2026-03-06', note: '朱红第二道', createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7 },
    { id: 'usage_0201', batchId: 'pb_raw_01', batchNo: 'SQ-2601-RAW', process: 'coat', bodyId: 'body_02', coatId: 'coat_0201', inlayId: null, qty: 110, unit: 'g', operator: '李成', usageDate: '2026-03-03', note: '', createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 8 },
    { id: 'usage_0301', batchId: 'pb_raw_01', batchNo: 'SQ-2601-RAW', process: 'coat', bodyId: 'body_03', coatId: 'coat_0301', inlayId: null, qty: 130, unit: 'g', operator: '陈漆匠', usageDate: '2026-02-10', note: '', createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 26 },
    { id: 'usage_0302', batchId: 'pb_color_02', batchNo: 'SQ-2602-LV', process: 'coat', bodyId: 'body_03', coatId: 'coat_0302', inlayId: null, qty: 90, unit: 'g', operator: '陈漆匠', usageDate: '2026-02-18', note: '石绿', createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 20 },
    { id: 'usage_0303', batchId: 'pb_top_01', batchNo: 'SQ-2603-TOP', process: 'coat', bodyId: 'body_03', coatId: 'coat_0303', inlayId: null, qty: 60, unit: 'g', operator: '陈漆匠', usageDate: '2026-02-26', note: '罩漆', createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 14 },
    { id: 'usage_i0101', batchId: 'pb_raw_01', batchNo: 'SQ-2601-RAW', process: 'inlay', bodyId: 'body_01', coatId: null, inlayId: 'inlay_0101', qty: 40, unit: 'g', operator: '叶镶嵌', usageDate: '2026-03-05', note: '螺钿粘固漆', createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7 },
    { id: 'usage_i0201', batchId: 'pb_raw_01', batchNo: 'SQ-2601-RAW', process: 'inlay', bodyId: 'body_02', coatId: null, inlayId: 'inlay_0201', qty: 35, unit: 'g', operator: '叶镶嵌', usageDate: '2026-03-06', note: '蛋壳拼贴粘固', createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'usage_i0301', batchId: 'pb_top_01', batchNo: 'SQ-2603-TOP', process: 'inlay', bodyId: 'body_03', coatId: null, inlayId: 'inlay_0301', qty: 25, unit: 'g', operator: '叶镶嵌', usageDate: '2026-02-28', note: '戗金封护漆', createdAt: now - 86400000 * 12, updatedAt: now -86400000 * 12 },
    { id: 'usage_i0302', batchId: 'pb_top_01', batchNo: 'SQ-2603-TOP', process: 'inlay', bodyId: 'body_03', coatId: null, inlayId: 'inlay_0302', qty: 30, unit: 'g', operator: '叶镶嵌', usageDate: '2026-03-01', note: '描金漆', createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
  ];

  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(bodies);
    await db.coats.bulkPut(coats);
    await db.rooms.bulkPut(rooms);
    await db.polishes.bulkPut(polishes);
    await db.inlays.bulkPut(inlays);
    await db.inspects.bulkPut(inspects);
    await db.paintBatches.bulkPut(batches);
    await db.paintUsages.bulkPut(usages);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface LacquerSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  bodies: Body[];
  coats: Coat[];
  rooms: Room[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
  paintBatches: PaintBatch[];
  paintUsages: PaintUsage[];
  recallOrders: RecallOrder[];
}

export async function exportSnapshot(): Promise<LacquerSnapshot> {
  const [bodies, coats, rooms, polishes, inlays, inspects, paintBatches, paintUsages, recallOrders] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.rooms.toArray(),
    db.polishes.toArray(),
    db.inlays.toArray(),
    db.inspects.toArray(),
    db.paintBatches.toArray(),
    db.paintUsages.toArray(),
    db.recallOrders.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bodies,
    coats,
    rooms,
    polishes,
    inlays,
    inspects,
    paintBatches,
    paintUsages,
    recallOrders,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<LacquerSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  // v3 新增集合允许缺失（兼容 v1 / v2 备份），缺失时按空集合导入并走归一化
  const keys: Array<keyof LacquerSnapshot> = ['bodies', 'coats', 'rooms', 'polishes', 'inlays', 'inspects'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

interface FrozenShape {
  frozen?: unknown;
  frozenByRecallId?: unknown;
  frozenAt?: unknown;
  frozenReason?: unknown;
}

/** 为旧版本备份中的下游记录补齐冻结字段 */
function normalizeFrozen<T extends FrozenShape>(row: T): T {
  return {
    ...row,
    frozen: typeof row.frozen === 'boolean' ? row.frozen : false,
    frozenByRecallId: row.frozenByRecallId === undefined ? null : row.frozenByRecallId,
    frozenAt: row.frozenAt === undefined ? null : row.frozenAt,
    frozenReason: row.frozenReason === undefined ? null : row.frozenReason,
  };
}

/** 归一化导入快照：兼容旧版本备份（缺漆料 / 冻结字段时补默认值） */
export function normalizeSnapshot(snapshot: Partial<LacquerSnapshot>): LacquerSnapshot {
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: snapshot.exportedAt ?? new Date().toISOString(),
    bodies: (snapshot.bodies ?? []).map((row) => normalizeFrozen(row)),
    coats: (snapshot.coats ?? []).map((row) =>
      normalizeFrozen({
        ...row,
        batchId: typeof row.batchId === 'string' && row.batchId.length > 0 ? row.batchId : UNTRACED_BATCH_ID,
      }),
    ),
    rooms: snapshot.rooms ?? [],
    polishes: (snapshot.polishes ?? []).map((row) => normalizeFrozen(row)),
    inlays: (snapshot.inlays ?? []).map((row) =>
      normalizeFrozen({
        ...row,
        batchId: typeof row.batchId === 'string' && row.batchId.length > 0 ? row.batchId : UNTRACED_BATCH_ID,
      }),
    ),
    inspects: (snapshot.inspects ?? []).map((row) => normalizeFrozen(row)),
    paintBatches: snapshot.paintBatches ?? [],
    paintUsages: snapshot.paintUsages ?? [],
    recallOrders: snapshot.recallOrders ?? [],
  };
}

export async function importSnapshot(raw: Partial<LacquerSnapshot>): Promise<void> {
  const snapshot = normalizeSnapshot(raw);
  await clearAllTables();
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(snapshot.bodies);
    await db.coats.bulkPut(snapshot.coats);
    await db.rooms.bulkPut(snapshot.rooms);
    await db.polishes.bulkPut(snapshot.polishes);
    await db.inlays.bulkPut(snapshot.inlays);
    await db.inspects.bulkPut(snapshot.inspects);
    await db.paintBatches.bulkPut(snapshot.paintBatches);
    await db.paintUsages.bulkPut(snapshot.paintUsages);
    await db.recallOrders.bulkPut(snapshot.recallOrders);
  });
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await Promise.all([
      db.bodies.clear(),
      db.coats.clear(),
      db.rooms.clear(),
      db.polishes.clear(),
      db.inlays.clear(),
      db.inspects.clear(),
      db.paintBatches.clear(),
      db.paintUsages.clear(),
      db.recallOrders.clear(),
    ]);
  });
}

/** 清空并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [bodies, coats, rooms, polishes, inlays, inspects, paintBatches, paintUsages, recallOrders] = await Promise.all([
    db.bodies.count(),
    db.coats.count(),
    db.rooms.count(),
    db.polishes.count(),
    db.inlays.count(),
    db.inspects.count(),
    db.paintBatches.count(),
    db.paintUsages.count(),
    db.recallOrders.count(),
  ]);
  return { bodies, coats, rooms, polishes, inlays, inspects, paintBatches, paintUsages, recallOrders };
}

/* ------------------------------ 级联删除 ------------------------------ */

export async function removeBodyCascade(bodyId: string): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    // 任一关联下游记录已被召回冻结时，整条胎体禁止删除（冻结记录必须保留原值）
    const frozenRelations =
      (await db.coats.where('bodyId').equals(bodyId).filter((row) => row.frozen).count()) +
      (await db.polishes.where('bodyId').equals(bodyId).filter((row) => row.frozen).count()) +
      (await db.inlays.where('bodyId').equals(bodyId).filter((row) => row.frozen).count()) +
      (await db.inspects.where('bodyId').equals(bodyId).filter((row) => row.frozen).count());
    if (frozenRelations > 0) {
      throw new Error('该胎体存在已召回冻结的下游记录，禁止删除');
    }
    await db.coats.where('bodyId').equals(bodyId).delete();
    await db.rooms.where('bodyId').equals(bodyId).delete();
    await db.polishes.where('bodyId').equals(bodyId).delete();
    await db.inlays.where('bodyId').equals(bodyId).delete();
    await db.inspects.where('bodyId').equals(bodyId).delete();
    // 领用流水属于漆料台账对账凭证，删除胎体后保留（批次号已快照），仅断开关联
    await db.bodies.delete(bodyId);
  });
}
