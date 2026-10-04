/* 验证旧库 v1/v2 数据升级到 v3：历史道次回填「未追溯」，新表自动建立 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { DB_NAME, DB_SCHEMA_VERSION, db } from '@/utils/db';
import { UNTRACED_BATCH_ID } from '@/types/paint';

async function main(): Promise<void> {
  // 直接按 v2 结构灌入一条没有 paintBatchId 的旧道次
  const legacy = new Dexie(DB_NAME);
  legacy.version(2).stores({
    bodies: 'id, code, material, shape, state, updatedAt',
    coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
    rooms: 'id, bodyId, date, verdict, updatedAt',
    polishes: 'id, bodyId, seq, method, updatedAt',
    inlays: 'id, bodyId, type, position, updatedAt',
    inspects: 'id, bodyId, verdict, date, updatedAt',
  });
  await legacy.open();
  await legacy.table('bodies').put({
    id: 'old_body', code: 'OLD-1', material: 'wood', shape: 'bowl', sizeMm: 100,
    ownerName: '', state: 'coating', createdAt: 1, updatedAt: 1,
  });
  await legacy.table('coats').put({
    id: 'old_coat', bodyId: 'old_body', seq: 1, paintType: 'raw', colorName: '漆黑',
    coatDate: '2026-01-01', thicknessUm: 40, state: 'done', needRecheck: false,
    createdAt: 1, updatedAt: 1,
  });
  await legacy.close();

  // 用应用的最新 db 重新打开，触发 upgrade
  await db.open();
  const ver = db.verno;
  const coat = await db.coats.get('old_coat');
  const body = await db.bodies.get('old_body');
  const batchCount = await db.paintBatches.count();
  const recallCount = await db.paintRecalls.count();

  const ok =
    ver === DB_SCHEMA_VERSION &&
    coat?.paintBatchId === UNTRACED_BATCH_ID &&
    body?.id === 'old_body' &&
    batchCount === 0 &&
    recallCount === 0;

  console.log(`schema=${ver} coat.paintBatchId=${coat?.paintBatchId} batches=${batchCount} recalls=${recallCount}`);
  console.log(ok ? '✓ v2→v3 升级成功，历史道次回填未追溯' : '✗ 升级失败');
  await db.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
