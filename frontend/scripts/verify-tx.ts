/* eslint-disable */
// 极端路径验证：① 冻结事务中途注入失败 → 全部下游无半套标记、召回单 failed 可重试；
// ② 两个「标签页」并发领用同一批次 → 串行化后只有成功/失败两种结果，不会超额。
import 'fake-indexeddb/auto';
import { db, resetDatabase } from '@/utils/db';
import { buildRecallPreview, registerRecallNotice } from '@/utils/paintService';

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

  console.log('A) 冻结中途失败：无半套标记 + 可重试成功');
  const order = await registerRecallNotice({
    noticeNo: 'TB-FAIL',
    batchId: 'pb_raw_01',
    reason: '注入失败演练',
    noticeDate: '2026-10-04',
  });

  // 步骤 1：置 freezing（与 confirmRecall 的崩溃锚点一致）
  await db.recallOrders.update(order.id, { status: 'freezing', confirmed: true });

  // 步骤 2：大事务在「镶嵌」打标后、质检前人为抛错 → 整个事务必须回滚
  let rollbackError: unknown = null;
  try {
    await db.transaction(
      'rw',
      [db.bodies, db.coats, db.polishes, db.inlays, db.inspects, db.recallOrders],
      async () => {
        await db.bodies.where('id').anyOf(order.targets.bodyIds).modify({ frozen: true });
        await db.coats.where('id').anyOf(order.targets.coatIds).modify({ frozen: true });
        await db.polishes.where('id').anyOf(order.targets.polishIds).modify({ frozen: true });
        await db.inlays.where('id').anyOf(order.targets.inlayIds).modify({ frozen: true });
        throw new Error('注入：质检冻结前断电');
      },
    );
  } catch (error) {
    rollbackError = error;
  }
  assert(rollbackError instanceof Error, '大事务抛错');
  const frozenDuringFailure = [
    ...(await db.bodies.toArray()),
    ...(await db.coats.toArray()),
    ...(await db.polishes.toArray()),
    ...(await db.inlays.toArray()),
    ...(await db.inspects.toArray()),
  ].filter((row) => row.frozen);
  assert(frozenDuringFailure.length === 0, `事务回滚后无任何冻结标记（实际 ${frozenDuringFailure.length}）`);

  // 召回单按失败落库（模拟 confirmRecall 步骤 3），随后重启续处理成功
  await db.recallOrders.update(order.id, { status: 'failed', errorNote: '注入失败' });
  const { resumePendingRecalls } = await import('@/utils/paintService');
  const resume = await resumePendingRecalls();
  assert(resume.resumed.length === 1, '失败单续处理成功');
  const frozenAfter = [
    ...(await db.bodies.toArray()),
    ...(await db.coats.toArray()),
    ...(await db.polishes.toArray()),
    ...(await db.inlays.toArray()),
    ...(await db.inspects.toArray()),
  ].filter((row) => row.frozen);
  const expectedTotal =
    order.targets.bodyIds.length +
    order.targets.coatIds.length +
    order.targets.polishIds.length +
    order.targets.inlayIds.length +
    order.targets.inspectIds.length;
  assert(frozenAfter.length === expectedTotal, `续处理后恰好冻结 ${expectedTotal} 条（实际 ${frozenAfter.length}）`);
  assert((await db.recallOrders.get(order.id))!.status === 'done', '召回单最终已冻结');

  console.log('B) 并发领用：两个标签页同时扣减，不会扣成负数');
  await resetDatabase();
  const batch = (await db.paintBatches.get('pb_color_01'))!;
  const { registerPaintUsage } = await import('@/utils/paintService');
  const mkDraft = (qty: number) => ({
    batchId: 'pb_color_01',
    process: 'coat' as const,
    bodyId: 'body_01',
    coatId: 'coat_0102',
    inlayId: null,
    qty,
    operator: '并发',
    usageDate: '2026-10-04',
    note: '',
  });
  // 余量 1420：两笔各 1400，恰好只能成功一笔
  const results = await Promise.allSettled([
    registerPaintUsage(mkDraft(1400)),
    registerPaintUsage(mkDraft(1400)),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  assert(fulfilled === 1 && rejected === 1, `并发两笔：成功 ${fulfilled} / 失败 ${rejected}`);
  const finalBatch = await db.paintBatches.get('pb_color_01');
  assert(finalBatch!.remainingQty === 20, `余量 = 1420 − 1400 = 20（实际 ${finalBatch!.remainingQty}），无超额`);
  const usages = await db.paintUsages.where('batchId').equals('pb_color_01').toArray();
  assert(usages.length === 2, `流水含原 1 笔 + 成功 1 笔 = 2（实际 ${usages.length}），失败笔未落库`);

  // 多笔小额并发：总量不超额
  await resetDatabase();
  const small = await Promise.allSettled(
    Array.from({ length: 30 }, (_, i) =>
      registerPaintUsage({
        batchId: 'pb_raw_01',
        process: 'coat',
        bodyId: i % 2 === 0 ? 'body_01' : 'body_02',
        coatId: i % 2 === 0 ? 'coat_0101' : 'coat_0201',
        inlayId: null,
        qty: 100,
        operator: '并发',
        usageDate: '2026-10-04',
        note: '',
      }),
    ),
  );
  const ok = small.filter((r) => r.status === 'fulfilled').length;
  const rawBatch = await db.paintBatches.get('pb_raw_01');
  assert(rawBatch!.remainingQty === 1565 - ok * 100, `30 笔并发成功 ${ok} 笔，余量与成功笔数严格一致（${rawBatch!.remainingQty}）`);
  assert(rawBatch!.remainingQty >= 0, '余量非负');

  await db.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
