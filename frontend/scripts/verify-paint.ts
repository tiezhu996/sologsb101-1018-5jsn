/* eslint-disable */
// 运行时逻辑验证（不随构建发布）：用 fake-indexeddb 在 Node 中跑真实 Dexie 事务
import 'fake-indexeddb/auto';
import { db, resetDatabase } from '@/utils/db';
import {
  confirmRecall,
  buildRecallPreview,
  reconcileBatches,
  registerPaintUsage,
  registerRecallNotice,
  resumePendingRecalls,
  PaintServiceError,
} from '@/utils/paintService';

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function main(): Promise<void> {
  await resetDatabase();

  console.log('1) 对账：播种数据账实相符');
  const rows = await reconcileBatches();
  assert(rows.length === 4, `共 4 个批次（实际 ${rows.length}）`);
  assert(rows.every((r) => r.balanced), '全部批次 台账余量 = 入库 − 髹涂 − 镶嵌');
  const raw = rows.find((r) => r.batch.id === 'pb_raw_01')!;
  assert(raw.coatUsed === 360, `生漆髹涂领用合计 360（实际 ${raw.coatUsed}）`);
  assert(raw.inlayUsed === 75, `生漆镶嵌领用合计 75（实际 ${raw.inlayUsed}）`);
  assert(raw.expectedRemaining === 1565 && raw.batch.remainingQty === 1565, '生漆余量 1565');

  console.log('2) 领用扣减：成功时余量与流水一致');
  const before = (await db.paintBatches.get('pb_color_01'))!.remainingQty;
  await registerPaintUsage({
    batchId: 'pb_color_01',
    process: 'coat',
    bodyId: 'body_01',
    coatId: 'coat_0102',
    inlayId: null,
    qty: 20,
    operator: '测试',
    usageDate: '2026-03-20',
    note: '',
  });
  const after = (await db.paintBatches.get('pb_color_01'))!;
  assert(after.remainingQty === before - 20, `余量 ${before} → ${after.remainingQty}`);
  const usageCount = await db.paintUsages.where('batchId').equals('pb_color_01').count();
  assert(usageCount === 2, `流水增加为 2 条（实际 ${usageCount}）`);

  console.log('3) 超量扣减：事务整体回滚，余量与流水都不变');
  const before2 = after.remainingQty;
  const countBefore = await db.paintUsages.count();
  let thrown: unknown = null;
  try {
    await registerPaintUsage({
      batchId: 'pb_color_01',
      process: 'coat',
      bodyId: 'body_01',
      coatId: 'coat_0102',
      inlayId: null,
      qty: before2 + 99999,
      operator: '测试',
      usageDate: '2026-03-21',
      note: '',
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof PaintServiceError && thrown.code === 'INSUFFICIENT_STOCK', '抛出 INSUFFICIENT_STOCK');
  const after2 = await db.paintBatches.get('pb_color_01');
  assert(after2!.remainingQty === before2, `余量未变（${after2!.remainingQty}）`);
  assert((await db.paintUsages.count()) === countBefore, '流水未新增');

  console.log('4) 旧数据未追溯 + 未追溯批次禁止登记新领用');
  const coat0202 = await db.coats.get('coat_0202');
  assert(coat0202!.batchId === 'untraced', 'coat_0202 标记为未追溯');
  let untracedError: unknown = null;
  try {
    await registerPaintUsage({
      batchId: 'untraced',
      process: 'coat',
      bodyId: 'body_02',
      coatId: 'coat_0202',
      inlayId: null,
      qty: 1,
      operator: '',
      usageDate: '2026-03-21',
      note: '',
    });
  } catch (error) {
    untracedError = error;
  }
  assert(untracedError instanceof PaintServiceError, '未追溯批次不能登记新领用');

  console.log('5) 召回预览：追溯胎体/道次/打磨/镶嵌/质检（不含荫房）');
  const preview = await buildRecallPreview('pb_raw_01');
  assert(preview.bodyIds.sort().join() === ['body_01', 'body_02', 'body_03'].sort().join(), `涉及胎体 ${preview.bodyIds.length} 件`);
  assert(preview.coatIds.length === 3, `道次 3（实际 ${preview.coatIds.length}）`);
  assert(preview.inlayIds.length === 2, `镶嵌 2（实际 ${preview.inlayIds.length}）`);
  // 打磨：与 raw 道次同胎体同序号 → polish_0101(seq1,b1) polish_0201(seq1,b2) polish_0301 属于 seq3/topcoat 不算
  assert(preview.polishIds.length === 2, `打磨 2（实际 ${preview.polishIds.length}）`);
  // 质检：body_02(rework) 受影响；body_03 的 raw 道次也存在 → body_03 也涉及
  assert(preview.inspectIds.length === 2, `质检 2（实际 ${preview.inspectIds.length}）`);

  console.log('6) 登记通报：批次停用 + 唯一召回单（同一通报重复登记失败回滚）');
  const order = await registerRecallNotice({
    noticeNo: 'TB-001',
    batchId: 'pb_raw_01',
    reason: '抽检重金属超标',
    noticeDate: '2026-10-04',
  });
  assert(order.status === 'pending' && !order.confirmed, '召回单初始为待确认冻结');
  assert((await db.paintBatches.get('pb_raw_01'))!.status === 'inactive', '批次已停用');
  let dupError: unknown = null;
  try {
    await registerRecallNotice({
      noticeNo: 'TB-001',
      batchId: 'pb_color_01',
      reason: '重复通报',
      noticeDate: '2026-10-04',
    });
  } catch (error) {
    dupError = error;
  }
  assert(dupError instanceof PaintServiceError && dupError.code === 'NOTICE_DUPLICATE', '同一通报只生成一份召回单');
  // 重复登记回滚：color_01 不应被停用
  assert((await db.paintBatches.get('pb_color_01'))!.status === 'active', '重复通报事务回滚，color_01 仍在用');

  console.log('7) 停用批次禁止领用');
  let inactiveError: unknown = null;
  try {
    await registerPaintUsage({
      batchId: 'pb_raw_01',
      process: 'coat',
      bodyId: 'body_01',
      coatId: 'coat_0101',
      inlayId: null,
      qty: 1,
      operator: '',
      usageDate: '2026-10-05',
      note: '',
    });
  } catch (error) {
    inactiveError = error;
  }
  assert(inactiveError instanceof PaintServiceError, '停用批次不能再领用');

  console.log('8) 确认冻结：原子打标且原值保留');
  const coat0101Before = await db.coats.get('coat_0101');
  const done = await confirmRecall(order.id);
  assert(done.status === 'done' && done.frozenAt !== null, '召回单状态为已冻结');
  const frozenCoat = await db.coats.get('coat_0101');
  assert(frozenCoat!.frozen === true && frozenCoat!.frozenByRecallId === order.id, '道次冻结标记完整');
  assert(
    frozenCoat!.colorName === coat0101Before!.colorName &&
      frozenCoat!.thicknessUm === coat0101Before!.thicknessUm &&
      frozenCoat!.seq === coat0101Before!.seq &&
      frozenCoat!.state === coat0101Before!.state,
    '冻结后业务原值保留',
  );
  const frozenBodies = await db.bodies.where('frozen').equals(1 as never).count();
  const realFrozenBodies = (await db.bodies.toArray()).filter((b) => b.frozen).length;
  assert(realFrozenBodies === 3, `3 件胎体冻结（实际 ${realFrozenBodies}，查询尝试 ${frozenBodies}）`);
  assert((await db.rooms.toArray()).every((r) => (r as { frozen?: unknown }).frozen === undefined), '荫房记录不冻结');

  console.log('9) 冻结后禁止改冻结记录（store 层）');
  const { useCoatStore } = await import('@/stores/coatStore');
  let storeError: unknown = null;
  try {
    await useCoatStore.getState().updateCoat('coat_0101', { colorName: '篡改' });
  } catch (error) {
    storeError = error;
  }
  assert(storeError instanceof Error, '冻结道次更新被拒绝');
  assert((await db.coats.get('coat_0101'))!.colorName === '漆黑', '被拒绝后原值仍在');

  console.log('10) 重启续处理：freezing/failed 状态自动继续');
  // 构造一份冻结中的召回单（模拟确认后、大事务提交前崩溃）
  const order2 = await registerRecallNotice({
    noticeNo: 'TB-002',
    batchId: 'pb_top_01',
    reason: '罩漆批次溶剂超标',
    noticeDate: '2026-10-04',
  });
  await db.recallOrders.update(order2.id, { status: 'freezing', confirmed: true });
  const resume = await resumePendingRecalls();
  assert(resume.resumed.length === 1, `续处理 1 份召回单（实际 ${resume.resumed.length}）`);
  assert((await db.recallOrders.get(order2.id))!.status === 'done', '重启后冻结完成');
  const topCoat = await db.coats.get('coat_0303');
  assert(topCoat!.frozen === true, '罩漆道次在续处理中被冻结');
  // 未确认的 pending 不自动冻结
  await registerRecallNotice({
    noticeNo: 'TB-003',
    batchId: 'pb_color_02',
    reason: '待人工确认',
    noticeDate: '2026-10-04',
  });
  const resume2 = await resumePendingRecalls();
  assert(resume2.resumed.length === 0 && resume2.failed.length === 0, '未确认召回单不自动冻结');
  const color02 = await db.coats.get('coat_0302');
  assert(color02!.frozen === false, '待确认批次下游仍未冻结');

  console.log('11) 整库导出/导入往返：新表随快照保存，旧快照缺字段可归一化');
  const { exportSnapshot, normalizeSnapshot } = await import('@/utils/db');
  const snapshot = await exportSnapshot();
  assert(snapshot.paintBatches.length === 4 && snapshot.recallOrders.length === 3, '快照包含漆料三表');
  const legacy = {
    app: 'gblacquer',
    bodies: [{ id: 'bx', code: 'X', material: 'wood', shape: 'bowl', sizeMm: 1, ownerName: '', state: 'pending', createdAt: 1, updatedAt: 1 }],
    coats: [
      { id: 'cx', bodyId: 'bx', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-01-01', thicknessUm: 40, state: 'todo', needRecheck: false, createdAt: 1, updatedAt: 1 },
    ],
    rooms: [],
    polishes: [],
    inlays: [],
    inspects: [],
  };
  const normalized = normalizeSnapshot(legacy as never);
  assert(
    normalized.bodies[0]!.frozen === false && normalized.coats[0]!.batchId === 'untraced',
    '旧快照归一化：冻结字段补 false、漆料批次补「未追溯」',
  );
  assert(Array.isArray(normalized.recallOrders) && normalized.recallOrders.length === 0, '旧快照缺召回表时补空集合');

  await db.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
